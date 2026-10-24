// ------------------------------------------------------------------------------------------------
//                prepare-fixture.test.mjs - CLI preparation identity and failure ownership regressions
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const runner = new URL('./prepare-fixture.mjs', import.meta.url).pathname;
const containerId = 'd'.repeat(64);
const imageId = `sha256:${'e'.repeat(64)}`;
const explicitSourceImage = `sha256:${'f'.repeat(64)}`;

const dockerFixture = `#!${process.execPath}
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.shift() !== '--host' || args.shift() !== 'unix:///explicit/fixture.sock') throw new Error('Explicit endpoint was lost.');
const defaultSource = 'sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const source = process.env.SOURCE_IMAGE ?? defaultSource;
const containerId = '${containerId}';
const imageId = '${imageId}';
const statePath = process.env.STATE;
const output = process.env.OUTPUT;
const scenario = process.env.SCENARIO;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { calls: [], container: null, image: null };
let report;
try { report = JSON.parse(readFileSync(join(output, 'preparation.json'), 'utf8')); } catch {}
state.calls.push({ args, report });
const save = () => writeFileSync(statePath, JSON.stringify(state));
const print = (object) => { save(); console.log(JSON.stringify([object])); };
const fail = (message) => { save(); console.error(message); process.exit(1); };
const breakReport = () => { rmSync(join(output, 'preparation.json')); mkdirSync(join(output, 'preparation.json')); };
if (args[0] === 'image' && args[1] === 'inspect' && args[2] === source) {
  const volumes = scenario === 'unsupported-volumes' ? { '/unqualified': {} } : source === defaultSource ? { '/var/lib/postgresql/data': {} } : {};
  print({ Id: source, Os: 'linux', Architecture: scenario === 'arm64' ? 'arm64' : 'amd64', Config: { Volumes: volumes } });
} else if (args[0] === 'container' && args[1] === 'create') {
  const name = args[args.indexOf('--name') + 1];
  const operationId = args[args.indexOf('--label') + 1].split('=')[1];
  state.container = scenario === 'absent-create' ? null : {
    Id: containerId, Name: '/' + name, Image: source,
    Config: { Labels: { 'org.agenai.sandbox.preparation': scenario === 'conflicting-create' ? 'someone-else' : operationId } },
  };
  if (scenario === 'lost-create' || scenario === 'absent-create' || scenario === 'conflicting-create') fail('create reply lost');
  save();
  if (scenario === 'persist-after-create') breakReport();
  console.log(containerId);
} else if (args[0] === 'container' && args[1] === 'inspect') {
  if (!state.container) fail('Error: No such container: ' + args[2]);
  print(state.container);
} else if (args[0] === 'container' && args[1] === 'export') {
  if (scenario === 'export-primary-and-final-persist') fail('export primary failure');
  const archive = args[args.indexOf('--output') + 1];
  if (scenario === 'dataset-collision') {
    const staging = join(output, 'source-fixture');
    mkdirSync(join(staging, 'agenai-qualification-dataset'), { recursive: true });
    writeFileSync(join(staging, 'agenai-qualification-dataset', 'foreign.txt'), 'source-owned bytes');
    execFileSync('tar', ['-cf', archive, '-C', staging, 'agenai-qualification-dataset']);
  } else writeFileSync(archive, Buffer.alloc(1024));
  save();
} else if (args[0] === 'image' && args[1] === 'import') {
  const archive = args.at(-2);
  state.datasetContents = execFileSync('tar', ['-xOf', archive, 'agenai-qualification-dataset/manifest.txt'], { encoding: 'utf8' });
  state.archiveMembers = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\\n');
  const extraction = join(output, 'import-observed'); mkdirSync(extraction);
  execFileSync('tar', ['-xpf', archive, '-C', extraction]);
  const dataset = join(extraction, 'agenai-qualification-dataset');
  state.datasetEscape = readlinkSync(join(dataset, 'escape'));
  state.datasetModes = { directory: statSync(dataset).mode & 511, file: statSync(join(dataset, 'manifest.txt')).mode & 511 };
  const label = args.find((arg) => arg.startsWith('LABEL org.agenai.sandbox.preparation='));
  const operationId = label.slice(label.indexOf('=') + 1);
  state.image = { Id: imageId, Os: 'linux', Architecture: args[args.indexOf('--platform') + 1].slice(6), Config: { Labels: {
    'org.agenai.sandbox.preparation': operationId, 'org.agenai.sandbox.source': source,
  } } };
  if (scenario === 'lost-import') fail('import reply lost');
  save(); console.log(imageId);
} else if (args[0] === 'image' && args[1] === 'inspect') {
  if (!state.image) fail('Error: No such image: ' + args[2]);
  print(state.image);
} else if (args[0] === 'container' && args[1] === 'rm') {
  if (args.length !== 4 || args[2] !== '--force' || args[3] !== containerId) throw new Error('Cleanup must use the exact acquired container ID.');
  state.container = null;
  save();
  if (scenario === 'export-primary-and-final-persist') breakReport();
  console.log(containerId);
} else throw new Error('Unexpected Docker CLI effect: ' + JSON.stringify(args));
`;

