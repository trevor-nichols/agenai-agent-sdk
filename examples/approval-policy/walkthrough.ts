import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionId, parseAgentTurnId,
  type AgentApprovalRequest, type AgentApprovalResolution,
} from '@agen-ai/agent-protocol';
import {
  AgentProviderContractError, createAgentProviderRegistry,
  type AgentApprovalPolicyKind, type AgentProviderRegistry, type AgentProviderSession,
} from '@agen-ai/agent-runtime';
import { createGenericAcpFixture, createSyntheticApprovalFixture } from './fixture.js';

// This exact choice is for the owned teaching action only. A real host supplies its own user/policy decision.
export function selectFixtureOnce(request: AgentApprovalRequest, decision: 'approved' | 'denied'): AgentApprovalResolution {
  const optionId = decision === 'approved' ? 'approval:allow-once' : 'approval:deny-once';
  const matches = request.options.filter((option) => option.optionId === optionId && option.decision === decision
    && option.consequence.kind === 'scoped' && option.consequence.persistence === 'once'
    && option.consequence.scope.kind === 'exact_action');
  const option = matches[0];
  if (matches.length !== 1 || !option) throw new Error('The exact once-only fixture option was not offered.');
  return { requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: option.optionId };
}

async function readMarker(markerPath: string): Promise<string | null> {
  try { return await readFile(markerPath, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}

async function closeOriginalOwners(session: AgentProviderSession | undefined, registry: AgentProviderRegistry): Promise<void> {
  const failures: unknown[] = [];
  try { await session?.close({ reason: 'shutdown' }); }
  catch (error) { failures.push(error); }
  try { await registry.dispose(); }
  catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'The original session and registry cleanup both failed.');
}

const configuration = { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('approval-policy:configuration') };

async function runSyntheticScenario(root: string, name: string, requested: AgentApprovalPolicyKind | null, decision: 'approved' | 'denied') {
  const workingDirectory = join(root, name);
  await mkdir(workingDirectory, { mode: 0o700 });
  const markerPath = join(workingDirectory, 'marker.txt');
  const fixture = createSyntheticApprovalFixture(markerPath, `bounded-marker:${name}\n`);
  const registry = await createAgentProviderRegistry({ drivers: [fixture.driver], definitions: [fixture.definition] });
  const adapter = registry.requireInstance(fixture.definition.instanceId).adapter;
  let session: AgentProviderSession | undefined;
  let resolution: { optionId: string; decision: 'approved' | 'denied'; receipt: 'delivered' } | undefined;
  let terminal = false;
  try {
    session = await adapter.createSession({ sessionId: parseAgentSessionId(`approval-policy:${name}`),
      workingDirectory, configuration, onBindingCreated() {}, signal: AbortSignal.timeout(5_000),
      ...(requested === null ? {} : { approvalPolicy: { kind: requested } }),
    });
    const execution = session.startTurn({ turnId: parseAgentTurnId(`approval-policy:${name}:turn`), interactionMode: 'default',
      parts: [{ type: 'text', text: 'Request the one owned teaching marker effect.' }], signal: AbortSignal.timeout(5_000) });
    // One reader owns the full turn, including genuine residual requests under auto-review and bypass.
    for await (const output of execution.outputs) {
      if (output.kind !== 'event') continue;
      if (output.event.type === 'request.opened') {
        const request = output.event.payload.request;
        if (request.requestKind !== 'approval' || resolution) throw new Error('Expected exactly one residual fixture approval.');
        const answer = selectFixtureOnce(request, decision);
        const receipt = await execution.resolveRequest({ resolution: answer });
        if (receipt.status !== 'delivered') throw new Error(`The answer was ${receipt.status}; do not replay it.`);
        if (answer.disposition !== 'selected') throw new Error('The fixture answer must select an offered option.');
        resolution = { optionId: answer.optionId, decision, receipt: receipt.status };
      }
      if (output.event.type === 'turn.completed') {
        if (output.event.payload.outcome !== 'completed') throw new Error('The original teaching turn did not complete.');
        terminal = true;
      }
    }
    if (!terminal || !resolution) throw new Error('The original reader ended before its answer and completion.');
  } finally {
    await closeOriginalOwners(session, registry);
  }
  // Read actual bytes after the provider has closed. A delivered answer alone proves no filesystem effect.
  const marker = await readMarker(markerPath);
  const expected = decision === 'approved' ? `bounded-marker:${name}\n` : null;
  if (marker !== expected) throw new Error('The independently observed marker contradicts the teaching decision.');
  const observation = fixture.observe();
  return { name, requested, effective: session?.approvalPolicy ?? null, support: adapter.approvalPolicy,
    resolution, marker: marker === null ? null : { path: `${name}/marker.txt`, contents: marker },
    dispatch: { sessions: observation.sessions, turns: observation.turns, outputReaders: observation.outputReaders },
    cleanup: { sessionsClosed: observation.sessionsClosed, instancesDisposed: observation.instancesDisposed } };
}

async function runGenericAcpControl(root: string) {
  const workingDirectory = join(root, 'generic-acp');
  await mkdir(workingDirectory, { mode: 0o700 });
  const markerPath = join(workingDirectory, 'marker.txt');
  const fixture = createGenericAcpFixture(markerPath);
  const instanceId = parseAgentInstanceId('approval-policy:generic-acp');
  const registry = await createAgentProviderRegistry({ drivers: [fixture.driver], definitions: [{
    providerKey: fixture.driver.providerKey, instanceId, driverConfiguration: {},
  }] });
  const adapter = registry.requireInstance(instanceId).adapter;
  const input = { sessionId: parseAgentSessionId('approval-policy:generic-acp:session'), workingDirectory, configuration,
    onBindingCreated() {}, signal: AbortSignal.timeout(5_000) };
  let session: AgentProviderSession | undefined;
  let rejection: string | undefined;
  let refusal: { sessionOpenings: number; prompts: number; marker: boolean };
  try {
    try { session = await adapter.createSession({ ...input, approvalPolicy: { kind: 'provider_auto_review' } }); }
    catch (error) {
      if (!(error instanceof AgentProviderContractError) || error.code !== 'approval_policy_unsupported') throw error;
      rejection = error.code;
    }
    const before = fixture.observe();
    const marker = await readMarker(markerPath);
    refusal = { sessionOpenings: before.sessionOpenings, prompts: before.prompts, marker: marker !== null };
    if (rejection !== 'approval_policy_unsupported' || before.sessionOpenings !== 0 || before.prompts !== 0 || marker !== null) {
      throw new Error('Generic ACP must reject explicit policy selection before opening effects.');
    }
    // Omission uses ordinary ACP behavior; no effective policy is invented from successful RPCs.
    session = await adapter.createSession(input);
    let terminal = false;
    for await (const output of session.startTurn({ turnId: parseAgentTurnId('approval-policy:generic-acp:turn'),
      interactionMode: 'default', parts: [{ type: 'text', text: 'Write the owned scripted ACP marker.' }], signal: AbortSignal.timeout(5_000) }).outputs) {
      if (output.kind === 'event' && output.event.type === 'turn.completed') {
        if (output.event.payload.outcome !== 'completed') throw new Error('The generic ACP positive control failed.');
        terminal = true;
      }
    }
    if (!terminal) throw new Error('Generic ACP ended without its terminal event.');
  } finally {
    await closeOriginalOwners(session, registry);
  }
  const marker = await readMarker(markerPath);
  if (marker !== 'generic-acp-omitted\n') throw new Error('The generic ACP positive-control marker is missing.');
  const after = fixture.observe();
  return { support: adapter.approvalPolicy ?? { kind: 'unsupported' as const }, requested: 'provider_auto_review' as const,
    rejection, refusal, omitted: { effective: session?.approvalPolicy ?? null,
      sessionOpenings: after.sessionOpenings, prompts: after.prompts, marker: { path: 'generic-acp/marker.txt', contents: marker } },
    cleanup: { connectionsReleased: after.connectionsReleased } };
}

export async function runApprovalPolicyWalkthrough(options: { artifactDirectory?: string } = {}) {
  const explicitDirectory = options.artifactDirectory;
  const temporary = explicitDirectory === undefined;
  const root = explicitDirectory === undefined ? await mkdtemp(join(tmpdir(), 'agent-sdk-approval-policy-')) : resolve(explicitDirectory);
  if (!temporary) await mkdir(root, { mode: 0o700 }); // Exclusive creation refuses reuse or overwriting another caller's files.
  try {
    const scenarios = [];
    scenarios.push(await runSyntheticScenario(root, 'omitted', null, 'approved'));
    for (const policy of ['host', 'provider_auto_review', 'provider_bypass'] as const) {
      scenarios.push(await runSyntheticScenario(root, policy, policy, 'approved'));
    }
    scenarios.push(await runSyntheticScenario(root, 'residual-denied', 'provider_auto_review', 'denied'));
    return { example: 'approval-policy' as const, evidence: 'synthetic_contract_demonstration' as const,
      nativeReview: 'not_exercised' as const, nativeProcesses: 0 as const,
      scenarios, genericAcp: await runGenericAcpControl(root) };
  } finally { if (temporary) await rm(root, { recursive: true, force: true }); }
}

export type ApprovalPolicyWalkthroughReport = Awaited<ReturnType<typeof runApprovalPolicyWalkthrough>>;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runApprovalPolicyWalkthrough()));
}
