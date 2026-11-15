import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseAgentApprovalRequest } from '@agen-ai/agent-protocol';
import { AgentProviderContractError, AgentProviderRegistryError } from '@agen-ai/agent-runtime';
import { parseAgentProviderKey } from '@agen-ai/agent-protocol';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { nativeCommand, safeCommandFailure } from '../cli.js';
import { parseNativeConfiguration } from '../config.js';
import type { NativeRunConfiguration } from '../config.js';
import { createArtifacts } from '../files.js';
import { consumeReservation } from '../reservation.js';
import { residualResolution } from '../residual.js';
import { safeFailureCode } from '../diagnostics.js';

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return Object.fromEntries(Object.entries(value));
}
async function temporary(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agenai-approval-native-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function example(kind: 'run' | 'prepare') {
  return object(JSON.parse(await readFile(new URL(`../${kind}-config.example.json`, import.meta.url), 'utf8')));
}
async function runConfig(t: TestContext): Promise<NativeRunConfiguration> {
  const root = await temporary(t); const raw = await example('run');
  await mkdir(join(root, 'ledger'), { mode: 0o700 });
  const config = parseNativeConfiguration({ ...raw, artifactsDirectory: join(root, 'artifacts'),
    reservation: { ...object(raw.reservation), ledgerDirectory: join(root, 'ledger'), maximumCents: 100, amountCents: 40 } });
  assert.equal(config.format, 'agenai.approval-native-run.v1');
  if (config.format !== 'agenai.approval-native-run.v1') assert.fail('Run example required.');
  return config;
}

test('native help and both real JSON templates validate without credential, reservation or Docker effects', async (t) => {
  const root = await temporary(t);
  for (const command of ['help', '--help']) {
    const result = await nativeCommand([command]);
    assert.equal(result.exitCode, 0); assert(JSON.stringify(result.output).includes('authorization reservation'));
  }
  for (const kind of ['run', 'prepare'] as const) {
    const input = await example(kind); const file = join(root, `${kind}.json`); await writeFile(file, JSON.stringify(input));
    assert.deepEqual(await nativeCommand(['check-config', '--config', file]), { exitCode: 0, output: {
      valid: true, format: `agenai.approval-native-${kind}.v1`, provider: 'grok', mapping: 'grok-build-1.0.77-controlled-shell-v1',
      requestedPolicy: 'provider_auto_review', nativeExecution: false,
    } });
  }
  await assert.rejects(access(join(root, 'artifacts')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'ledger')), { code: 'ENOENT' });
});

test('native check-config preserves bounded immutable Bash denials and rejects invalid lists without preparing resources', async (t) => {
  const root = await temporary(t); const raw = await example('prepare');
  const profile = object(raw.profile); const context = join(root, 'unentered-context');
  const accepted = [[], ['git reset --hard*', 'printf "literal" C:\\owned\\*'],
    Array.from({ length: 32 }, () => 'echo'), ['é'.repeat(2048)], Array.from({ length: 4 }, () => 'a'.repeat(4096))];
  for (const [index, deniedBashPatterns] of accepted.entries()) {
    const input = { ...raw, profile: { ...profile, deniedBashPatterns },
      preparation: { ...object(raw.preparation), directory: context } };
    const parsed = parseNativeConfiguration(input);
    assert.deepEqual(object(parsed.profile).deniedBashPatterns, deniedBashPatterns);
    const file = join(root, `valid-${index}.json`); await writeFile(file, JSON.stringify(input));
    assert.deepEqual(await nativeCommand(['check-config', '--config', file]), { exitCode: 0, output: {
      valid: true, format: 'agenai.approval-native-prepare.v1', provider: 'grok', mapping: 'grok-build-1.0.77-controlled-shell-v1',
      requestedPolicy: 'provider_auto_review', nativeExecution: false,
    } });
  }
  const invalid: readonly unknown[] = [null, 'git *', [17], [''], ['line\nbreak'], ['\ud800'],
    Array.from({ length: 33 }, () => 'echo'), ['é'.repeat(2049)], [...Array.from({ length: 4 }, () => 'a'.repeat(4096)), 'x']];
  for (const [index, deniedBashPatterns] of invalid.entries()) {
    const file = join(root, `invalid-${index}.json`);
    await writeFile(file, JSON.stringify({ ...raw, profile: { ...profile, deniedBashPatterns },
      preparation: { ...object(raw.preparation), directory: context } }));
    await assert.rejects(nativeCommand(['check-config', '--config', file]), { code: 'invalid_input' });
  }
  await assert.rejects(access(context), { code: 'ENOENT' });
});