async function runFixture(scenario, inspect, sourceImage, architecture) {
  const parent = await mkdtemp(join(tmpdir(), 'agenai-prepare-test-'));
  const binary = join(parent, 'bin');
  const output = join(parent, 'evidence');
  const statePath = join(parent, 'state.json');
  await mkdir(binary);
  await writeFile(join(binary, 'docker'), dockerFixture);
  await chmod(join(binary, 'docker'), 0o700);
  await writeFile(statePath, JSON.stringify({ calls: [], container: null, image: null }));
  try {
    const result = await execute(process.execPath, [runner, '--engine', 'unix:///explicit/fixture.sock', '--output', output,
      ...(sourceImage === undefined ? [] : ['--source-image', sourceImage]), ...(architecture === undefined ? [] : ['--architecture', architecture])], {
      env: { PATH: [binary, '/usr/bin', '/bin'].join(delimiter), SCENARIO: scenario, STATE: statePath, OUTPUT: output,
        ...(sourceImage === undefined ? {} : { SOURCE_IMAGE: sourceImage }) }, timeout: 10_000,
    }).then((value) => ({ ...value, code: 0 }), (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    let report;
    try { report = JSON.parse(await readFile(join(output, 'preparation.json'), 'utf8')); } catch {}
    await inspect({ result, state, report });
  } finally { await rm(parent, { recursive: true, force: true }); }
}

test('preparation records both planned identities before create and retains only the verified fixture image', async () => {
  await runFixture('success', ({ result, state, report }) => {
    assert.equal(result.code, 0, result.stderr);
    const create = state.calls.find(({ args }) => args[1] === 'create');
    assert.equal(create.report.plannedContainerName, create.args[create.args.indexOf('--name') + 1]);
    assert.equal(create.report.imageTag, `agenai-sandbox-fixture:${create.report.operationId}`);
    assert.equal(create.report.containerAcquisition, 'uncertain');
    assert.equal(create.args[create.args.indexOf('--tmpfs') + 1], '/var/lib/postgresql/data:rw,size=1048576');
    const imported = state.calls.find(({ args }) => args[1] === 'import');
    assert.equal(imported.args.at(-1), imported.report.imageTag);
    assert.equal(imported.report.imageAcquisition, 'uncertain');
    assert.equal(report.container, containerId);
    assert.equal(report.containerRemoved, true);
    assert.equal(state.container, null);
    assert.equal(report.image, imageId);
    assert.equal(state.image.Id, imageId);
    assert.equal(report.primaryFailure, null);
    assert.equal(report.cleanupFailure, null);
    assert.deepEqual(report.evidenceFailures, []);
    const expectedDataset = 'AgenAI immutable dataset fixture v1\nExact bytes shared across private workspaces.\n';
    assert.equal(state.datasetContents, expectedDataset);
    assert.deepEqual(state.archiveMembers.sort(), ['agenai-qualification-dataset/', 'agenai-qualification-dataset/escape', 'agenai-qualification-dataset/manifest.txt']);
    assert.equal(state.datasetEscape, '/etc');
    assert.deepEqual(state.datasetModes, { directory: 0o777, file: 0o666 });
    assert.deepEqual(report.datasetFixture, { subpath: 'agenai-qualification-dataset', path: 'manifest.txt', byteLength: Buffer.byteLength(expectedDataset),
      sha256: createHash('sha256').update(expectedDataset).digest('hex') });
  });
});

test('an explicit exact local image without volumes prepares with its own source identity and no inferred mounts', async () => {
  await runFixture('success', ({ result, state, report }) => {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.sourceImage, explicitSourceImage);
    const create = state.calls.find(({ args }) => args[1] === 'create');
    assert.equal(create.args.at(-3), explicitSourceImage);
    assert.equal(create.args.includes('--tmpfs'), false);
    const imported = state.calls.find(({ args }) => args[1] === 'import');
    assert.equal(imported.args.includes(`LABEL org.agenai.sandbox.source=${explicitSourceImage}`), true);
    assert.equal(state.image.Config.Labels['org.agenai.sandbox.source'], explicitSourceImage);
    assert.equal(report.image, imageId);
    assert.equal(report.containerRemoved, true);
  }, explicitSourceImage);
});

test('an existing dataset root rejects before image import and never overwrites borrowed source contents', async () => {
  await runFixture('dataset-collision', ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /already contains the reserved qualification dataset path/u);
    assert.equal(state.calls.some(({ args }) => args[0] === 'image' && args[1] === 'import'), false);
    assert.equal(report.containerRemoved, true);
    assert.equal(state.container, null);
    assert.equal(report.imageAcquisition, 'planned');
  }, explicitSourceImage);
});

