import type { NativeCandidate, NativeSelection } from './contracts.js';
import { parseSdkIdentity } from './contracts.js';
import { parseNativeDiscoveryReport, parseNativeModeReport, parseNativeMappingProof, assertQualifiedNativeMode } from './evidence.js';
import { array, digest, exact, integer, NativeInputError, record, semanticDigest, textValue } from './json.js';
import { parseNativeParentPermissionProof } from './permission-contracts.js';
import { NATIVE_QUALIFICATION_BUDGETS as B } from './host-contracts.js';

function finiteTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 3_600_000) throw new NativeInputError('evidence_time_invalid');
  return value;
}

function executableEvidence(value: unknown, candidate: NativeCandidate, launch: 'direct' | 'registry'): void {
  const input = record(value, ['mode', 'identity', 'allocationId'], ['registry']);
  exact(input.mode, launch);
  textValue(input.allocationId, 200);
  const identity = record(input.identity, ['bytes', 'sha256']);
  exact(identity.bytes, candidate.native.bytes); exact(identity.sha256, candidate.native.sha256);
  if (launch === 'registry') {
    const installed = record(input.registry, ['snapshotDigest', 'planDigest', 'installationId', 'receiptDigest', 'referenceId', 'ownerId', 'reopenedFromFreshProcess']);
    for (const key of ['snapshotDigest', 'planDigest', 'receiptDigest']) digest(installed[key]);
    for (const key of ['installationId', 'referenceId', 'ownerId']) textValue(installed[key], 200);
    exact(installed.reopenedFromFreshProcess, true);
  } else if (input.registry !== undefined) throw new NativeInputError('registry_evidence_unexpected');
}

function processEvidence(value: unknown, launch: 'direct' | 'registry', qualified: boolean): number | undefined {
  const input = record(value, ['format', 'composition', 'launcherProcessId', 'freshProcessReopened'], ['installer', 'run']);
  exact(input.format, 'native-process-ownership-v1');
  exact(input.composition, launch === 'direct' ? 'direct-local' : 'registry-fresh-process');
  const launcher = integer(input.launcherProcessId, 1, Number.MAX_SAFE_INTEGER);
  if (typeof input.freshProcessReopened !== 'boolean') throw new NativeInputError('process_evidence_invalid');
  const observation = (value: unknown) => {
    const item = record(value, ['processId', 'spawnedAt'], ['readyAt', 'settledAt', 'exitedAt', 'exitCode']);
    integer(item.processId, 1, Number.MAX_SAFE_INTEGER);
    let previous = finiteTime(item.spawnedAt);
    for (const key of ['readyAt', 'settledAt', 'exitedAt']) if (item[key] !== undefined) {
      const time = finiteTime(item[key]);
      if (time < previous) throw new NativeInputError('process_evidence_invalid');
      previous = time;
    }
    if (item.exitCode !== undefined && item.exitCode !== null) integer(item.exitCode, 0, 255);
    if ((item.exitedAt !== undefined) !== (item.exitCode !== undefined)) throw new NativeInputError('process_evidence_invalid');
    return item;
  };
  const run = input.run === undefined ? undefined : observation(input.run);
  if (launch === 'direct') {
    exact(input.freshProcessReopened, false);
    if (!run || input.installer !== undefined || run.exitedAt !== undefined) throw new NativeInputError('process_evidence_invalid');
    exact(run.processId, launcher);
    finiteTime(run.readyAt); finiteTime(run.settledAt);
    return qualified ? finiteTime(run.settledAt) : undefined;
  }
  const installer = observation(input.installer);
  if (installer.processId === launcher || run && (run.processId === launcher || run.processId === installer.processId)) {
    throw new NativeInputError('process_evidence_invalid');
  }
  if (run) {
    exact(installer.exitCode, 0);
    finiteTime(installer.readyAt); finiteTime(installer.settledAt);
    if (finiteTime(installer.exitedAt) > finiteTime(run.spawnedAt)) throw new NativeInputError('process_reopen_order_invalid');
  }
  if (input.freshProcessReopened && (!run || run.readyAt === undefined)) throw new NativeInputError('process_reopen_order_invalid');
  if (qualified) {
    exact(input.freshProcessReopened, true);
    if (!run) throw new NativeInputError('process_evidence_invalid');
    exact(run.exitCode, 0);
    const ready = finiteTime(run.readyAt); const settled = finiteTime(run.settledAt); const exited = finiteTime(run.exitedAt);
    if (finiteTime(run.spawnedAt) > ready || ready > settled || settled > exited) throw new NativeInputError('process_close_order_invalid');
    return settled;
  }
  return undefined;
}

