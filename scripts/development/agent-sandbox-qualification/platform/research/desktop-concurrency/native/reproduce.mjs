import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../../../../engine.mjs';
import { createTraceProxy } from '../../../../selective/proxy/index.mjs';
import { settleOwnerCleanup } from '../../../capabilities/live/owner-cleanup.mjs';
import { census } from '../../../capabilities/network/resources.mjs';
import { capture } from './capture.mjs';
import { failure, installed, sha } from './installed.mjs';
import { captureHost } from './host-capture.mjs';

const [inputPath] = process.argv.slice(2);
assert.equal(process.argv.length, 3);
const input = JSON.parse(await readFile(inputPath, 'utf8'));
assert.deepEqual(Object.keys(input).sort(), ['consumer', 'output', 'platform', 'capabilities', 'deploymentObservation'].sort());
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
assert.equal(process.version, `v${input.platform.expected.controller.nodeVersion}`);
const sdk = await installed(input.consumer, '@agen-ai/sandbox');
const docker = await installed(input.consumer, '@agen-ai/sandbox-docker');
const node = await installed(input.consumer, '@agen-ai/sandbox-docker', './node');
const { platform, capabilities } = input;
assert.equal(platform.profile, 'desktop-apple-virtualization-native-arm64');
assert.equal(capabilities.profile, platform.profile);
const authority = capabilities.network.routeAuthority;
assert.equal(authority.engine.endpoint, platform.engine);
assert.equal(input.deploymentObservation.engine.id, authority.engine.id);
assert.deepEqual(input.deploymentObservation.deployment, authority.deployment);
assert.equal(sha(await readFile(authority.hostObserver.executable.path)), authority.hostObserver.executable.sha256);
const socket = await lstat(platform.engine.slice(7), { bigint: true }); assert(socket.isSocket());
const engine = new Engine(platform.engine.slice(7), '1.52', { requestMs: 15000, outputBytes: 4 * 1024 ** 2 });
const initial = (await engine.request('GET', '/info')).data;
assert.equal(initial.ID, authority.engine.id);
await mkdir(input.output, { mode: 0o700 });
const scratch = await mkdtemp('/private/tmp/sdkc-');
const namespacePrefix = `research-concurrency-${randomUUID().slice(0, 8)}-`;
const report = { format: 'agenai.desktop-concurrency-reproduction.v1', startedAt: new Date().toISOString(),
  status: 'running', inputSha256: sha(await readFile(inputPath)), controller: { node: process.version, arch: process.arch },
  packages: [sdk.identity, docker.identity, node.identity], namespacePrefix, originalEndpoint: platform.engine,
  socket: { device: String(socket.dev), inode: String(socket.ino), uid: String(socket.uid), mode: String(socket.mode) },
  engine: { id: initial.ID, kernel: initial.KernelVersion, version: initial.ServerVersion },
  deploymentObservation: input.deploymentObservation, observations: [], hostObservations: [], owners: [], cleanupFailures: [] };
