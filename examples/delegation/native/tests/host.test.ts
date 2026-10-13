import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverNativeConfiguration, runNativeQualificationMode } from '../host.js';
import type { GrokConfigurationSelection } from '../grok.js';
import type { NativeDiscoveryResult, NativeModeResult } from '../host-contracts.js';
import type { NativeExecutableLease, NativeProcessAllocation, NativeRole } from '../launch-contracts.js';
import type { NativeParentPermissionPolicy } from '../permissions.js';
import { assertQualifiedNativeMode } from '../evidence.js';

interface NativeObservation {
  readonly pid: number;
  readonly role: NativeRole;
  readonly event: string;
  readonly configId?: string;
  readonly value?: string;
  readonly outcome?: string;
  readonly optionId?: string | null;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-host-lifecycle-'));
  const auditPath = join(root, 'native.jsonl');
  const identity = async () => {
    const bytes = await readFile(process.execPath);
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const nativeIdentity = await identity();
  const executable: NativeExecutableLease = { mode: 'direct', executable: process.execPath, identity: nativeIdentity,
    evidence: { mode: 'direct', identity: nativeIdentity, allocationId: randomUUID() },
    async assertUnchanged() { assert.deepEqual(await identity(), nativeIdentity); }, async release() {} };
  const observations = async (): Promise<readonly NativeObservation[]> => {
    try { return (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as NativeObservation); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  t.after(async () => {
    for (const pid of new Set((await observations()).map((entry) => entry.pid))) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  });
  const allocation = async (role: NativeRole, behavior = 'valid'): Promise<NativeProcessAllocation> => {
    const allocationId = randomUUID();
    const workingDirectory = join(root, allocationId);
    await mkdir(workingDirectory, { mode: 0o700 });
    const grokHome = join(workingDirectory, '.grok');
    await mkdir(grokHome, { mode: 0o700 });
    await writeFile(join(grokHome, 'config.toml'), '[fixture]\nloading = "isolated"\n', { mode: 0o600 });
    const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: workingDirectory,
      GROK_HOME: grokHome, XAI_API_KEY: 'synthetic-host-lifecycle-no-account-authority' };
    return { allocationId, role, workingDirectory, environmentKeys: Object.keys(env).sort(),
      launch: { executable: executable.executable, args: [fileURLToPath(new URL('./host-peer.mjs', import.meta.url)), auditPath, role, behavior],
        cwd: workingDirectory, env, shutdownTimeoutMs: 1_000 },
      async configurationFilesSnapshot() {
        const bytes = await readFile(join(grokHome, 'config.toml'));
        const path = join(workingDirectory, 'AGENTS.md');
        let kind: 'absent' | 'file' | 'directory';
        try { kind = (await lstat(path)).isDirectory() ? 'directory' : 'file'; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; kind = 'absent'; }
        return [{ location: 'GROK_HOME/config.toml', kind: 'file', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
          { location: 'cwd/AGENTS.md', kind }];
      }, async release() { await rm(workingDirectory, { recursive: true }); } };
  };
  const discover = async (): Promise<GrokConfigurationSelection> => {
    const result = await discoverNativeConfiguration({ executable, allocation: await allocation('discovery'),
      choice: { modelId: 'grok-4.3', reasoning: 'low' }, signal: AbortSignal.timeout(5_000) });
    await settled(result);
    assert.equal(result.report.outcome, 'qualified');
    assert.ok(result.report.configuration);
    return result.report.configuration;
  };
  const parentPermissionPolicy: NativeParentPermissionPolicy = { profile: 'grok-1.0.50-managed-mcp-once-v1',
    proofDigest: `sha256:${'a'.repeat(64)}`, executableSha256: nativeIdentity.sha256 };
  const execute = async (selection: GrokConfigurationSelection, behavior: string, authorize = false): Promise<NativeModeResult> => {
    const allocations = { parent: await allocation('parent', behavior), child: await allocation('child', behavior === 'managed-full' ? behavior : 'valid'), comparison: await allocation('comparison') };
    const result = await runNativeQualificationMode({ executable, allocations, selection, signal: AbortSignal.timeout(5_000),
      ...(authorize ? { parentPermissionPolicy } : {}),
      mapping: { mappingId: 'synthetic-host-lifecycle', mappingRevision: 1, modelId: 'grok-4.3', reasoning: 'low', executionMode: 'standard', proofDigest: 'synthetic-fixture-only' } });
    await settled(result);
    return result;
  };
  const assertQuiesced = async () => {
    const events = await observations();
    assert.ok(events.some((entry) => entry.event === 'started'));
    assert.equal(events.some((entry) => entry.event === 'fixture_failed'), false);
    for (const pid of new Set(events.map((entry) => entry.pid))) {
      assert.equal(events.filter((entry) => entry.pid === pid && entry.event === 'exited').length, 1);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  };
  return { executable, allocation, discover, execute, observations, assertQuiesced };
}

async function settled(result: NativeDiscoveryResult | NativeModeResult): Promise<void> {
  if (result.retryCleanup) await result.retryCleanup();
  assert.equal(result.report.cleanup.status, 'closed');
  assert.equal(result.report.cleanup.coordinatorClosed, true);
  assert.equal(result.report.cleanup.sessionsClosed, true);
  assert.equal(result.report.cleanup.registriesClosed, true);
  assert.equal(result.report.cleanup.bridgesAcquired, result.report.cleanup.bridgesReleased);
}

test('native discovery applies the observed Model then Low transition without prompting and closes the real ACP process', async (t) => {
  const f = await fixture(t);
  const result = await discoverNativeConfiguration({ executable: f.executable, allocation: await f.allocation('discovery'),
    choice: { modelId: 'grok-4.3', reasoning: 'low' }, signal: AbortSignal.timeout(5_000) });
  await settled(result);
  assert.equal(result.report.outcome, 'qualified');
  assert.equal(result.report.noPrompt, true);
  assert.equal(result.report.modelAcknowledged, true);
  assert.equal(result.report.reasoningAcknowledged, true);
  assert.equal(result.report.configurationStarts, 2);
  assert.deepEqual(result.report.configuration?.initial.fields.map((field) => field.label), ['Model']);
  assert.equal(result.report.configuration?.afterModel.fields.some((field) => field.label === 'Reasoning Effort'), true);
  const events = await f.observations();
  assert.deepEqual(events.filter((entry) => entry.event === 'configuration').map(({ configId, value }) => [configId, value]),
    [['model', 'grok-4.3'], ['reasoning', 'low']]);
  assert.equal(events.some((entry) => entry.event === 'prompt'), false);
  await f.assertQuiesced();
});

test('the pinned parent permission resumes one admission prompt and observes its actual scoped MCP callback before cleanup', async (t) => {
  const f = await fixture(t);
  const result = await f.execute(await f.discover(), 'managed-permission', true);
  assert.equal(result.report.reason, 'parent_did_not_delegate');
  assert.equal(result.report.usage.turns, 2);
  const admission = result.report.turns.find((turn) => turn.purpose === 'admission');
  assert.equal(admission?.outcome, 'completed');
  assert.ok(admission?.providerStartedAt !== undefined && admission.terminalAt !== undefined);
  assert.equal(result.report.tools.length, 1);
  assert.equal(result.report.tools[0]?.toolName, 'delegation_targets');
  assert.equal(result.report.tools[0]?.parentTurnId, admission?.turnId);
  assert.equal(result.report.version, 2);
  assert.ok(result.report.version === 2);
  const approval = result.report.approvals?.[0];
  assert.ok(approval);
  assert.equal(approval.parentTurnId, admission?.turnId);
  assert.equal(approval.invocationId, result.report.tools[0]?.invocationId);
  assert.equal(approval.selectedOptionId, approval.offeredOption.optionId);
  assert.ok(approval.deliveryStartedAt !== undefined && approval.deliverySettledAt !== undefined
    && approval.runningAt !== undefined && approval.nextBoundaryAt !== undefined);
  assert.ok(approval.openedAt <= approval.requestObservedAt && approval.requestObservedAt <= approval.deliveryStartedAt
    && approval.deliveryStartedAt <= approval.runningAt && approval.runningAt <= result.report.tools[0]!.at
    && result.report.tools[0]!.at <= approval.nextBoundaryAt && approval.deliverySettledAt <= approval.nextBoundaryAt);
  assert.equal(approval.deliveryStatus, 'delivered');
  assert.equal(approval.nextBoundary, 'completed');
  assert.equal(approval.nextBoundaryAt, admission?.terminalAt);
  assert.equal(result.report.parentPermissionProofDigest, `sha256:${'a'.repeat(64)}`);
  const events = await f.observations();
  assert.equal(events.filter((entry) => entry.event === 'prompt').length, 2);
  assert.deepEqual(events.filter((entry) => entry.event === 'permission_reply').map(({ outcome, optionId }) => [outcome, optionId]), [['selected', 'allow-once']]);
  assert.equal(events.filter((entry) => entry.event === 'mcp_callback').length, 1);
  await f.assertQuiesced();
});

test('serial once permissions compose with actual managed admission, child delivery and cancellation within six original turns', async (t) => {
  const f = await fixture(t);
  const result = await f.execute(await f.discover(), 'managed-full', true);
  assert.equal(result.report.outcome, 'qualified', JSON.stringify(result.report.failedGates));
  assertQualifiedNativeMode(result.report);
  assert.equal(result.report.usage.turns, 6);
  assert.equal(result.report.approvals?.length, 4);
  assert.equal(result.report.tools.length, 4);
  assert.equal(result.report.admissions.length, 2);
  assert.equal(result.report.cancellation.status, 'confirmed');
  assert.equal(result.report.delivery?.token, result.report.child?.token);
  assert.equal(result.report.dispatchGate?.verified, true);
  for (const turn of result.report.turns.filter((candidate) => candidate.purpose === 'admission' || candidate.purpose === 'cancellation_admission')) {
    assert.deepEqual(turn.admissionObservation, { assistantTextBytes: 17, assistantTextDeltas: 2, textCapped: false,
      requestCount: 2, toolItems: { search_tool: 0, use_tool: 0, managed_targets: 1, managed_delegate: 1, other: 0 }, response: 'admitted_true' });
  }
  const events = await f.observations();
  assert.equal(events.filter((entry) => entry.event === 'prompt').length, 6);
  assert.equal(events.filter((entry) => entry.event === 'permission_reply' && entry.outcome === 'selected').length, 4);
  assert.equal(events.filter((entry) => entry.event === 'mcp_callback').length, 4);
  assert.equal(events.filter((entry) => entry.role === 'child' && entry.event === 'cancel').length, 1);
  await f.assertQuiesced();
});

for (const [behavior, bytes, deltas, capped, response] of [
  ['managed-text-only', 17, 2, false, 'admitted_true'],
  ['managed-text-capped', 8192, 3, true, 'other_text'],
  ['managed-text-none', 0, 0, false, 'none'],
] as const) test(`completed ${behavior} admission retains safe observations and remains blocked without managed callbacks`, async (t) => {
  const f = await fixture(t);
  const result = await f.execute(await f.discover(), behavior, true);
  assert.equal(result.report.reason, 'parent_did_not_delegate');
  assert.equal(result.report.outcome, 'blocked');
  assert.equal(result.report.usage.turns, 2);
  assert.deepEqual(result.report.tools, []);
  assert.deepEqual(result.report.admissions, []);
  assert.deepEqual(result.report.approvals, []);
  const admission = result.report.turns.find((turn) => turn.purpose === 'admission');
  assert.equal(admission?.outcome, 'completed');
  assert.equal(admission?.resultText, undefined);
  assert.deepEqual(admission?.admissionObservation, { assistantTextBytes: bytes, assistantTextDeltas: deltas, textCapped: capped,
    requestCount: 0, toolItems: { search_tool: 0, use_tool: 0, managed_targets: 0, managed_delegate: 0, other: 0 }, response });
  assert.equal(result.report.turns[0]?.admissionObservation, undefined);
  assert.equal(JSON.stringify(result.report).includes('PRIVATE_SYNTHETIC_ADMISSION_DIAGNOSTIC_'), false);
  assert.equal((await f.observations()).filter((entry) => entry.event === 'prompt').length, 2);
  await f.assertQuiesced();
});

for (const [behavior, authorize, grants] of [
  ['managed-permission', false, 0],
  ['managed-ordinary', true, 0],
  ['managed-delegate-first', true, 0],
  ['managed-ambiguous', true, 0],
  ['managed-conflicting-name', true, 0],
  ['managed-repeat', true, 1],
] as const) test(`the real host denies ${behavior} without granting an unproved or repeated native permission`, async (t) => {
  const f = await fixture(t);
  const result = await f.execute(await f.discover(), behavior, authorize);
  assert.equal(result.report.reason, 'approval_not_authorized');
  assert.equal(result.report.outcome, 'blocked');
  assert.equal(result.report.admissions.length, 0);
  assert.equal(result.report.tools.length, grants);
  assert.equal(result.report.approvals?.length ?? 0, grants);
  const events = await f.observations();
  assert.equal(events.filter((entry) => entry.event === 'permission_requested').length, grants + 1);
  assert.equal(events.filter((entry) => entry.event === 'permission_reply' && entry.outcome === 'selected').length, grants);
  assert.equal(events.filter((entry) => entry.event === 'mcp_callback').length, grants);
  if (grants) {
    assert.ok(result.report.version === 2);
    assert.equal(result.report.approvals?.[0]?.nextBoundary, 'pending_request');
  }
  await f.assertQuiesced();
});

for (const [behavior, gate, reason] of [
  ['reject-model', 'opening', 'native_protocol_incompatible'],
  ['drift-reasoning', 'configuration', 'native_protocol_incompatible'],
  ['auth-required', 'opening', 'authentication_failed'],
] as const) test(`native execution closes the process and MCP bridge when ${behavior} blocks configuration before inference`, async (t) => {
  const f = await fixture(t);
  const selection = await f.discover();
  const result = await f.execute(selection, behavior);
  assert.equal(result.report.outcome, 'blocked');
  assert.equal(result.report.reason, reason);
  assert.deepEqual(result.report.failedGates, [{ gate, reason }]);
  assert.equal(result.report.usage.turns, 0);
  assert.equal(result.report.cleanup.bridgesAcquired, 1);
  assert.equal(result.report.cleanup.bridgesReleased, 1);
  const events = await f.observations();
  assert.equal(events.some((entry) => entry.event === 'prompt'), false);
  assert.equal(events.filter((entry) => entry.role !== 'discovery' && entry.event === 'initialize').length, 3);
  if (behavior === 'reject-model') assert.equal(events.some((entry) => entry.event === 'configuration_rejected'), true);
  else if (behavior === 'auth-required') {
    assert.equal(events.some((entry) => entry.event === 'authentication_required'), true);
    assert.equal(JSON.stringify(result.report).includes('Synthetic authentication diagnostic'), false);
  } else {
    assert.equal(events.some((entry) => entry.event === 'configuration_drift' && entry.value === 'medium'), true);
    assert.deepEqual(result.report.sessions.filter((entry) => entry.role === 'parent').map((entry) => entry.event), ['opening', 'opened', 'closed']);
  }
  await f.assertQuiesced();
});

test('an unexpected live native permission is blocked without a grant and prevents managed admission', async (t) => {
  const f = await fixture(t);
  const result = await f.execute(await f.discover(), 'permission');
  assert.equal(result.report.outcome, 'blocked');
  assert.equal(result.report.reason, 'approval_not_authorized');
  assert.deepEqual(result.report.failedGates, [{ gate: 'ordinary', reason: 'approval_not_authorized' }]);
  assert.equal(result.report.usage.turns, 1);
  assert.equal(result.report.turns[0]?.outcome, 'pending_request');
  assert.ok(result.report.turns[0]?.providerStartedAt !== undefined);
  assert.deepEqual(result.report.admissions, []);
  assert.deepEqual(result.report.tools, []);
  const events = await f.observations();
  assert.equal(events.filter((entry) => entry.event === 'prompt').length, 1);
  assert.equal(events.filter((entry) => entry.event === 'permission_requested').length, 1);
  for (const reply of events.filter((entry) => entry.event === 'permission_reply')) {
    assert.ok(reply.outcome === 'cancelled' || (reply.outcome === 'selected' && reply.optionId === 'deny'));
  }
  await f.assertQuiesced();
});
