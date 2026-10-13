import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openAcpInstallationStore } from '../src/node/install/index.js';
import { AcpInstallationError } from '../src/node/install/errors.js';
import { fixturePlan, storeFixture } from './fixtures/install-store/index.js';

const installationError = (code: AcpInstallationError['code']) => (error: unknown) => error instanceof AcpInstallationError && error.code === code;

async function heldArtifactServer(bytes: Uint8Array) {
  let admitted!: () => void;
  const requested = new Promise<void>((resolve) => { admitted = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    response.write(bytes.subarray(0, 10));
    admitted();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/agent.tar.gz`, requested,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

test('an actual competing process lock survives owner death and permits only exact explicitly quiesced recovery', { timeout: 15_000 }, async () => {
  const fixture = await storeFixture();
  const server = await heldArtifactServer(fixture.archive);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = await openAcpInstallationStore({ root: fixture.root });
    const plan = fixturePlan(fixture.archive, { url: server.url, network: true });
    const planPath = path.join(fixture.directory, 'plan.json');
    await writeFile(planPath, JSON.stringify(plan));
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/install-store/worker.ts', import.meta.url)), fixture.root, planPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr?.on('data', (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192); });
    const exited = once(child, 'exit');
    await Promise.race([server.requested, exited.then(() => { throw new Error(`Store worker exited before acquisition: ${diagnostics}`); })]);
    const attempt = await store.inspectAttempt(plan.digest);
    assert.ok(attempt);
    assert.equal(attempt.operation, 'install');
    await assert.rejects(store.install({ plan, expectedPlanDigest: plan.digest }), installationError('store_busy'));
    assert.deepEqual(await readdir(path.join(fixture.root, 'installations')), []);
    assert.equal((await readdir(path.join(fixture.root, 'stages'))).length, 1);
    child.kill('SIGKILL');
    await exited;
    const reopened = await openAcpInstallationStore({ root: fixture.root });
    assert.deepEqual(await reopened.inspectAttempt(plan.digest), attempt);
    await assert.rejects(reopened.recoverAttempt({ ...attempt, attemptToken: '00000000-0000-4000-8000-000000000000', ownerQuiesced: true }), installationError('recovery_conflict'));
    await assert.rejects(reopened.recoverAttempt({ ...attempt, ownerQuiesced: false as true }), installationError('recovery_conflict'));
    const accessorAuthority = Object.defineProperty({ ...attempt }, 'ownerQuiesced', { enumerable: true, get: () => true });
    await assert.rejects(reopened.recoverAttempt(accessorAuthority as typeof attempt & { ownerQuiesced: true }), installationError('invalid_input'));
    assert.deepEqual(await reopened.inspectAttempt(plan.digest), attempt);
    await reopened.recoverAttempt({ ...attempt, ownerQuiesced: true });
    assert.equal(await reopened.inspectAttempt(plan.digest), undefined);
    assert.deepEqual(await readdir(path.join(fixture.root, 'stages')), []);
    assert.deepEqual(await readdir(path.join(fixture.root, 'installations')), []);
    const receipt = await reopened.install({ plan, expectedPlanDigest: plan.digest, localArtifacts: fixture.installInput.localArtifacts });
    assert.equal(receipt.plan.digest, plan.digest);
    assert.equal((await reopened.read({ planDigest: plan.digest, installationId: receipt.installationId })).installationId, receipt.installationId);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await server.close();
    await fixture.cleanup();
  }
});

test('cancellation during an actual artifact stream removes its private attempt and never publishes a partial installation', { timeout: 10_000 }, async () => {
  const fixture = await storeFixture();
  const server = await heldArtifactServer(fixture.archive);
  try {
    const store = await openAcpInstallationStore({ root: fixture.root });
    const plan = fixturePlan(fixture.archive, { url: server.url, network: true });
    const controller = new AbortController();
    const installing = store.install({ plan, expectedPlanDigest: plan.digest, signal: controller.signal });
    await server.requested;
    controller.abort();
    await assert.rejects(installing, installationError('aborted'));
    for (const directory of ['installations', 'stages', 'locks']) assert.deepEqual(await readdir(path.join(fixture.root, directory)), []);
  } finally { await server.close(); await fixture.cleanup(); }
});

test('incomplete unknown lock ownership is retained without guessing its owner from elapsed time', async () => {
  const fixture = await storeFixture();
  try {
    const store = await openAcpInstallationStore({ root: fixture.root });
    const directory = path.join(fixture.root, 'locks', fixture.plan.digest.slice(7));
    await mkdir(directory);
    await assert.rejects(store.inspectAttempt(fixture.plan.digest), installationError('recovery_conflict'));
    await assert.rejects(store.install(fixture.installInput), installationError('store_busy'));
    assert.deepEqual(await readdir(directory), []);
  } finally { await fixture.cleanup(); }
});

if (process.platform !== 'win32') {
  test('a FIFO replacing a retained receipt fails closed without blocking its process on open', { timeout: 10_000 }, async () => {
    const fixture = await storeFixture();
    let child: ReturnType<typeof spawn> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const store = await openAcpInstallationStore({ root: fixture.root });
      await store.install(fixture.installInput);
      const receiptPath = path.join(fixture.root, 'installations', fixture.plan.digest.slice(7), 'receipt.json');
      await unlink(receiptPath);
      await promisify(execFile)('mkfifo', [receiptPath]);
      const planPath = path.join(fixture.directory, 'plan.json');
      await writeFile(planPath, JSON.stringify(fixture.plan));
      child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/install-store/worker.ts', import.meta.url)), fixture.root, planPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let diagnostics = '';
      child.stderr?.on('data', (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192); });
      const exited = once(child, 'exit');
      const [code] = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Reading a special receipt left an unbounded filesystem open.')), 3_000);
      })]);
      assert.equal(code, 1);
      assert.match(diagnostics, /code: 'store_invalid'/u);
      assert.deepEqual(await readdir(path.join(fixture.root, 'locks')), []);
    } finally {
      if (deadline) clearTimeout(deadline);
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
      await fixture.cleanup();
    }
  });
}
