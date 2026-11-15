import assert from 'node:assert/strict';
import { Dir } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { bounds, gate, lifecycleFixture, turn } from './fixtures/lifecycle.js';

const pending = <T>(promise: Promise<T>) => {
  let settled = false;
  const result = promise.then((value) => { settled = true; return { kind: 'returned' as const, value }; },
    (error: unknown) => { settled = true; return { kind: 'failed' as const, error }; });
  return { result, settled: () => settled };
};
const refusesTransfer = (operation: () => Promise<unknown>) => assert.throws(() => {
  void operation().catch(() => {});
}, /no longer admits/u);
const methods = (events: readonly { type: string }[]) => events.filter(({ type }) => ['initialize', 'session/new', 'session/prompt'].includes(type)).map(({ type }) => type);

test('personal credential bootstrap preserves identity and native privacy cache without refresh authority or source changes', { timeout: 10000 }, async (t) => {
  const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
  const account = { key: 'synthetic-access-for-bootstrap-receipt', auth_mode: 'oidc', user_id: 'synthetic-user',
    create_time: '2026-01-01T00:00:00Z', expires_at: '2100-01-01T00:00:00Z', oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828' };
  const identities = [{ principal_type: 'User', principal_id: 'synthetic-user', team_id: 'synthetic-personal-billing-team',
    coding_data_team: 'synthetic-opaque-privacy-context-distinct-from-billing', team_zero_data_retention: true,
    coding_data_retention_opt_out: true, team_blocked_reasons: ['BLOCKED_REASON_NO_LOGS', 'synthetic-unrecognized-reason'] },
    { principal_type: 'User', principal_id: 'synthetic-user', team_id: 'synthetic-personal-billing-team',
      coding_data_team: 'another-synthetic-opaque-context', team_zero_data_retention: false,
      coding_data_retention_opt_out: false, team_blocked_reasons: [] },
    {}, { principal_type: 'Personal', principal_id: 'synthetic-user' }, { principal_type: 'User', principal_id: 'synthetic-user' }];
  for (const [index, identity] of identities.entries()) {
    const source = JSON.stringify({ [scope]: { ...account, ...identity, refresh_token: 'synthetic-refresh-must-not-be-injected',
      email: 'synthetic@example.invalid' } });
    const credential = Buffer.from(source);
    const f = await lifecycleFixture(t, `credential-${index}`, 'host', { credential });
    await f.materialize();
    const injected: unknown = JSON.parse(await readFile(f.credentialReceipt, 'utf8'));
    assert.deepEqual(injected, { [scope]: { ...account, ...identity } });
    assert.equal(credential.toString('utf8'), source);
    assert.equal(f.controls.processCount, 1);
    await f.provider.dispose(); await f.exited();
    await assert.rejects(access(f.storage), { code: 'ENOENT' });
  }
});

test('materialization closes new imports at entry and joins the already-entered workspace import before launch', { timeout: 10000 }, async (t) => {
  const f = await lifecycleFixture(t, 'import');
  f.controls.importHold = gate();
  const importing = f.provider.workspace.importDirectory(f.source, bounds());
  await f.controls.importEntered.promise;
  const materializing = pending(f.materialize());
  refusesTransfer(() => f.provider.workspace.importDirectory(f.source, bounds()));
  await tick();
  assert.equal(materializing.settled(), false);
  assert.equal(f.controls.processCount, 0);
  f.controls.importHold.resolve();
  assert.deepEqual(await importing, { files: 1n, directories: 0n, symlinks: 0n, payloadBytes: 13n, archiveBytes: 13n });
  const materialized = await materializing.result;
  assert.equal(materialized.kind, 'returned');
  assert.equal(await readFile(join(f.workspace, 'input.txt'), 'utf8'), 'input:import\n');
  assert.equal(f.controls.processCount, 1);
  await f.provider.dispose();
  await assert.rejects(access(f.storage), { code: 'ENOENT' });
});

test('outer disposal joins entered eager initialization and original process cleanup', { timeout: 10000 }, async (t) => {
  const f = await lifecycleFixture(t, 'eager', 'host', { holdInitialize: true });
  f.controls.stopHold = gate();
  const materializing = pending(f.materialize());
  await f.waitFor('initialize');
  const disposing = pending(f.provider.dispose());
  await f.controls.stopEntered.promise;
  await f.waitFor('stdin-ended');
  f.release('initialize'); await f.waitFor('replied:initialize'); await tick();
  assert.equal(disposing.settled(), false);
  assert.equal(f.controls.destroyCount, 0);
  f.controls.stopHold.resolve();
  assert.equal((await materializing.result).kind, 'failed');
  assert.equal((await disposing.result).kind, 'returned');
  assert.deepEqual(methods(f.events), ['initialize']);
  assert.equal(f.controls.processCount, 1);
  await f.exited(); await assert.rejects(access(f.storage), { code: 'ENOENT' });
  refusesTransfer(() => f.provider.workspace.importDirectory(f.source, bounds()));
});

test('outer disposal joins entered opening and rejects a late reply after pipe retirement', { timeout: 10000 }, async (t) => {
  const f = await lifecycleFixture(t, 'opening', 'provider_bypass', { holdOpening: true });
  const instance = await f.materialize();
  const opening = pending(f.create(instance)); await f.waitFor('session/new');
  f.controls.stopHold = gate();
  const disposing = pending(f.provider.dispose()); await f.controls.stopEntered.promise;
  await f.waitFor('stdin-ended');
  f.release('session/new'); await f.waitFor('replied:session/new'); await tick();
  assert.equal(disposing.settled(), false); assert.equal(f.controls.destroyCount, 0);
  f.controls.stopHold.resolve();
  assert.equal((await opening.result).kind, 'failed');
  assert.equal((await disposing.result).kind, 'returned');
  assert.deepEqual(methods(f.events), ['initialize', 'session/new']);
  await f.exited(); await assert.rejects(access(f.storage), { code: 'ENOENT' });
});

test('outer disposal synchronously fences an existing session before physical stop settles', { timeout: 10000 }, async (t) => {
  const f = await lifecycleFixture(t, 'turn-fence');
  const session = await f.create(await f.materialize());
  f.controls.stopHold = gate();
  const disposing = pending(f.provider.dispose());
  assert.throws(() => session.startTurn(turn), /no longer admits/u);
  await f.controls.stopEntered.promise;
  assert.equal(disposing.settled(), false);
  assert.deepEqual(methods(f.events), ['initialize', 'session/new']);
  f.controls.stopHold.resolve();
  assert.equal((await disposing.result).kind, 'returned');
  await f.exited();
});

test('failed stop fences export and retries the same process and opening without replay', { timeout: 10000 }, async (t) => {
  const f = await lifecycleFixture(t, 'retry');
  const instance = await f.materialize(); await f.create(instance);
  f.controls.failStop = true;
  await assert.rejects(Promise.resolve(instance.dispose()), /cleanup|stop/u);
  await access(f.storage); await access(join(f.root, 'compute'));
  refusesTransfer(() => f.provider.workspace.exportDirectory({ kind: 'workspace' }, join(f.root, 'blocked'), bounds()));
  await assert.rejects(f.materialize());
  assert.deepEqual(methods(f.events), ['initialize', 'session/new']);
  f.controls.failStop = false;
  await f.provider.dispose();
  assert.equal(f.controls.processCount, 1);
  assert.deepEqual(methods(f.events), ['initialize', 'session/new']);
  await f.exited(); await assert.rejects(access(f.storage), { code: 'ENOENT' });
});

test('export waits for stop and active request-reader cleanup, then publishes the actual workspace result', { timeout: 10000 }, async (t) => {
  const f = await lifecycleFixture(t, 'callback', 'provider_auto_review', { permission: true });
  const session = await f.create(await f.materialize());
  const execution = session.startTurn(turn);
  const iterator = execution.outputs[Symbol.asyncIterator]();
  let sawRequest = false;
  while (!sawRequest) {
    const next = await iterator.next(); assert.equal(next.done, false);
    sawRequest = next.value?.kind === 'event' && next.value.event.type === 'request.opened';
  }
  const reading = pending((async () => { while (!(await iterator.next()).done) { /* Sole output reader drains its original turn. */ } })());
  f.controls.stopHold = gate();
  const closing = pending(Promise.resolve(session.close({ reason: 'shutdown' })));
  await f.controls.stopEntered.promise;
  refusesTransfer(() => f.provider.workspace.exportDirectory({ kind: 'workspace' }, join(f.root, 'too-early'), bounds()));
  assert.equal(closing.settled(), false); assert.equal(f.controls.exportCount, 0);
  f.controls.stopHold.resolve();
  assert.equal((await closing.result).kind, 'returned');
  await reading.result; assert.equal(reading.settled(), true);
  const published = await f.provider.workspace.exportDirectory({ kind: 'workspace' }, join(f.root, 'published'), bounds());
  assert.equal(await readFile(join(published.directory, 'result.txt'), 'utf8'), 'result:callback:provider_auto_review\n');
  assert.equal(published.summary.files, 1n);
  await f.exited();
});

test('already-stopped outer disposal joins host export publication after the neutral transfer completes', { timeout: 10000 }, async (t) => {
  const publication = gate(); const entered = gate();
  t.after(() => publication.resolve());
  const f = await lifecycleFixture(t, 'publication');
  await f.provider.workspace.importDirectory(f.source, bounds());
  const instance = await f.materialize(); await instance.dispose();
  const original = Dir.prototype.read;
  t.mock.method(Dir.prototype, 'read', function (this: Dir, ...args: unknown[]) {
    if (String(this.path).includes('/.staging-')) { entered.resolve(); return publication.promise.then(() => Reflect.apply(original, this, args)); }
    return Reflect.apply(original, this, args);
  });
  const exporting = f.provider.workspace.exportDirectory({ kind: 'workspace' }, join(f.root, 'export'), bounds());
  await entered.promise; await f.controls.exportCompleted.promise;
  const disposing = pending(f.provider.dispose()); await tick();
  assert.equal(disposing.settled(), false); assert.equal(f.controls.destroyCount, 0);
  publication.resolve();
  const result = await exporting;
  assert.equal(await readFile(join(result.directory, 'input.txt'), 'utf8'), 'input:publication\n');
  assert.equal((await disposing.result).kind, 'returned');
  await assert.rejects(access(f.storage), { code: 'ENOENT' });
});

test('different policy owners retain separate native identities and workspaces when one cleanup fails', { timeout: 10000 }, async (t) => {
  const host = await lifecycleFixture(t, 'isolation-host', 'host');
  const bypass = await lifecycleFixture(t, 'isolation-bypass', 'provider_bypass');
  const hostSession = await host.create(await host.materialize());
  const bypassSession = await bypass.create(await bypass.materialize());
  assert.deepEqual(hostSession.approvalPolicy, { policy: { kind: 'host' }, verification: 'controlled_configuration' });
  assert.deepEqual(bypassSession.approvalPolicy, { policy: { kind: 'provider_bypass' }, verification: 'controlled_configuration' });
  assert.notEqual(host.pid(), bypass.pid()); assert.notEqual(host.profile.nativeSessionId, bypass.profile.nativeSessionId);
  host.controls.failStop = true;
  await assert.rejects(host.provider.dispose());
  const outputs = await Array.fromAsync(bypassSession.startTurn(turn).outputs);
  assert(outputs.some((output) => output.kind === 'event' && output.event.type === 'turn.completed' && output.event.payload.outcome === 'completed'));
  await bypassSession.close({ reason: 'shutdown' });
  const exported = await bypass.provider.workspace.exportDirectory({ kind: 'workspace' }, join(bypass.root, 'export'), bounds());
  assert.equal(await readFile(join(exported.directory, 'result.txt'), 'utf8'), 'result:isolation-bypass:provider_bypass\n');
  await assert.rejects(access(join(host.workspace, 'result.txt')), { code: 'ENOENT' });
  host.controls.failStop = false; await host.provider.dispose(); await bypass.provider.dispose();
  assert.deepEqual(methods(host.events), ['initialize', 'session/new']);
  assert.deepEqual(methods(bypass.events), ['initialize', 'session/new', 'session/prompt']);
});