test('closed native commands/configuration reject unsupported credentials and control overrides without echoing input', async (t) => {
  const root = await temporary(t); const raw = await example('run'); const secret = 'synthetic-must-not-appear-in-diagnostics';
  for (const argv of [[], ['run'], ['help', '--config', secret], ['check-config', '--unknown', secret]]) {
    const error: unknown = await nativeCommand(argv).catch((failure: unknown) => failure);
    assert.deepEqual(safeCommandFailure(error), { failed: true, code: 'invalid_input',
      message: 'Native example failed. Preserve its original safe checkpoints and cleanup ownership; do not rerun the attempt.' });
  }
  const cases = [
    { ...raw, verifier: true }, { ...raw, model: secret }, { ...raw, nativeApiEndpoint: 'https://unqualified.invalid' },
    { ...raw, credential: { kind: 'api_key', value: secret } }, { ...raw, residual: { kind: 'accept_all' } },
    { ...raw, workload: { ...object(raw.workload), execution: { kind: 'until_stopped' } } },
    { ...raw, backend: { ...object(raw.backend), filesystem: {} } },
    { ...raw, reservation: { ...object(raw.reservation), amountCents: 0.5 } },
    { ...raw, prompt: '/unsafe-native-command' },
  ];
  for (const input of cases) {
    const file = join(root, 'invalid.json'); await writeFile(file, JSON.stringify(input));
    const error: unknown = await nativeCommand(['run', '--config', file]).catch((failure: unknown) => failure);
    const safe = safeCommandFailure(error);
    assert.equal('code' in safe ? safe.code : undefined, 'invalid_input');
    assert(!JSON.stringify(safe).includes(secret));
  }
});

test('prepare invokes actual public offline preparation and leaves account and reservation inputs untouched', async (t) => {
  const root = await temporary(t); const raw = await example('prepare'); const context = join(root, 'context');
  const file = join(root, 'prepare.json');
  await writeFile(file, JSON.stringify({ ...raw, preparation: { ...object(raw.preparation), directory: context } }));
  const result = await nativeCommand(['prepare', '--config', file]);
  assert.deepEqual(result, { exitCode: 0, output: { prepared: true, mapping: 'grok-build-1.0.77-controlled-shell-v1',
    requestedPolicy: 'provider_auto_review', directory: context, nativeExecution: false, imageOwnership: 'caller' } });
  assert((await readFile(join(context, 'Dockerfile'), 'utf8')).includes('FROM scratch'));
  await assert.rejects(access(join(root, 'ledger')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'auth.json')), { code: 'ENOENT' });
});

test('campaign reservation persists exact cents, refuses replay/ceiling changes and gates run before native effects', async (t) => {
  const config = await runConfig(t);
  assert.deepEqual(await consumeReservation(config), { currency: 'USD', amountCents: 40, consumedCents: 40, maximumCents: 100,
    meaning: 'authorization_reservation_only', providerCharge: 'unobserved' });
  const file = join(config.reservation.ledgerDirectory, 'reservations/run-one.json');
  const record = object(JSON.parse(await readFile(file, 'utf8')));
  assert.equal(record.amountCents, 40); assert.equal(record.runId, 'run-one'); assert.equal(record.nativeSessionId, '00000000-0000-4000-8000-000000000001');
  const configurationFile = join(config.reservation.ledgerDirectory, 'rerun.json');
  // JSON templates contain descriptors; opaque route handles are reconstructed by check-config/run.
  const raw = await example('run');
  await writeFile(configurationFile, JSON.stringify({ ...raw, artifactsDirectory: config.artifactsDirectory, reservation: config.reservation }));
  const error: unknown = await nativeCommand(['run', '--config', configurationFile]).catch((failure: unknown) => failure);
  const safe = safeCommandFailure(error);
  assert.equal('code' in safe ? safe.code : undefined, 'reservation_refused');
  await assert.rejects(access(config.artifactsDirectory), { code: 'ENOENT' });
  await assert.rejects(consumeReservation({ ...config, reservation: { ...config.reservation, maximumCents: 200 } }), { code: 'reservation_refused' });
  const next = { ...config, runId: 'run-two', profile: { ...config.profile, nativeSessionId: '00000000-0000-4000-8000-000000000002' },
    reservation: { ...config.reservation, amountCents: 50 } };
  assert.equal((await consumeReservation(next)).consumedCents, 90);
  await assert.rejects(consumeReservation({ ...next, runId: 'run-three', profile: { ...next.profile, nativeSessionId: '00000000-0000-4000-8000-000000000003' },
    reservation: { ...next.reservation, amountCents: 20 } }), { code: 'reservation_refused' });
  assert.equal(object(JSON.parse(await readFile(file, 'utf8'))).amountCents, 40);
});

test('an existing campaign lock is preserved for explicit reconciliation', async (t) => {
  const config = await runConfig(t); const lock = join(config.reservation.ledgerDirectory, '.lock'); await mkdir(lock);
  await assert.rejects(consumeReservation(config), { code: 'reservation_refused' });
  await access(lock); await assert.rejects(access(join(config.reservation.ledgerDirectory, 'campaign.json')), { code: 'ENOENT' });
});