test('arm64 preparation requests that exact create/import platform and rejects an amd64 source before create', async () => {
  await runFixture('arm64', ({ result, state, report }) => {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.architecture, 'arm64');
    assert.equal(state.image.Architecture, 'arm64');
    for (const operation of ['create', 'import']) {
      const call = state.calls.find(({ args }) => args[1] === operation);
      assert.equal(call.args[call.args.indexOf('--platform') + 1], 'linux/arm64');
    }
    assert.equal(report.containerRemoved, true);
  }, explicitSourceImage, 'arm64');
  await runFixture('success', ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /qualified image identity/u);
    assert.deepEqual(state.calls.map(({ args }) => args), [['image', 'inspect', explicitSourceImage]]);
  }, explicitSourceImage, 'arm64');
});

test('invalid source IDs fail before Docker access and declared volumes reject a different source before create', async () => {
  await runFixture('success', ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Source image must be an exact local sha256 image ID/u);
    assert.deepEqual(state.calls, []);
    assert.equal(report, undefined);
  }, 'node:24.18.0-bookworm-slim');
  await runFixture('unsupported-volumes', ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /does not match the qualified image identity and declared volume/u);
    assert.equal(report.sourceImage, explicitSourceImage);
    assert.deepEqual(state.calls.map(({ args }) => args), [['image', 'inspect', explicitSourceImage]]);
    assert.equal(report.containerAcquisition, 'planned');
    assert.equal(report.imageAcquisition, 'planned');
  }, explicitSourceImage);
});

test('lost create reply reconciles the exact planned name and verifies ownership before exact-ID cleanup', async () => {
  await runFixture('lost-create', ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /create reply lost/u);
    assert.equal(report.container, containerId);
    assert.equal(report.containerRemoved, true);
    assert.equal(state.container, null);
    assert.deepEqual(state.calls.filter(({ args }) => args[1] === 'rm').map(({ args }) => args), [['container', 'rm', '--force', containerId]]);
    const lookup = state.calls.find(({ args }) => args[1] === 'inspect' && args[0] === 'container');
    assert.equal(lookup.args[2], report.plannedContainerName);
    assert.equal(report.cleanupFailure, null);
  });
});

test('absence after uncertain create stays failed and a conflicting named container remains untouched', async () => {
  for (const scenario of ['absent-create', 'conflicting-create']) await runFixture(scenario, ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /create reply lost/u);
    assert.match(report.cleanupFailure, scenario === 'absent-create' ? /absence cannot exclude a late create/u : /identity conflicts/u);
    assert.equal(report.containerRemoved, undefined);
    assert.deepEqual(state.calls.filter(({ args }) => args[1] === 'rm'), []);
    if (scenario === 'conflicting-create') assert.equal(state.container.Config.Labels['org.agenai.sandbox.preparation'], 'someone-else');
  });
});

test('persistent report failure after create cannot block physical cleanup or advance to export', async () => {
  await runFixture('persist-after-create', ({ result, state }) => {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /EISDIR/u);
    assert.equal(state.container, null);
    assert.deepEqual(state.calls.filter(({ args }) => args[1] === 'rm').map(({ args }) => args[3]), [containerId]);
    assert.deepEqual(state.calls.filter(({ args }) => args[1] === 'export'), []);
  });
});

test('failed final publication preserves the earlier export failure after successful exact cleanup', async () => {
  await runFixture('export-primary-and-final-persist', ({ result, state }) => {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /export primary failure/u);
    assert.doesNotMatch(result.stderr, /EISDIR/u);
    assert.equal(state.container, null);
    assert.deepEqual(state.calls.filter(({ args }) => args[1] === 'rm').map(({ args }) => args[3]), [containerId]);
    assert.deepEqual(state.calls.filter(({ args }) => args[1] === 'import'), []);
  });
});

test('lost import reply records the exact matching planned tag identity and retains it for failed recovery', async () => {
  await runFixture('lost-import', ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /import reply lost/u);
    assert.equal(report.image, imageId);
    assert.equal(report.imageAcquisition, 'identified');
    assert.match(report.imageRetainedFor, /Failed preparation recovery/u);
    assert.equal(state.image.Id, imageId);
    assert.equal(state.container, null);
    const imageLookup = state.calls.filter(({ args }) => args[0] === 'image' && args[1] === 'inspect').at(-1);
    assert.equal(imageLookup.args[2], report.imageTag);
    assert.equal(report.containerRemoved, true);
    assert.equal(report.cleanupFailure, null);
  });
});
