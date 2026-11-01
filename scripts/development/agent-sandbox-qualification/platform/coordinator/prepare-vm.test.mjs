import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Engine } from '../../engine.mjs';
import { Evidence } from './evidence.mjs';
import { prepareVm } from './prepare-vm.mjs';

async function fixture({ wrongAbsence = false, loseCreate = false,
  profile = 'desktop-apple-virtualization-native-arm64', imageArchitecture = 'arm64', image = {} } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-pv-'))); const socketPath = join(directory, 'e.sock');
  const evidence = new Evidence(join(directory, 'out')); await evidence.initialize(Buffer.from('{}'));
  const requests = []; const id = 'b'.repeat(64); let created = null; let name; let removed = false;
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk; assert(raw.length <= 16 * 1024);
    const body = raw ? JSON.parse(raw) : null; const path = new URL(request.url, 'http://fixture.invalid');
    requests.push({ method: request.method, path: request.url, body });
    let value; let status = 200;
    if (path.pathname === '/v1.52/info') value = { ID: 'original-daemon', KernelVersion: 'original-kernel', SystemTime: new Date().toISOString() };
    else if (path.pathname.startsWith('/v1.52/images/')) value = {
      Id: `sha256:${'c'.repeat(64)}`, Os: 'linux', Architecture: imageArchitecture, Config: { Volumes: null }, ...image };
    else if (path.pathname === '/v1.52/containers/create') {
      assert.equal(request.method, 'POST'); created = body; name = path.searchParams.get('name'); status = 201;
      if (loseCreate) { request.socket.destroy(); return; }
      value = { Id: id, Warnings: [] };
    } else if (request.method === 'DELETE') { removed = true; status = 204; }
    else if (path.pathname.endsWith('/start')) status = 204;
    else if (path.pathname.endsWith('/wait')) value = { StatusCode: 0 };
    else if (removed) { status = wrongAbsence ? 200 : 404; value = { message: 'NO SUCH OBJECT: arbitrary original daemon wording' }; }
    else value = { Id: id, Name: `/${name}`, Config: { Image: created.Image, Labels: created.Labels }, Mounts: [],
      HostConfig: { NetworkMode: created.HostConfig.NetworkMode, ReadonlyRootfs: created.HostConfig.ReadonlyRootfs }, State: { Running: false, ExitCode: 0 } };
    response.statusCode = status; response.end(value === undefined ? undefined : JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const report = {}; const platform = { profile, sourceImage: `sha256:${'c'.repeat(64)}`,
    expected: { daemon: { id: 'original-daemon', kernelVersion: 'original-kernel' } } };
  return { directory, socketPath, requests, report, platform, evidence, engine: new Engine(socketPath, '1.52', { requestMs: 1000 }),
    async close() { await evidence.close(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); } };
}

test('explicit preparation selects each Desktop image platform, retains original HTTP bytes and proves exact ID/name absence without CLI wording', async (t) => {
  for (const [profile, imageArchitecture, imagePlatform] of [
    ['desktop-apple-virtualization-native-arm64', 'arm64', 'linux/arm64'],
    ['desktop-apple-virtualization-rosetta-amd64', 'amd64', 'linux/amd64'],
  ]) await t.test(profile, async () => {
    const owned = await fixture({ profile, imageArchitecture });
    try {
      await prepareVm(owned);
      const { report, requests } = owned; assert.equal(report.cleanup, 'confirmed_absent'); assert.equal(report.before.id, report.after.id);
      assert.deepEqual(report.absence, [{ reference: report.id, status: 404 }, { reference: report.name, status: 404 }]);
      const creates = requests.filter(({ method, path }) => method === 'POST' && path.includes('/create?'));
      assert.equal(creates.length, 1); assert.equal(new URL(creates[0].path, 'http://fixture.invalid').searchParams.get('platform'), imagePlatform);
      assert.equal(creates[0].body.Image, owned.platform.sourceImage); assert.equal(report.image, owned.platform.sourceImage);
      assert.equal(creates[0].body.HostConfig.NetworkMode, 'none');
      assert.equal(creates[0].body.HostConfig.ReadonlyRootfs, true); assert.equal(creates[0].body.User, '10000:10000');
      assert.deepEqual(creates[0].body.Entrypoint, ['/usr/local/bin/node']); assert.deepEqual(creates[0].body.HostConfig.CapDrop, ['ALL']);
      assert.equal(requests.filter(({ method }) => method === 'DELETE').length, 1);
      assert.deepEqual(requests.filter(({ path }) => path.includes('/images/')), [
        { method: 'GET', path: `/v1.52/images/${encodeURIComponent(owned.platform.sourceImage)}/json`, body: null },
      ]);
      assert(requests.every(({ path }) => !path.includes('/exec') && !path.includes('/archive')));
      for (const request of report.requests) {
        const bytes = await readFile(request.response.path); assert.equal(bytes.length, request.response.bytes); assert.equal(request.failure, null);
      }
    } finally { await owned.close(); }
  });
});

test('native Darwin arm64 CLI admits the existing Rosetta input and writes its exact preparation receipt', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const owned = await fixture({ profile: 'desktop-apple-virtualization-rosetta-amd64', imageArchitecture: 'amd64' });
  try {
    const inputPath = join(owned.directory, 'input.json'), output = join(owned.directory, 'cli-preparation');
    await writeFile(inputPath, JSON.stringify({ consumer: join(owned.directory, 'consumer'), output: join(owned.directory, 'campaign'),
      platform: { ...owned.platform, engine: `unix://${owned.socketPath}`, expected: { ...owned.platform.expected,
        controller: { nodeVersion: process.versions.node } } }, capabilities: {}, deploymentObservation: {}, helper: {} }));
    const execute = promisify(execFile);
    const actual = await execute(process.execPath, [fileURLToPath(new URL('./prepare-vm.mjs', import.meta.url)), inputPath, output], { env: {} });
    assert.equal(actual.stderr, '');
    assert.deepEqual(JSON.parse(actual.stdout), { status: 'pass', output, id: 'b'.repeat(64), cleanup: 'confirmed_absent' });
    const receipt = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(receipt.format, 'agenai.desktop-coordinator-explicit-vm-preparation.v1');
    assert.equal(receipt.image, owned.platform.sourceImage); assert.equal(receipt.endpoint, `unix://${owned.socketPath}`);
    assert.deepEqual(receipt.absence, [{ reference: receipt.id, status: 404 }, { reference: receipt.name, status: 404 }]);
    const create = owned.requests.find(({ method, path }) => method === 'POST' && path.includes('/create?'));
    assert.equal(new URL(create.path, 'http://fixture.invalid').searchParams.get('platform'), 'linux/amd64');
    assert.equal(create.body.Image, owned.platform.sourceImage);
  } finally { await owned.close(); }
});