const save = () => writeFile(join(input.output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
let phase = 'initial';
const recorder = await capture({ directory: join(input.output, 'capture'), engine, namespacePrefix, phase: () => phase });
const proxy = await createTraceProxy({ socketPath: join(scratch, 'e.sock'), upstreamEndpoint: platform.engine,
  tracePath: join(input.output, 'engine-trace.jsonl'), observeResponseBody: recorder.observeResponseBody,
  observeUpgrade: recorder.observeUpgrade });
proxy.setRow('desktop-concurrency-research');
const owners = [];
const signal = AbortSignal.timeout(180000);
const observe = async (value) => {
  assert(report.observations.length < 256);
  report.observations.push({ at: new Date().toISOString(), phase, ...value }); await save();
};
async function prepare(label) {
  phase = `prepare-${label}`;
  const directory = join(input.output, label); await mkdir(directory, { mode: 0o700 });
  const spillDirectory = join(directory, 'spill'); await mkdir(spillDirectory, { mode: 0o700 });
  const namespace = `${namespacePrefix}${label}`;
  const routeAuthority = node.api.createDockerDesktopRouteAuthority({ ...authority,
    engine: { ...authority.engine, endpoint: proxy.endpoint } });
  const backend = docker.api.createDockerSandboxBackend({ endpoint: proxy.endpoint, profile: platform.profile, namespace,
    spillDirectory, imageDigest: platform.sourceImage, user: capabilities.workload.user,
    filesystem: capabilities.filesystem.configuration, egress: { ...capabilities.network.egress.configuration, routeAuthority } });
  const request = sdk.api.parseSandboxRequest({ policy: { resources: capabilities.workload.resources,
    temporaryStorage: { homeBytes: capabilities.workload.temporaryBytes, tempBytes: capabilities.workload.temporaryBytes },
    network: { kind: 'restricted_https', destinations: [{ hostname: 'github.com', port: 443 }] },
    files: { kind: 'read_write' }, execution: { kind: 'until_stopped' },
    deadlines: { startupMs: capabilities.limits.startupMs, cleanupMs: capabilities.limits.cleanupMs },
    transfers: sdk.api.SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: sdk.api.SANDBOX_DEFAULT_STREAM_LIMITS } });
  const evidence = { label, namespace, checkpoints: [], initialRecord: null, start: 'pending' };
  let sequence = 0;
  const owner = backend.reserve(request, { kind: 'persisted', async persist(record) {
    const path = join(directory, `checkpoint-${String(++sequence).padStart(4, '0')}.json`);
    const raw = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    assert(sequence <= 256);
    await writeFile(path, raw, { mode: 0o600, flag: 'wx' });
    evidence.checkpoints.push({ path, sha256: sha(raw), phase: record.phase, at: new Date().toISOString() });
    await save();
  } });
  evidence.initialRecord = owner.recoveryRecord;
  owners.push({ owner, evidence }); report.owners.push(evidence); await save();
  try {
    await owner.start({ signal }); evidence.start = 'ready';
    await observe({ kind: 'owner-ready', label, state: owner.state, census: await census(engine, owner.recoveryRecord, `${label}-ready`) });
  } catch (error) { evidence.start = 'failed'; evidence.failure = failure(error); }
  evidence.afterStartRecord = owner.recoveryRecord; evidence.afterStartState = owner.state; await save();
  return { owner, evidence };
}
try {
  await save();
  report.hostObservations.push(await captureHost(authority, input.output, 'before-a'));
  const first = await prepare('a'); assert.equal(first.evidence.start, 'ready', 'First owner must be independently healthy.');
  report.hostObservations.push(await captureHost(authority, input.output, 'a-ready'));
  await delay(1500, undefined, { signal });
  assert.equal(first.owner.state.kind, 'ready');
  const second = await prepare('b');
  phase = 'observe-failure';
  await delay(1500, undefined, { signal });
  await observe({ kind: 'both-owner-results', firstState: first.owner.state, secondState: second.owner.state,
    records: owners.map(({ owner }) => owner.recoveryRecord) });
  report.hostObservations.push(await captureHost(authority, input.output, 'after-b'));
  report.expectedFailureObserved = second.evidence.start === 'failed'
    && /External Desktop Engine network configuration or membership changed|Sealed Desktop.*authority changed|External VM authority changed during the finite owned link-local transition/u.test(JSON.stringify(second.evidence.failure));
  assert(report.expectedFailureObserved, 'The captured attempt did not reproduce the known topology failure.');
} catch (error) { report.failure = failure(error); }
finally {
  phase = 'cleanup';
  for (const { owner, evidence } of [...owners].reverse()) {
    try {
      await settleOwnerCleanup(owner, 'destroy', { cleanupMs: 60000, observe });
      evidence.finalRecord = owner.recoveryRecord; evidence.finalState = owner.state;
      evidence.finalCensus = await census(engine, owner.recoveryRecord, 'research-final-exact-absence', true);
    } catch (error) { report.cleanupFailures.push({ namespace: evidence.namespace, failure: failure(error), record: owner.recoveryRecord }); }
  }
  try { await proxy.close(); } catch (error) { report.cleanupFailures.push(failure(error)); }
  report.capture = await recorder.close();
  try { report.hostObservations.push(await captureHost(authority, input.output, 'after-cleanup')); }
  catch (error) { report.cleanupFailures.push({ hostCapture: failure(error) }); }
  report.finishedAt = new Date().toISOString();
  report.status = report.expectedFailureObserved && !report.failure && !report.cleanupFailures.length
    && report.capture.completeness === 'complete' ? 'reproduced' : 'failed';
  await save();
  if (!report.cleanupFailures.length) await rm(scratch, { recursive: true });
}
process.stdout.write(`${JSON.stringify({ status: report.status, output: input.output,
  starts: report.owners.map(({ label, start }) => ({ label, start })), capture: report.capture,
  cleanupFailures: report.cleanupFailures.length })}\n`);
if (report.status !== 'reproduced') process.exitCode = 1;
