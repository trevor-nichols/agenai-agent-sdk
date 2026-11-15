import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepareNodeProviderWorkspace } from '@agen-ai/provider-tools/node';
import { parseAcceptEditsConfig, type AcceptEditsRunConfig } from '../config.js';
import type { AcceptEditsDecider } from '../decisions.js';
import { runAcceptEdits } from '../run.js';

const template = JSON.parse(await readFile(new URL('../run-config.example.json', import.meta.url), 'utf8')) as Record<string, unknown>;

// Teaching fixture: a fake key and binaries that do not exist. Nothing here can reach a provider.
async function fixture(t: TestContext, options: Readonly<{ prepared?: boolean; keyMode?: number }> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'accept-edits-run-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, 'store');
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(root, 'fake-key'), 'teaching-fixture-not-an-api-key\n', { mode: options.keyMode ?? 0o600 });
  if (options.prepared !== false) await prepareNodeProviderWorkspace({ directory: store });
  const { approvals: _approvals, ...config } = parseAcceptEditsConfig({ ...template,
    native: { executablePath: join(root, 'absent', 'claude'), bubblewrapPath: join(root, 'absent', 'bwrap'),
      filesystemHelperPath: join(root, 'absent', 'agenai-sandbox-files') },
    workspace: { storeDirectory: store, stateParentDirectory: state },
    credential: { kind: 'api_key_file', path: join(root, 'fake-key') } });
  return { root, store, state, config: config satisfies AcceptEditsRunConfig };
}

function recordingDecider() {
  const actions: unknown[] = [];
  const decide: AcceptEditsDecider = (action) => { actions.push(action); return 'deny_once'; };
  return { actions, decide };
}

for (const existing of [false, true]) {
  test(`an ${existing ? 'empty' : 'absent'} unprepared workspace is refused without changes or a key read`, async (t) => {
    const { root, store, state, config } = await fixture(t, { prepared: false });
    if (existing) await mkdir(store, { mode: 0o700 });
    await rm(join(root, 'fake-key'));
    const { actions, decide } = recordingDecider();
    const report = await runAcceptEdits(config, { decide });
    assert.deepEqual({ status: report.status, stage: report.stage, failureCode: report.failureCode, settled: report.cleanup.settled },
      { status: 'failed', stage: 'credential', failureCode: 'workspace_unprepared', settled: true });
    assert.deepEqual((await readdir(root)).sort(), existing ? ['state', 'store'] : ['state']);
    if (existing) assert.deepEqual(await readdir(store), []);
    assert.deepEqual(await readdir(state), []);
    assert.deepEqual(actions, []);
  });
}

test('a key file readable by other users is refused before any driver exists', async (t) => {
  const { state, config } = await fixture(t, { keyMode: 0o644 });
  const report = await runAcceptEdits(config, recordingDecider());
  assert.deepEqual({ status: report.status, stage: report.stage, failureCode: report.failureCode, support: report.support },
    { status: 'failed', stage: 'credential', failureCode: 'credential_invalid', support: null });
  assert.deepEqual(await readdir(state), []);
});

test('unverifiable native binaries stop materialization with no session, state or approval', async (t) => {
  const { store, state, config } = await fixture(t);
  const { actions, decide } = recordingDecider();
  const report = await runAcceptEdits(config, { decide });
  assert.equal(report.status, 'failed');
  assert.equal(report.stage, 'materialize');
  assert.ok(report.failureCode === 'platform_unsupported' || report.failureCode === 'identity_mismatch', String(report.failureCode));
  assert.deepEqual({ support: report.support, effective: report.effectivePolicy, events: report.output.events, cleanup: report.cleanup },
    { support: null, effective: null, events: 0, cleanup: { attempts: 1, settled: true, failures: [] } });
  assert.deepEqual(await readdir(state), []);
  assert.deepEqual(await readdir(join(store, 'work')), []);
  assert.deepEqual(actions, []);
});

test('cancellation before materialization reports cancelled and acquires nothing', async (t) => {
  const { root, store, state, config } = await fixture(t, { prepared: false });
  await mkdir(store, { mode: 0o700 });
  await rm(join(root, 'fake-key'));
  const controller = new AbortController();
  controller.abort();
  const report = await runAcceptEdits(config, { ...recordingDecider(), signal: controller.signal });
  assert.deepEqual({ status: report.status, stopCode: report.stopCode, stage: report.stage, failureCode: report.failureCode },
    { status: 'cancelled', stopCode: 'cancelled', stage: 'credential', failureCode: null });
  assert.deepEqual(await readdir(state), []);
  assert.deepEqual(await readdir(store), []);
});