test('explicit preparation rejects a mismatched or mounting source image before container effects', async (t) => {
  for (const [name, options, message] of [
    ['native with amd64 image', { imageArchitecture: 'amd64' }, /image architecture differs/u],
    ['Rosetta with arm64 image', { profile: 'desktop-apple-virtualization-rosetta-amd64' }, /image architecture differs/u],
    ['replaced image ID', { image: { Id: `sha256:${'d'.repeat(64)}` } }, /image identity differs/u],
    ['non-Linux image', { image: { Os: 'windows' } }, /Linux image required/u],
    ['declared volume', { image: { Config: { Volumes: { '/data': {} } } } }, /must not declare volumes/u],
  ]) await t.test(name, async () => {
    const owned = await fixture(options);
    try {
      await assert.rejects(prepareVm(owned), message);
      assert.equal(owned.report.cleanup, 'not_created'); assert.equal(owned.report.id, null);
      assert.deepEqual(owned.requests, [
        { method: 'GET', path: '/v1.52/info', body: null },
        { method: 'GET', path: `/v1.52/images/${encodeURIComponent(owned.platform.sourceImage)}/json`, body: null },
      ]);
      const inspected = owned.report.requests[1]; assert.equal(inspected.status, 200);
      const image = JSON.parse(await readFile(inspected.response.path, 'utf8'));
      assert.deepEqual(image, { Id: owned.platform.sourceImage, Os: 'linux', Architecture: options.imageArchitecture ?? 'arm64',
        Config: { Volumes: null }, ...options.image });
    } finally { await owned.close(); }
  });
});

test('explicit preparation rejects profiles outside the admitted Desktop mapping before Engine access', async (t) => {
  for (const profile of ['linux-x64', 'desktop-other-arm64', 'toString', undefined]) await t.test(String(profile), async () => {
    const owned = await fixture(); owned.platform.profile = profile;
    try {
      await assert.rejects(prepareVm(owned), /admitted Desktop profile required/u);
      assert.deepEqual(owned.requests, []); assert.deepEqual(owned.report, {});
    } finally { await owned.close(); }
  });
});

test('successful delete acknowledgement without both exact 404s remains a captured preparation failure', async () => {
  const owned = await fixture({ wrongAbsence: true });
  try {
    await assert.rejects(prepareVm(owned), /returned 200/u); assert.equal(owned.report.cleanup, 'delete_acknowledged');
    const rejected = owned.report.requests.find(({ failure }) => failure); assert.equal(rejected.status, 200);
    assert.match((await readFile(rejected.response.path)).toString('utf8'), /arbitrary original daemon wording/u);
  } finally { await owned.close(); }
});

test('lost original create acknowledgement is not retried or cleaned using a guessed ID', async () => {
  const owned = await fixture({ loseCreate: true });
  try {
    await assert.rejects(prepareVm(owned)); assert.equal(owned.report.id, null);
    assert.equal(owned.report.cleanup, 'create_dispatched_outcome_unknown');
    assert.equal(owned.requests.filter(({ path }) => path.includes('/create?')).length, 1);
    assert.equal(owned.requests.filter(({ method }) => method === 'DELETE').length, 0);
    assert.equal(owned.report.requests.find(({ method }) => method === 'POST').response, null);
  } finally { await owned.close(); }
});