export function parseNativeEnvelope(value: unknown, candidate: NativeCandidate, candidateFileDigest: string,
  kind: 'discovery' | 'execution') {
  const input = record(value, ['format', 'kind', 'runId', 'startedAt', 'endedAt', 'launch', 'candidateFileDigest', 'candidateDigest',
    'sdk', 'runnerDigest', 'credentialMechanism', 'operation', 'evidenceDigest'],
  kind === 'execution' ? ['discoveryFileDigest', 'discoveryDigest', 'selectionFileDigest', 'selectionDigest'] : []);
  exact(input.format, 'agenai-native-qualification-v1'); exact(input.kind, kind);
  textValue(input.runId, 200);
  for (const key of ['startedAt', 'endedAt']) if (!/^\d{4}-\d\d-\d\dT/u.test(textValue(input[key], 64)) || !Number.isFinite(Date.parse(input[key] as string))) {
    throw new NativeInputError('evidence_date_invalid');
  }
  if (Date.parse(input.endedAt as string) < Date.parse(input.startedAt as string)) throw new NativeInputError('evidence_date_invalid');
  const launch = input.launch === 'direct' ? 'direct' : exact(input.launch, 'registry');
  exact(digest(input.candidateFileDigest), candidateFileDigest);
  exact(digest(input.candidateDigest), semanticDigest(candidate));
  exact(semanticDigest(parseSdkIdentity(input.sdk)), semanticDigest(candidate.sdk));
  exact(digest(input.runnerDigest), candidate.runnerDigest);
  exact(input.credentialMechanism, 'explicit_api_key_environment');
  const { evidenceDigest: expected, ...body } = input;
  if (digest(expected) !== semanticDigest(body)) throw new NativeInputError('evidence_digest_mismatch');
  const operation = record(input.operation, ['report', 'allocations', 'cleanup'], ['executable', 'processProof']);
  const cleanup = operation.cleanup === 'closed' ? 'closed' : exact(operation.cleanup, 'pending');
  if (operation.executable !== undefined) executableEvidence(operation.executable, candidate, launch);
  const allocationIds = new Set<string>();
  array(operation.allocations, 4, (value) => {
    const allocation = record(value, ['allocationId', 'role', 'environmentKeys']);
    const id = textValue(allocation.allocationId, 200);
    if (allocationIds.has(id)) throw new NativeInputError('allocation_identity_reused');
    allocationIds.add(id);
    if (!['discovery', 'parent', 'child', 'comparison'].includes(textValue(allocation.role, 32))) throw new NativeInputError('allocation_role_invalid');
    const keys = array(allocation.environmentKeys, 64, (key) => textValue(key, 100));
    if (new Set(keys).size !== keys.length || keys.some((key) => !/^[A-Z_]+$/u.test(key))) throw new NativeInputError('environment_evidence_invalid');
    return allocation;
  });
  const report = kind === 'discovery' ? parseNativeDiscoveryReport(operation.report) : parseNativeModeReport(operation.report);
  if (operation.processProof !== undefined) {
    const elapsed = processEvidence(operation.processProof, launch, report.outcome === 'qualified');
    if (elapsed !== undefined && (elapsed - report.cleanup.elapsedMs > B.modeMs || elapsed > B.modeMs + B.cleanupMs)) {
      throw new NativeInputError('budget_exhausted');
    }
  }
  else if (!['blocked', 'cleanup_pending'].includes(report.outcome) || allocationIds.size || operation.executable !== undefined
    || report.configurationStarts !== 0 || ('usage' in report && report.usage.turns !== 0)) throw new NativeInputError('process_evidence_missing');
  if (report.outcome === 'qualified' && (cleanup !== 'closed' || operation.executable === undefined)) throw new NativeInputError('qualification_cleanup_missing');
  if (report.outcome === 'qualified') {
    const roles = (operation.allocations as { role: string }[]).map((allocation) => allocation.role).sort();
    if (semanticDigest(roles) !== semanticDigest(kind === 'discovery' ? ['discovery'] : ['child', 'comparison', 'parent'])) {
      throw new NativeInputError('allocation_roles_missing');
    }
  }
  for (const key of ['discoveryFileDigest', 'discoveryDigest', 'selectionFileDigest', 'selectionDigest']) {
    if (kind === 'execution') digest(input[key]);
  }
  return { input, launch, report, operation };
}

