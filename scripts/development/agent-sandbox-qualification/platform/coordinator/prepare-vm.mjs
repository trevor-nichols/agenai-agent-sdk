import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../engine.mjs';
import { absolute, Evidence, failure, sha } from './evidence.mjs';
import { originalFile } from '../coordinator-recovery/common.mjs';
import { profiles } from '../configuration.mjs';
import { parseScenario } from './configuration.mjs';

const purpose = 'Explicit caller-owned networkless VM preparation before coordinated baseline capture. Existing pinned image only; no pull, mount, credential, SDK call, automatic retry or external-baseline replacement.';

function desktopProfile(name) {
  assert(Object.hasOwn(profiles, name) && profiles[name].os === 'darwin', 'Explicit admitted Desktop profile required.');
  return profiles[name];
}

export async function prepareVm({ engine, platform, evidence, report }) {
  const profile = desktopProfile(platform.profile);
  const expected = platform.expected.daemon;
  assert.match(platform.sourceImage, /^sha256:[a-f0-9]{64}$/u);
  const name = `ms005-vm-prepare-${randomUUID()}`;
  const labels = { 'ai.agen.qualification.owner': name, 'ai.agen.qualification.purpose': 'explicit-vm-wake' };
  Object.assign(report, { name, labels, image: platform.sourceImage, id: null, requests: [], scope: purpose, cleanup: 'not_created' });
  async function request(method, path, body, allowed) {
    assert(report.requests.length < 24, 'Explicit preparation HTTP request budget exhausted.');
    const sequence = report.requests.length + 1;
    const entry = { sequence, method, path, dispatchedAt: new Date().toISOString(),
      intent: await evidence.file(`http-${String(sequence).padStart(2, '0')}-request.json`, { method, path, body: body ?? null }),
      status: null, response: null, failure: null };
    report.requests.push(entry);
    try {
      const actual = await engine.request(method, path, body, { allowed: Array.from({ length: 500 }, (_, index) => index + 100), binary: true });
      entry.status = actual.status; entry.response = await evidence.file(`http-${String(sequence).padStart(2, '0')}-body.bin`, actual.data, 1024 ** 2);
      entry.finishedAt = new Date().toISOString();
      assert((allowed ?? [200, 201, 204]).includes(actual.status), `Explicit preparation ${method} ${path} returned ${actual.status}.`);
      return { status: actual.status, data: actual.data.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(actual.data)) : null };
    } catch (error) { entry.failure = failure(error); entry.finishedAt = new Date().toISOString(); throw error; }
  }
  async function identity() {
    const actual = (await request('GET', '/info')).data;
    assert.equal(actual.ID, expected.id); assert.equal(actual.KernelVersion, expected.kernelVersion);
    return { id: actual.ID, kernelVersion: actual.KernelVersion, systemTime: actual.SystemTime };
  }
  async function inspect() {
    const actual = (await request('GET', `/containers/${report.id}/json`)).data;
    assert.equal(actual.Id, report.id); assert.equal(actual.Name, `/${name}`);
    assert.equal(actual.Config.Image, platform.sourceImage); assert.equal(actual.HostConfig.NetworkMode, 'none');
    assert.equal(actual.HostConfig.ReadonlyRootfs, true); assert.deepEqual(actual.Mounts, []);
    for (const [key, value] of Object.entries(labels)) assert.equal(actual.Config.Labels[key], value);
    return actual;
  }
  async function remove() {
    if (!report.id || report.cleanup === 'confirmed_absent') return;
    await inspect();
    await request('DELETE', `/containers/${report.id}?force=true&v=false`);
    report.cleanup = 'delete_acknowledged';
    report.absence = [];
    for (const reference of [report.id, name]) {
      const absent = await request('GET', `/containers/${reference}/json`, undefined, [404]);
      report.absence.push({ reference, status: absent.status });
    }
    report.cleanup = 'confirmed_absent';
  }
  report.before = await identity();
  const image = (await request('GET', `/images/${encodeURIComponent(platform.sourceImage)}/json`)).data;
  assert.equal(image.Id, platform.sourceImage, 'Explicit preparation image identity differs from the selected source.');
  assert.equal(image.Os, 'linux', 'Explicit preparation Linux image required.');
  assert.equal(image.Architecture, profile.imageArchitecture, 'Explicit preparation image architecture differs from the selected profile.');
  assert.equal(Object.keys(image.Config?.Volumes ?? {}).length, 0, 'Explicit preparation image must not declare volumes.');
  let primary;
  try {
    const body = { Image: platform.sourceImage, User: '10000:10000', Entrypoint: ['/usr/local/bin/node'],
      Cmd: ['-e', 'process.stdout.write("explicit-vm-preparation-complete\\n")'], Env: ['LANG=C'], Labels: labels,
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
        PidsLimit: 32, Memory: 128 * 1024 ** 2, NanoCpus: 250_000_000, LogConfig: { Type: 'none', Config: {} } } };
    report.cleanup = 'create_dispatched_outcome_unknown';
    const created = await request('POST', `/containers/create?name=${name}&platform=${encodeURIComponent(`linux/${profile.imageArchitecture}`)}`, body);
    assert.match(created.data.Id, /^[a-f0-9]{64}$/u); report.id = created.data.Id; report.cleanup = 'owned';
    assert.equal((await inspect()).State.Running, false);
    await request('POST', `/containers/${report.id}/start`);
    const waited = await request('POST', `/containers/${report.id}/wait?condition=not-running`);
    assert.equal(waited.data.StatusCode, 0); assert.equal(waited.data.Error?.Message ?? '', '');
    const stopped = await inspect(); assert.equal(stopped.State.Running, false); assert.equal(stopped.State.ExitCode, 0);
    report.completedAt = new Date().toISOString();
  } catch (error) { primary = error; throw error; }
  finally {
    try { await remove(); report.after = await identity(); }
    catch (error) {
      report.cleanupFailure = failure(error);
      if (!primary) throw error;
    }
  }
  assert.equal(report.cleanup, 'confirmed_absent');
}

