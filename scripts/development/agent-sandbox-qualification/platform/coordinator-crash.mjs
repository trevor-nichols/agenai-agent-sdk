// Installed public crash barrier with a real native holder and an isolated, read-only Engine fixture.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFreeEnvironment } from '../ci-profile.mjs';
import { observeCoordinatorCrash } from './coordinator-crash-process.mjs';
import { boundedFile } from '../native/configuration.mjs';
import { admitOutput } from '../scalability/identity.mjs';
import { absolute, closeEntry, encode, errorEvidence, fileIdentity, installed, installRequestGuard, ownerEntry,
  preparedIdentity, readInput, runtimeIdentity, sourceIdentity, writeReport } from './coordinator-proof.mjs';

const self = fileURLToPath(import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scope = {
  exercised: 'Two independent installed copies, real Darwin arm64 native holder and canonical namespace; SIGKILL of the controller releases live exclusion while its exact dirty generation still blocks activation.',
  engine: 'An owned Unix HTTP fixture with a unique synthetic daemon identity. No real Docker Engine is contacted.',
  excluded: ['Real Engine late effects', 'Member creation and workloads', 'Cleanup-only recovery (MS005)', 'Power-loss durability'],
  retention: 'The synthetic canonical lock and original dirty snapshot remain diagnostic evidence; no coordinator record is deleted or rewritten by the qualifier.',
};

async function crashChild(inputPath) {
  const selected = await readInput(inputPath, ['consumer', 'routeAuthority', 'helper', 'ready']);
  const input = selected.value;
  const ready = absolute(input.ready);
  await assert.rejects(lstat(ready), { code: 'ENOENT' });
  const guard = installRequestGuard(new Set([input.routeAuthority.engine.endpoint.slice(7)]), join(dirname(ready), 'child-requests.jsonl'));
  const loaded = await installed(input.consumer);
  const evidence = { pid: process.pid, input: selected.identity, installed: loaded.identity, source: await sourceIdentity(),
    runtime: await runtimeIdentity(), prepared: await preparedIdentity(input.routeAuthority, input.helper) };
  const entries = [];
  const entry = ownerEntry(loaded.api, input, input.consumer, entries, 'crashed-original');
  await entry.owner.initialize({ timeoutMs: 60_000 });
  const authority = await entry.owner.activate({ timeoutMs: 60_000 });
  // Synchronous evidence and kill keep the crash in the activation continuation, before another health task can enter.
  writeFileSync(ready, encode({ ...evidence, generation: authority.generation, state: entry.owner.state,
    requests: guard.summarize(), intendedSignal: 'SIGKILL' }), { flag: 'wx', mode: 0o600 });
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL unexpectedly returned.');
}

async function fixture(directory, daemonId, requests) {
  const socket = join(directory, 'engine.sock');
  const networkId = 'a'.repeat(64);
  const info = { ID: daemonId, Name: 'isolated-coordinator-crash-fixture', KernelVersion: 'fixture-kernel',
    OSType: 'linux', Architecture: 'aarch64', CgroupVersion: '2', CgroupDriver: 'cgroupfs',
    SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'], OperatingSystem: 'Docker Desktop',
    MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true };
  const replies = new Map([
    ['/version', { Version: '29.1.4', ApiVersion: '1.52', MinAPIVersion: '1.44', Os: 'linux', Arch: 'arm64' }],
    ['/info', info], ['/v1.52/networks', [{ Id: networkId }]],
    [`/v1.52/networks/${networkId}`, { Id: networkId, Name: 'none', Created: '2026-10-29T00:00:00Z',
      Driver: 'null', Scope: 'local', Internal: false, Attachable: false, Ingress: false, EnableIPv6: false,
      ConfigOnly: false, IPAM: { Driver: 'default', Config: null, Options: null }, Options: {}, Labels: {}, Containers: {} }],
  ]);
  const server = http.createServer((request, response) => {
    const admitted = request.method === 'GET' && replies.has(request.url) && requests.length < 1024;
    requests.push({ method: request.method, path: request.url, admitted });
    response.writeHead(admitted ? 200 : 400, { 'content-type': 'application/json' });
    response.end(JSON.stringify(admitted ? replies.get(request.url) : { error: 'Fixture accepts its finite GET protocol only.' }));
  });
  server.on('clientError', (_error, connection) => connection.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  return { endpoint: `unix://${await realpath(socket)}`, async close() {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await assert.rejects(lstat(socket), { code: 'ENOENT' });
  } };
}

async function main(inputPath) {
  const selected = await readInput(inputPath, ['consumers', 'routeAuthority', 'helper', 'output']);
  const input = selected.value;
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert(Array.isArray(input.consumers) && input.consumers.length === 2 && input.consumers[0] !== input.consumers[1]);
  for (const consumer of input.consumers) await admitOutput(absolute(input.output), absolute(consumer));
  await mkdir(input.output, { mode: 0o700 });
  await writeFile(join(input.output, 'input.json'), selected.text, { flag: 'wx', mode: 0o600 });
  const reportPath = join(input.output, 'coordinator-crash-report.json');
  const report = { format: 'agenai.desktop-coordinator-installed-crash.v1', status: 'running', scope,
    input: selected.identity, runtime: await runtimeIdentity(), source: await sourceIdentity(), cases: [],
    fixtureRequests: [], owners: [], cleanupFailures: [], primaryFailure: null };
  const entries = [];
  const directory = await mkdtemp('/private/tmp/agenai-c3-crash-');
  const daemonId = `agenai-ms003-crash-fixture-${randomUUID()}`;
  const key = hash(`agenai.desktop-coordinator.engine.v1\0${daemonId}`);
  const root = join(userInfo().homedir, 'Library/Application Support/AgenAI/sandbox-docker/desktop-coordination-v1');
  const statePath = join(root, `${key}.state`); const lockPath = join(root, `${key}.lock`);
  let engine, guard;
  const save = () => writeReport(reportPath, report);
  try {
    await assert.rejects(lstat(statePath), { code: 'ENOENT' });
    await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
    await assert.rejects(lstat(join(root, `${key}.next`)), { code: 'ENOENT' });
    engine = await fixture(directory, daemonId, report.fixtureRequests);
    const routeAuthority = structuredClone(input.routeAuthority);
    routeAuthority.engine = { id: daemonId, endpoint: engine.endpoint };
    report.fixture = { directory, daemonId, endpoint: engine.endpoint, statePath, lockPath };
    report.prepared = await preparedIdentity(routeAuthority, input.helper);
    guard = installRequestGuard(new Set([engine.endpoint.slice(7)]), join(input.output, 'parent-requests.jsonl'));
    const copies = await Promise.all(input.consumers.map(installed));
    report.installed = copies.map((copy) => copy.identity);
    assert.notEqual(copies[0].identity.entrypoint.path, copies[1].identity.entrypoint.path);
    assert.deepEqual(copies[0].identity.packages, copies[1].identity.packages);
    const childInput = join(input.output, 'child-input.json'), ready = join(input.output, 'child-ready.json');
    await writeFile(childInput, encode({ consumer: input.consumers[0], routeAuthority, helper: input.helper, ready }), { flag: 'wx', mode: 0o600 });
    await mkdir(join(input.output, 'docker-config'), { mode: 0o700 });
    await save();
    let crashed;
    try {
      crashed = await observeCoordinatorCrash({ executable: process.execPath, args: [self, '--child', childInput], cwd: input.consumers[0],
        env: credentialFreeEnvironment(process.env, join(input.output, 'docker-config')), timeoutMs: 90_000 });
    } catch (error) { crashed = error; throw error; }
    finally {
      report.crash = { pid: crashed?.pid, status: crashed?.status, signal: crashed?.signal,
        quiescent: crashed?.quiescent, intervention: crashed?.intervention };
      await writeFile(join(input.output, 'child-stdout.log'), crashed?.stdout ?? '', { flag: 'wx', mode: 0o600 });
      await writeFile(join(input.output, 'child-stderr.log'), crashed?.stderr ?? '', { flag: 'wx', mode: 0o600 });
      await save();
    }
    assert.equal(crashed.status, null); assert.equal(crashed.signal, 'SIGKILL');
    assert.equal(crashed.quiescent, true); assert.equal(crashed.intervention, false);
    const child = JSON.parse((await boundedFile(ready, 4 * 1024 ** 2)).toString('utf8'));
    assert.equal(child.state.kind, 'active'); assert.equal(child.intendedSignal, 'SIGKILL');
    assert.deepEqual(child.installed.packages, copies[0].identity.packages);
    assert.deepEqual(child.source, report.source); assert.deepEqual(child.prepared, report.prepared);
    report.original = { ready: await fileIdentity(ready, 4 * 1024 ** 2), generation: child.generation };
    const bytes = await boundedFile(statePath, 1024 ** 2);
    const framing = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
    assert.equal(framing[0], 'AGENAI-SNAPSHOT-1'); assert.equal(framing[1], key);
    const payload = framing.slice(3).join('\n'); assert.equal(framing[2], hash(payload));
    const snapshot = JSON.parse(payload);
    assert.equal(snapshot.generation.kind, 'dirty'); assert.equal(snapshot.generation.identity.generationId, child.generation);
    assert.deepEqual(snapshot.generation.members, []); assert.deepEqual(snapshot.generation.queue, []); assert.equal(snapshot.generation.entered, null);
    await writeFile(join(input.output, 'original-dirty-state'), bytes, { flag: 'wx', mode: 0o600 });
    report.cases.push({ name: 'crash-releases-live-holder-and-retains-original-dirty-generation', status: 'pass', generation: child.generation });
    for (let index = 0; index < copies.length; index++) {
      const entry = ownerEntry(copies[index].api, { ...input, routeAuthority }, input.consumers[index], entries, `post-crash-${index}`);
      if (index === 1) {
        await entry.owner.initialize({ timeoutMs: 60_000 });
        assert.deepEqual(await readFile(statePath), bytes, 'Explicit initialization must not clear an existing dirty generation.');
      }
      let rejected;
      try { await entry.owner.activate({ timeoutMs: 60_000 }); } catch (error) { rejected = error; }
      assert(rejected && rejected.owner === entry.owner);
      assert.deepEqual(rejected.failure, { kind: 'dirty_generation', generation: child.generation });
      await closeEntry(entry);
      assert.deepEqual(await readFile(statePath), bytes, 'Rejected activation and close must preserve the original dirty bytes.');
      report.cases.push({ name: index === 0 ? 'fresh-controller-dirty-barrier' : 'independent-copy-reinitialize-cannot-clear-dirty-barrier',
        status: 'pass', failure: rejected.failure, unchangedOriginalSnapshot: true });
    }
    assert(report.fixtureRequests.length > 0 && report.fixtureRequests.every((entry) => entry.admitted && entry.method === 'GET'));
    report.retained = { state: await fileIdentity(statePath, 1024 ** 2), lock: await fileIdentity(lockPath, 1024), reason: scope.retention };
    report.status = 'pass';
  } catch (error) {
    report.status = 'fail'; report.primaryFailure = errorEvidence(error);
  }
  finally {
    for (const entry of entries.toReversed()) if (entry.owner.state.kind !== 'closed') {
      try { await closeEntry(entry); } catch (error) { report.cleanupFailures.push(errorEvidence(error)); report.status = 'fail'; }
    }
    report.owners = entries.map((entry) => entry.evidence);
    report.requests = guard?.summarize(); guard?.restore();
    try { if (engine) await engine.close(); await rmdir(directory); report.fixtureClosed = true; }
    catch (error) { report.cleanupFailures.push(errorEvidence(error)); report.status = 'fail'; }
    await save();
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath })}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}

try {
  const args = process.argv.slice(2);
  if (args[0] === '--child') { assert.equal(args.length, 2); await crashChild(absolute(args[1])); }
  else { assert.equal(args.length, 1, 'Usage: node coordinator-crash.mjs /absolute/input.json'); await main(absolute(args[0])); }
} catch (error) { process.stderr.write(`${JSON.stringify({ status: 'fail', failure: errorEvidence(error) })}\n`); process.exitCode = 1; }