export function assertNativeSelection(candidate: NativeCandidate, selection: NativeSelection,
  discovery: ReturnType<typeof parseNativeEnvelope>): void {
  exact(selection.candidateDigest, semanticDigest(candidate));
  exact(selection.discoveryDigest, semanticDigest(discovery.input));
  exact(selection.sdkDigest, semanticDigest(candidate.sdk));
  exact(selection.nativeSha256, candidate.native.sha256);
  const report = parseNativeDiscoveryReport(discovery.operation.report);
  if (report.outcome !== 'qualified' || !report.configuration) throw new NativeInputError('discovery_not_qualified');
  exact(semanticDigest(selection.configuration), semanticDigest(report.configuration));
  const proof = parseNativeMappingProof(selection.mappingProof);
  exact(proof.native.sha256, candidate.native.sha256); exact(proof.native.bytes, candidate.native.bytes);
  // Revision counters belong to each observed session; canonical field/option identities bind the mapping across sessions.
  const choices = (items: typeof proof.selections) => items.map(({ key, value }) => ({ key, value }));
  exact(semanticDigest(choices(proof.selections)), semanticDigest(choices([selection.configuration.model, selection.configuration.reasoningSelection])));
  exact(selection.mapping.modelId, selection.configuration.modelId);
  exact(selection.mapping.reasoning, selection.configuration.reasoning);
  exact(selection.mapping.proofDigest, semanticDigest(proof));
  if (selection.parentPermissionProof) {
    const permission = parseNativeParentPermissionProof(selection.parentPermissionProof);
    exact(permission.executableSha256, candidate.native.sha256);
    exact(permission.executableBytes, candidate.native.bytes);
    exact(permission.sdkDigest, semanticDigest(candidate.sdk));
  }
}

export function assertNativeExecution(candidate: NativeCandidate, selection: NativeSelection,
  discovery: ReturnType<typeof parseNativeEnvelope>, evidence: ReturnType<typeof parseNativeEnvelope>,
  hashes: { readonly discovery: string; readonly selection: string }): void {
  assertNativeSelection(candidate, selection, discovery);
  exact(evidence.launch, discovery.launch);
  exact(evidence.input.discoveryFileDigest, hashes.discovery);
  exact(evidence.input.discoveryDigest, semanticDigest(discovery.input));
  exact(evidence.input.selectionFileDigest, hashes.selection);
  exact(evidence.input.selectionDigest, semanticDigest(selection));
  const report = parseNativeModeReport(evidence.operation.report);
  assertQualifiedNativeMode(report);
  if (selection.parentPermissionProof) exact(report.parentPermissionProofDigest, semanticDigest(selection.parentPermissionProof));
  else if (report.parentPermissionProofDigest !== undefined || report.approvals?.length) throw new NativeInputError('permission_proof_unselected');
  exact(semanticDigest(report.parentConfiguration), semanticDigest(selection.configuration.afterReasoning));
  for (const admission of report.admissions) {
    exact(admission.target.sourceId, selection.mapping.mappingId);
    exact(admission.target.sourceRevision, selection.mapping.mappingRevision);
  }
}