async function main(inputPath, output) {
  const selected = await originalFile(absolute(inputPath), 1024 ** 2); absolute(output);
  const input = selected.value;
  absolute(input.consumer); absolute(input.output);
  assert(output !== input.output && !output.startsWith(`${input.output}/`) && !input.output.startsWith(`${output}/`));
  assert(output !== input.consumer && !output.startsWith(`${input.consumer}/`) && !input.consumer.startsWith(`${output}/`));
  assert.deepEqual(Object.keys(input).sort(), ['consumer', 'output', 'platform', 'capabilities', 'deploymentObservation', 'helper',
    ...(input.scenario === undefined ? [] : ['scenario']), ...(input.vmPreparation === undefined ? [] : ['vmPreparation'])].sort());
  const scenario = parseScenario(input.scenario);
  if (scenario.kind === 'ms004') assert.equal(input.vmPreparation, undefined); else absolute(input.vmPreparation);
  desktopProfile(input.platform.profile);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.versions.node, input.platform.expected.controller.nodeVersion);
  assert.match(input.platform.engine, /^unix:\/\/\//u);
  assert.equal(await realpath(dirname(output)), dirname(output));
  const socketPath = input.platform.engine.slice(7); const socket = await lstat(socketPath, { bigint: true }); assert(socket.isSocket());
  const evidence = new Evidence(output); await evidence.initialize(selected.bytes);
  const report = { format: 'agenai.desktop-coordinator-explicit-vm-preparation.v1', status: 'running',
    input: selected.identity, endpoint: input.platform.engine, startedAt: new Date().toISOString(),
    runtime: { executable: process.execPath, node: process.versions.node, platform: process.platform, arch: process.arch, pid: process.pid },
    socket: { device: String(socket.dev), inode: String(socket.ino) }, sources: [], failure: null };
  try {
    for (const [index, name] of ['prepare-vm.mjs', 'configuration.mjs', 'evidence.mjs', '../coordinator-recovery/common.mjs',
      '../coordinator-recovery/canonical.mjs', '../../engine.mjs', '../configuration.mjs', '../../native/configuration.mjs',
      '../capabilities/input.mjs', '../capabilities/manifest.mjs', '../capabilities/authority.mjs', '../capabilities/validation.mjs',
      '../capabilities/concurrency/manifest.mjs', '../capabilities/concurrency/cases.mjs', '../capabilities/concurrency/budget.mjs'].entries()) {
      const original = fileURLToPath(new URL(name, import.meta.url)); const bytes = await readFile(original);
      assert.equal(await realpath(original), original);
      report.sources.push({ original, ...await evidence.file(`sources/${index}-${name.split('/').at(-1)}`, bytes, 1024 ** 2) });
    }
    await prepareVm({ engine: new Engine(socketPath, '1.52', { requestMs: 60_000, outputBytes: 1024 ** 2 }), platform: input.platform, evidence, report });
    assert.equal(sha(await readFile(inputPath)), selected.identity.sha256);
    for (const source of report.sources) assert.equal(sha(await readFile(source.original)), source.sha256);
    report.status = 'pass';
  } catch (error) { report.status = 'retained_preparation_failure'; report.failure = failure(error); }
  finally { report.finishedAt = new Date().toISOString(); await evidence.file('report.json', report); await evidence.close(); }
  process.stdout.write(`${JSON.stringify({ status: report.status, output, id: report.id, cleanup: report.cleanup })}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { assert.equal(process.argv.length, 4, 'Usage: node prepare-vm.mjs /absolute/desktop-input.json /absolute/output'); await main(...process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: 'fail', failure: failure(error) })}\n`); process.exitCode = 1; }
}