test('original recovery checkpoints remain separate immutable records with an atomic latest pointer', async (t) => {
  const root = await temporary(t); const artifacts = await createArtifacts(join(root, 'artifacts'));
  const digest = `sha256:${'1'.repeat(64)}`;
  const first = parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'fixture', backendRevision: '1', namespace: 'fixture',
    operationId: 'original-operation', sandboxId: 'original-sandbox', imageDigest: digest, policyDigest: digest, configurationDigest: digest,
    phase: 'reserved', authority: { kind: 'unverified' }, resources: [{ role: 'storage', name: 'original-storage', identity: { kind: 'planned' } }] });
  await artifacts.persist(first); await artifacts.persist({ ...first, phase: 'starting' });
  assert.equal(object(JSON.parse(await readFile(join(artifacts.directory, 'recovery-0001.json'), 'utf8'))).phase, 'reserved');
  const latest = object(JSON.parse(await readFile(join(artifacts.directory, 'recovery-latest.json'), 'utf8')));
  assert.equal(latest.file, 'recovery-0002.json'); assert.equal(object(latest.record).phase, 'starting');
  assert.equal(object(latest.record).operationId, 'original-operation');
});

test('safe diagnostics preserve closed contract codes through registry wrapping without native messages', () => {
  const secret = 'synthetic-private-native-message';
  const contract = new AgentProviderContractError(parseAgentProviderKey('grok'), 'approval_policy_unconfirmed', secret);
  const wrapped = new AgentProviderRegistryError({ code: 'instance_materialization_failed', message: secret, cause: contract });
  assert.equal(safeFailureCode(wrapped), 'approval_policy_unconfirmed');
  assert.equal(safeFailureCode(new Error(secret)), 'run_failed');
  assert.equal(safeFailureCode({ code: secret, message: secret }), 'run_failed');
  assert(!JSON.stringify(safeCommandFailure(wrapped)).includes(secret));
});

test('native check-config preserves optional bounded tool-action observations and omission without resources', async (t) => {
  const root = await temporary(t); const raw = await example('run');
  const { maxToolActions: _sample, ...limits } = object(raw.limits);
  for (const maxToolActions of [undefined, 1, 100000]) {
    const file = join(root, 'valid-limit.json');
    const input = { ...raw, limits: { ...limits, ...(maxToolActions === undefined ? {} : { maxToolActions }) } };
    const parsed = parseNativeConfiguration(input);
    assert.equal(parsed.format, 'agenai.approval-native-run.v1');
    assert.equal(object(object(parsed).limits).maxToolActions, maxToolActions);
    await writeFile(file, JSON.stringify(input));
    assert.equal((await nativeCommand(['check-config', '--config', file])).exitCode, 0);
  }
  for (const maxToolActions of [0, -1, 1.5, 100001, null, '2']) {
    const file = join(root, 'invalid-limit.json');
    await writeFile(file, JSON.stringify({ ...raw, limits: { ...limits, maxToolActions } }));
    await assert.rejects(nativeCommand(['check-config', '--config', file]), { code: 'invalid_input' });
  }
  await assert.rejects(access(join(root, 'artifacts')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'ledger')), { code: 'ENOENT' });
});

test('residual policy chooses the unique exact once option and cancels ambiguous or remembered-only menus', () => {
  const once = { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } };
  const request = (options: unknown[]) => parseAgentApprovalRequest({ requestKind: 'approval', requestId: 'request-one', prompt: 'Fixture action',
    subject: { kind: 'command', title: 'Write fixture file', itemId: 'item-one' }, options });
  const approved = { optionId: 'actual-once', label: 'Once', decision: 'approved', consequence: once };
  const denied = { optionId: 'actual-deny', label: 'No', decision: 'denied', consequence: once };
  const remembered = { optionId: 'remembered-first', label: 'Always', decision: 'approved',
    consequence: { kind: 'provider_managed_remembrance', duration: { kind: 'unknown' }, applicability: { kind: 'unknown' }, explanation: 'Provider remembers this choice.' } };
  const offered = request([remembered, approved, denied]);
  assert.deepEqual(residualResolution(offered, { kind: 'approve_once' }), { resolution: {
    requestKind: 'approval', requestId: 'request-one', disposition: 'selected', optionId: 'actual-once' }, refused: false });
  assert.deepEqual(residualResolution(offered, { kind: 'deny_once' }), { resolution: {
    requestKind: 'approval', requestId: 'request-one', disposition: 'selected', optionId: 'actual-deny' }, refused: false });
  for (const menu of [[remembered], [approved, { ...approved, optionId: 'second-once' }]]) {
    assert.deepEqual(residualResolution(request(menu), { kind: 'approve_once' }), { resolution: {
      requestKind: 'approval', requestId: 'request-one', disposition: 'canceled' }, refused: true });
  }
  assert.deepEqual(residualResolution(offered, { kind: 'cancel' }), { resolution: {
    requestKind: 'approval', requestId: 'request-one', disposition: 'canceled' }, refused: false });
});
