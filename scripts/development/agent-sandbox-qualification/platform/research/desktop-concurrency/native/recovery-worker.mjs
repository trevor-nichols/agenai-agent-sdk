import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from '../../../../engine.mjs';
import { settleOwnerCleanup } from '../../../capabilities/live/owner-cleanup.mjs';
import { census } from '../../../capabilities/network/resources.mjs';
import { installed, failure, sha } from './installed.mjs';

const [inputPath, mode, output, recordPath] = process.argv.slice(2);
assert(['hold', 'recover', 'verify'].includes(mode));
assert.equal(process.argv.length, mode === 'hold' ? 5 : 6);
const input = JSON.parse(await readFile(inputPath, 'utf8'));
assert.equal(process.version, `v${input.platform.expected.controller.nodeVersion}`);
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
await mkdir(output, { mode: 0o700 });
const sdk = await installed(input.consumer, '@agen-ai/sandbox');
const docker = await installed(input.consumer, '@agen-ai/sandbox-docker');
const node = await installed(input.consumer, '@agen-ai/sandbox-docker', './node');
const { platform, capabilities } = input;
const authority = capabilities.network.routeAuthority;
const engine = new Engine(platform.engine.slice(7), '1.52', { requestMs: 15000, outputBytes: 4 * 1024 ** 2 });
assert.equal((await engine.request('GET', '/info')).data.ID, authority.engine.id);
await mkdir(join(output, 'spill'), { mode: 0o700 });
const backend = docker.api.createDockerSandboxBackend({ endpoint: platform.engine, profile: platform.profile,
  namespace: input.researchNamespace, spillDirectory: join(output, 'spill'), imageDigest: platform.sourceImage,
  user: capabilities.workload.user, filesystem: capabilities.filesystem.configuration,
  egress: { ...capabilities.network.egress.configuration, routeAuthority: node.api.createDockerDesktopRouteAuthority(authority) } });
const result = { format: 'agenai.desktop-recovery-research-worker.v1', mode, status: 'running', pid: process.pid,
  packages: [sdk.identity, docker.identity, node.identity], checkpoints: [], observations: [], cleanupErrors: [] };
const save = () => writeFile(join(output, 'report.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
const checkpoint = async (record) => {
  assert(result.checkpoints.length < 128);
  const path = join(output, `checkpoint-${String(result.checkpoints.length + 1).padStart(4, '0')}.json`);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  result.checkpoints.push({ path, sha256: sha(bytes), phase: record.phase }); await save();
};
const settle = (owner) => settleOwnerCleanup(owner, 'destroy', { cleanupMs: 60000, async observe(value) {
  assert(result.observations.length < 128); result.observations.push(value); await save();
} });
let owner;
try {
  await save();
  if (mode === 'hold') {
    const request = sdk.api.parseSandboxRequest({ policy: { resources: capabilities.workload.resources,
      temporaryStorage: { homeBytes: capabilities.workload.temporaryBytes, tempBytes: capabilities.workload.temporaryBytes },
      network: { kind: 'restricted_https', destinations: [{ hostname: 'github.com', port: 443 }] },
      files: { kind: 'read_write' }, execution: { kind: 'until_stopped' },
      deadlines: { startupMs: capabilities.limits.startupMs, cleanupMs: capabilities.limits.cleanupMs },
      transfers: sdk.api.SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: sdk.api.SANDBOX_DEFAULT_STREAM_LIMITS } });
    owner = backend.reserve(request, { kind: 'persisted', persist: checkpoint });
    result.originalReservation = owner.recoveryRecord;
    await owner.start({ signal: AbortSignal.timeout(60000) });
    const originalPath = join(output, 'original-ready.json');
    await writeFile(originalPath, `${JSON.stringify(owner.recoveryRecord, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    result.readyRecord = owner.recoveryRecord; result.readyCensus = await census(engine, owner.recoveryRecord, 'ready');
    await save(); process.stdout.write(`${JSON.stringify({ phase: 'ready', originalPath, pid: process.pid })}\n`);
    await new Promise(() => {});
  } else {
    const original = sdk.api.parseSandboxRecoveryRecord(JSON.parse(await readFile(recordPath, 'utf8')));
    const reconciled = await backend.reconcile(original); result.reconciliation = reconciled.kind;
    if (mode === 'verify') assert.equal(reconciled.kind, 'absent', 'SDK-returned settled record must remain absent in a further process.');
    if (reconciled.kind === 'absent') result.finalRecord = reconciled.record;
    else {
      assert.equal(reconciled.kind, 'matched'); owner = reconciled.owner;
      for (const key of ['start', 'reserveProcess', 'importTree', 'exportTree', 'files']) assert.equal(owner[key], undefined);
      await settle(owner); result.finalRecord = owner.recoveryRecord;
    }
    assert.equal(result.finalRecord.phase, 'destroyed');
    result.finalCensus = await census(engine, original, 'fresh-process-original-exact-absence', true);
    const settledPath = join(output, 'settled.json');
    await writeFile(settledPath, `${JSON.stringify(result.finalRecord, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    result.status = 'passed'; await save();
    process.stdout.write(`${JSON.stringify({ phase: 'complete', status: result.status, settledPath })}\n`);
  }
} catch (error) {
  result.failure = failure(error); result.status = 'failed';
  if (owner) try { await settle(owner); result.finalRecord = owner.recoveryRecord; }
  catch (cleanup) { result.cleanupErrors.push(failure(cleanup)); result.finalRecord = owner.recoveryRecord; }
  await save(); process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ phase: 'complete', status: result.status })}\n`);
}
