// Bounded read-only actual-Engine identity proof plus isolated local socket replacement controls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as localController from './controller.mjs';
import { prepare } from './prepare.mjs';
import { activateBound, assertBoundObservation, assertSameEndpoint, assertSamePhysicalSocket,
  observeEndpoint, socketIdentity } from './endpoint-binding.mjs';

const frozenInput = process.argv[2] ?? '/Volumes/AGENAI/Qualification/sdk-concurrency/EP-20261029-001/ms001/reproduction-input-r3.json';
const inputBytes = await readFile(frozenInput);
const input = JSON.parse(inputBytes);
const selected = input.platform.engine;
const aliases = [selected, 'unix:///var/run/docker.sock'];
const expected = input.platform.expected.daemon;
assert.equal(selected, 'unix:///Users/tan/.docker/run/docker.sock');
assert.equal(expected.id, input.capabilities.network.routeAuthority.engine.id);
const attempt = await mkdtemp('/private/tmp/agenai-ms001-exclusion-');
const prepared = await prepare(attempt);
const modules = await Promise.all(prepared.copies.map(({ directory }) => import(pathToFileURL(join(directory, 'controller.mjs')).href)));
const holders = new Set();
const servers = new Set();
const actualRequests = [];
const syntheticRequests = [];
const rows = [];
const own = (value) => { holders.add(value.owner.holder); return value; };
const row = async (name, operation) => {
  try { rows.push({ name, result: 'pass', ...await operation() }); }
  catch (error) { rows.push({ name, result: 'fail', error: error.stack }); throw error; }
};
const fakeServer = async (path, id = expected.id) => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    assert.equal(request.method, 'GET');
    if (request.url === '/v1.52/info') response.end(JSON.stringify({ ID: id, ServerVersion: expected.version,
      Architecture: expected.architecture, KernelVersion: expected.kernelVersion, OperatingSystem: expected.operatingSystem }));
    else if (request.url === '/version') response.end(JSON.stringify({ Version: expected.version,
      ApiVersion: expected.apiVersion, Arch: expected.architecture, Os: 'linux' }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  servers.add(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return server;
};

try {
  let observations;
  await row('existing selected and /var/run aliases resolve one actual physical socket and daemon', async () => {
    observations = await Promise.all(aliases.map((endpoint) => observeEndpoint(endpoint, expected, actualRequests)));
    assertSamePhysicalSocket(observations[0].filesystem, observations[1].filesystem);
    assert.deepEqual(observations[0].engine, observations[1].engine);
    const keys = modules.flatMap((module) => observations.map((value) => module.engineKey(value.engine.id)));
    assert.equal(new Set(keys).size, 1);
    return { observations, exclusionKeyAcrossCopiesAndAliases: keys[0] };
  });

  await row('selected alias native holder excludes copied Rosetta helper using actual observed daemon ID', async () => {
    const current = own(await activateBound(modules[0], prepared.copies[0].binary, aliases[0], expected,
      { namespace: 'physical-native', profile: 'native-arm64' }, actualRequests));
    await assert.rejects(activateBound(modules[1], prepared.translatedBinary, aliases[1], expected,
      { namespace: 'physical-rosetta', profile: 'rosetta-amd64', journalRoot: '/not-authority' }, actualRequests), /contended/);
    const journal = localController.parseJournal((await current.owner.holder.command('SNAPSHOT')).text);
    assert.deepEqual(journal.record.configuration.originalEndpointBinding.filesystem, current.before.filesystem);
    await current.owner.clean();
    await current.owner.holder.close();
    return { beforeAcquire: current.before, afterAcquire: current.after,
      nativeJournalIdentity: current.owner.holder.identity, losingAlias: aliases[1], engineMutations: 0 };
  });

  await row('/var/run alias Rosetta holder excludes copied native helper and preserves physical identity', async () => {
    const current = own(await activateBound(modules[1], prepared.translatedBinary, aliases[1], expected,
      { namespace: 'physical-rosetta', profile: 'rosetta-amd64' }, actualRequests));
    await assert.rejects(activateBound(modules[0], prepared.copies[0].binary, aliases[0], expected,
      { namespace: 'physical-native', profile: 'native-arm64' }, actualRequests), /contended/);
    assertSamePhysicalSocket(current.after.filesystem, observations[0].filesystem);
    await current.owner.clean();
    await current.owner.holder.close();
    return { beforeAcquire: current.before, afterAcquire: current.after,
      translatedJournalIdentity: current.owner.holder.identity, losingAlias: aliases[0], engineMutations: 0 };
  });

  await row('isolated listener inode replacement with unchanged daemon ID is refused after native acquisition', async () => {
    const path = join(attempt, 'synthetic-engine.sock');
    await fakeServer(path);
    const endpoint = `unix://${path}`;
    const before = await observeEndpoint(endpoint, expected, syntheticRequests);
    const owner = await modules[0].activate(prepared.copies[0].binary, before.engine.id,
      { namespace: 'replacement-negative', originalEndpointBinding: before });
    holders.add(owner.holder);
    await rename(path, `${path}.retained-original`);
    await fakeServer(path);
    const after = await observeEndpoint(endpoint, expected, syntheticRequests);
    assert.deepEqual(before.engine, after.engine);
    assert.notEqual(before.filesystem.socket.inode, after.filesystem.socket.inode);
    assert.throws(() => assertBoundObservation(before, after), /endpoint_replaced/);
    await owner.holder.close();
    await assert.rejects(modules[1].activate(prepared.translatedBinary, expected.id, { namespace: 'new-root-metadata' }), /dirty_generation/);
    return { before, after, engineIdAloneWouldMatch: true, memberEffects: 0, dirtyGenerationRetained: owner.record.generation,
      scope: 'replacement is confined to this attempt scratch; actual aliases/listener are untouched' };
  });

  await row('isolated alias inode replacement to same physical listener is refused', async () => {
    const target = join(attempt, 'synthetic-alias-target.sock');
    const alias = join(attempt, 'synthetic-alias.sock');
    await fakeServer(target);
    await symlink(target, alias);
    const before = await socketIdentity(`unix://${alias}`);
    await rename(alias, `${alias}.retained-original`);
    await symlink(target, alias);
    const after = await socketIdentity(`unix://${alias}`);
    assertSamePhysicalSocket(before, after);
    assert.throws(() => assertSameEndpoint(before, after), /endpoint_replaced/);
    return { before, after, physicalListenerUnchanged: true, aliasIncarnationChanged: true };
  });

  await row('isolated daemon-ID substitution is refused before native claim acquisition', async () => {
    const path = join(attempt, 'synthetic-foreign-engine.sock');
    await fakeServer(path, 'different-daemon-id');
    await assert.rejects(activateBound(modules[0], prepared.copies[0].binary, `unix://${path}`, expected,
      { namespace: 'foreign-daemon' }, syntheticRequests), /engine_identity_conflict/);
    return { mismatchedId: 'different-daemon-id', nativeClaimEntered: false, memberEffects: 0 };
  });

  await row('actual admitted aliases and daemon remain unchanged after isolated negative controls', async () => {
    const final = await Promise.all(aliases.map((endpoint) => observeEndpoint(endpoint, expected, actualRequests)));
    for (const [index, value] of final.entries()) assertBoundObservation(observations[index], value);
    return { observations: final };
  });
} finally {
  for (const holder of holders) holder.child.kill('SIGKILL');
  await Promise.all([...holders].map((holder) => holder.ended));
  // Close listeners before deleting scratch pathnames; no real Docker path is ever passed here.
  await Promise.all([...servers].reverse().map((server) => new Promise((resolve) => server.close(resolve))));
  for (const name of ['synthetic-engine.sock.retained-original', 'synthetic-alias.sock', 'synthetic-alias.sock.retained-original']) {
    await rm(join(attempt, name), { force: true });
  }
  const sources = Object.fromEntries(await Promise.all(['lock-holder.c', 'controller.mjs', 'prepare.mjs',
    'endpoint-binding.mjs', 'run-endpoint-binding.mjs'].map(async (name) => [name,
    createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])));
  const report = { researchOnly: true, attempt, at: new Date().toISOString(), platform: process.platform,
    architecture: process.arch, node: process.version, frozenInput,
    frozenInputSha256: createHash('sha256').update(inputBytes).digest('hex'), selectedAliases: aliases,
    expectedEngine: expected, sources, sourceDigestEncoding: 'SHA-256 of raw file bytes',
    command: [process.execPath, ...process.argv.slice(1)],
    binaries: spawnSync('/usr/bin/file', [prepared.binary, prepared.translatedBinary], { encoding: 'utf8' }).stdout.trim(),
    actualRequests, syntheticRequests, dockerMutations: 0, actualSocketMutations: 0,
    productionAuthorityRootTouched: false, rows };
  await writeFile(join(attempt, 'endpoint-binding-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ attempt, passed: rows.filter((entry) => entry.result === 'pass').length,
    failed: rows.filter((entry) => entry.result === 'fail').length, actualDockerGetRequests: actualRequests.length,
    report: join(attempt, 'endpoint-binding-report.json') }, null, 2)}\n`);
}
