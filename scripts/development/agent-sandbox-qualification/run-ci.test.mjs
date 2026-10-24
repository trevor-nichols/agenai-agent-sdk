// ------------------------------------------------------------------------------------------------
//                run-ci.test.mjs - Integration command, evidence and image ownership failure behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const runner = new URL('./run-ci.mjs', import.meta.url).pathname;
const imageId = `sha256:${'e'.repeat(64)}`;
const sourceId = `sha256:${'f'.repeat(64)}`;
const qualifiedRuntime = { skip: process.versions.node === '24.18.0' ? false : 'CLI orchestration runs in the pinned Node 24.18.0 sandbox CI lane.' };

async function fixture(scenario, inspect, mode = 'monorepo') {
  const root = await mkdtemp(path.join(tmpdir(), 'agenai-sandbox-ci-test-'));
  const bin = path.join(root, 'bin');
  const output = path.join(root, 'evidence');
  const statePath = path.join(root, 'state.json');
  await mkdir(bin);
  await mkdir(path.join(root, 'scripts/architecture'), { recursive: true });
  await writeFile(statePath, JSON.stringify({ calls: [], container: null, image: null }));
  const fixtureScript = `#!${process.execPath}
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const statePath = ${JSON.stringify(statePath)};
const scenario = ${JSON.stringify(scenario)};
const state = JSON.parse(readFileSync(statePath));
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
state.calls.push({ command, args: [...args], env: process.env });
const save = () => writeFileSync(statePath, JSON.stringify(state));
const print = (value) => { save(); console.log(JSON.stringify(value)); };
const fail = (message) => { save(); console.error(message); process.exit(1); };
if (command === 'docker') {
  if (args.shift() !== '--host' || args.shift() !== 'unix:///test/engine.sock') throw new Error('Explicit endpoint required');
  if (scenario === 'missing-engine') fail('required engine unavailable');
  if (args[0] === 'version') print({ Version: '29.1.4', ApiVersion: '1.52', Os: 'linux', Arch: 'amd64' });
  else if (args[0] === 'info') print({ ID: scenario === 'foreign-daemon' && state.testsEntered ? 'foreign-daemon' : 'owned-daemon', OSType: 'linux', Architecture: 'x86_64', CgroupVersion: '2', CgroupDriver: 'systemd',
    Driver: scenario === 'unsupported-snapshotter' ? 'stargz' : 'overlayfs',
    DriverStatus: [['driver-type', scenario === 'unsupported-dataset-store' ? 'overlay2' : 'io.containerd.snapshotter.v1']],
    MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true,
    SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'], HTTPProxy: 'http://user:secret@proxy.invalid' });
  else if (args[0] === 'image' && args[1] === 'pull') { state.pulled = true; save(); }
  else if (args[0] === 'image' && args[1] === 'inspect' && (args[2].startsWith('node:') || args[2] === '${sourceId}')) {
    if (args[2].startsWith('node:') && scenario === 'needs-pull' && !state.pulled) fail('Error: No such image: ' + args[2]);
    print([{ Id: '${sourceId}', Os: 'linux', Architecture: 'amd64', Config: {} }]);
  } else if (args[0] === 'container' && args[1] === 'create') {
    const name = args[args.indexOf('--name') + 1];
    const operationId = args[args.indexOf('--label') + 1].split('=')[1];
    state.container = { Id: '${'d'.repeat(64)}', Name: '/' + name, Image: '${sourceId}', Config: { Labels: { 'org.agenai.sandbox.preparation': operationId } } };
    save(); console.log(state.container.Id);
  } else if (args[0] === 'container' && args[1] === 'inspect') {
    if (!state.container) fail('Error: No such container: ' + args[2]);
    print([state.container]);
  } else if (args[0] === 'container' && args[1] === 'export') {
    writeFileSync(args[args.indexOf('--output') + 1], Buffer.alloc(1024)); save();
  } else if (args[0] === 'container' && args[1] === 'rm') { state.container = null; save(); }
  else if (args[0] === 'image' && args[1] === 'import') {
    const preparation = args.find((arg) => arg.startsWith('LABEL org.agenai.sandbox.preparation=')).split('=')[1];
    state.image = { Id: '${imageId}', Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.agenai.sandbox.preparation': preparation, 'org.agenai.sandbox.source': '${sourceId}' } } };
    save();
    if (scenario === 'lost-preparation-import') fail('preparation import reply lost');
    console.log(state.image.Id);
  } else if (args[0] === 'image' && args[1] === 'inspect') {
    if (!state.image) fail('Error: No such image: ' + args[2]);
    if (scenario === 'foreign-image' && state.testsEntered) state.image.Config.Labels['org.agenai.sandbox.preparation'] = 'foreign';
    print([state.image]);
  } else if (args[0] === 'image' && args[1] === 'rm') {
    if (args.length !== 3 || args[2] !== '${imageId}') throw new Error('Only the exact owned image can be removed');
    if (scenario === 'test-and-cleanup-fail') fail('owned image cleanup failed');
    state.image = null; save();
  } else throw new Error('Unexpected Docker operation ' + JSON.stringify(args));
} else if (command === 'pnpm') {
  if (args.includes('test:integration')) {
    state.testsEntered = true;
    const manifest = JSON.parse(readFileSync(process.env.AGENAI_SANDBOX_TEST_MANIFEST));
    state.manifest = manifest; save();
    if (scenario === 'unsettled-output') {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: ['ignore', process.stdout, process.stderr] });
      child.unref(); state.escapedPid = child.pid; save(); fail('source output ownership escaped');
    }
    if (scenario === 'report-fail') { unlinkSync(${JSON.stringify(path.join(output, 'ci-report.json'))}); mkdirSync(${JSON.stringify(path.join(output, 'ci-report.json'))}); }
    if (['test-fail', 'test-and-cleanup-fail', 'foreign-image', 'foreign-daemon', 'report-fail'].includes(scenario)) fail('source integration failed');
  } else {
    const packed = args[args.indexOf('--output') + 1]; mkdirSync(path.join(packed, 'consumer'), { recursive: true }); save();
  }
  console.log('independent fixture command proof');
} else { state.packedExecuted = true; save(); console.log('packed result proof'); }
`;
  for (const target of [path.join(bin, 'docker'), path.join(bin, 'pnpm'), path.join(root, 'scripts/architecture/check-agent-sdk-sandbox-consumer.mjs')]) {
    await writeFile(target, fixtureScript);
    await chmod(target, 0o700);
  }
  try {
    const result = await execute(process.execPath, [runner, '--mode', mode, '--engine', 'unix:///test/engine.sock', '--output', output], {
      cwd: root, env: { PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter), OPENAI_API_KEY: 'must-not-pass', NODE_OPTIONS: '', DOCKER_HOST: 'tcp://foreign' }, timeout: 30_000,
    }).then((value) => ({ ...value, code: 0 }), (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
    let report;
    try { report = JSON.parse(await readFile(path.join(output, 'ci-report.json'), 'utf8')); }
    catch (error) { if (error.code !== 'EISDIR') throw error; }
    await inspect({ result, state: JSON.parse(await readFile(statePath, 'utf8')), report, output });
  } finally {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state.escapedPid) {
      try { process.kill(state.escapedPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { force: true, recursive: true });
  }
}

test('the selected real lane fails when its explicit Engine is unavailable and never silently skips', async () => {
  await fixture('missing-engine', ({ result, report, state }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /required engine unavailable/u);
    assert.equal(report.testsPassed, undefined);
    assert.deepEqual(state.calls.map(({ command }) => command), ['docker']);
    assert.equal(report.imageRemoved, false);
  });
});

test('source and packed lanes use prepared immutable image, isolated credentials and independent evidence directories', qualifiedRuntime, async () => {
  for (const mode of ['monorepo', 'standalone']) await fixture('success', async ({ result, state, report, output }) => {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.testsPassed, true);
    assert.equal(report.imageRemoved, true);
    assert.equal(report.sourcePreviouslyPresent, true);
    assert.equal(state.container, null);
    assert.equal(state.image, null);
    assert.equal(state.packedExecuted, true);
    assert.equal(state.manifest.imageDigest, imageId);
    assert.equal(state.manifest.nodeVersion, '24.18.0');
    assert.deepEqual(state.manifest.datasets, [{ name: 'reference', imageDigest: imageId, subpath: 'agenai-qualification-dataset' }]);
    assert.equal(state.manifest.datasetFixture.name, 'reference');
    assert.equal(state.manifest.datasetFixture.path, 'manifest.txt');
    assert.equal(state.manifest.datasetFixture.byteLength, 82);
    assert.match(state.manifest.datasetFixture.sha256, /^[a-f0-9]{64}$/u);
    for (const call of state.calls) {
      assert.equal(call.env.OPENAI_API_KEY, undefined);
      assert.equal(call.env.DOCKER_HOST, undefined);
      assert.equal(call.env.NODE_OPTIONS, undefined);
      assert.equal(call.env.DOCKER_CONFIG, path.join(output, 'docker-config'));
    }
    assert.deepEqual(state.calls.filter(({ command }) => command === 'pnpm').map(({ args }) => args), [
      ['--filter', '@agen-ai/sandbox-docker', 'test:integration'],
      [mode === 'monorepo' ? 'test:agent-sdk-external-consumer' : 'test:external-consumer', '--output', path.join(output, 'packed')],
    ]);
    const source = state.calls.find(({ args }) => args.includes('test:integration'));
    const packed = state.calls.find(({ command }) => command === 'check-agent-sdk-sandbox-consumer.mjs');
    assert.equal(source.env.AGENAI_SANDBOX_TEST_OUTPUT, path.join(output, 'source-integration'));
    assert.equal(packed.env.AGENAI_SANDBOX_TEST_OUTPUT, path.join(output, 'packed-integration'));
    assert.match(await readFile(path.join(output, 'source-integration.log'), 'utf8'), /independent fixture command proof/u);
    assert.match(await readFile(path.join(output, 'packed-integration.log'), 'utf8'), /packed result proof/u);
    assert.equal(report.profile.info.HTTPProxy, undefined);
  }, mode);
});

test('the explicitly selected dataset lane rejects an unqualified image store before source preparation or pull', qualifiedRuntime, async () => {
  for (const scenario of ['unsupported-dataset-store', 'unsupported-snapshotter']) await fixture(scenario, ({ result, report, state }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /containerd|image.*store|snapshotter/iu);
    assert.equal(state.pulled, undefined);
    assert.equal(state.container, null); assert.equal(state.image, null);
    assert.equal(state.testsEntered, undefined);
    assert.deepEqual(state.calls.map(({ args }) => args.slice(2, 3)), [['version'], ['info']]);
  });
});

test('a missing source is explicitly pulled before preparation, and the source image is retained', qualifiedRuntime, async () => {
  await fixture('needs-pull', ({ result, state, report }) => {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.sourcePreviouslyPresent, false);
    assert.equal(report.sourceImageRetained, true);
    assert.deepEqual(state.calls.filter(({ args }) => args.includes('pull')).map(({ args }) => args.slice(2)),
      [['image', 'pull', '--platform', 'linux/amd64', 'node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6']]);
    assert.deepEqual(state.calls.filter(({ args }) => args.includes('rm') && args.includes('image')).map(({ args }) => args.at(-1)), [imageId]);
  });
});

test('primary failures retain their own evidence while finally cleanup succeeds or reports a separate cleanup failure', qualifiedRuntime, async () => {
  for (const scenario of ['test-fail', 'test-and-cleanup-fail', 'foreign-image', 'foreign-daemon']) await fixture(scenario, ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /source integration failed/u);
    assert.equal(report.testsPassed, undefined);
    assert.equal(state.packedExecuted, undefined);
    if (scenario === 'test-fail') {
      assert.equal(report.imageRemoved, true);
      assert.equal(report.cleanupFailure, null);
      assert.equal(state.image, null);
    } else {
      assert.equal(report.imageRemoved, false);
      assert.equal(state.image.Id, imageId);
      assert.match(report.cleanupFailure, scenario === 'foreign-image' ? /foreign/u : scenario === 'foreign-daemon' ? /original daemon identity/u : /owned image cleanup failed/u);
      if (scenario.startsWith('foreign-')) assert.equal(state.calls.some(({ args }) => args.includes('image') && args.includes('rm')), false);
    }
  });
});

test('failed preparation retains the primary error while removing only its recovered image, and failed evidence cannot block cleanup', qualifiedRuntime, async () => {
  await fixture('lost-preparation-import', ({ result, report, state }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /preparation import reply lost/u);
    assert.equal(report.imageRemoved, true);
    assert.equal(report.cleanupFailure, null);
    assert.equal(state.container, null);
    assert.equal(state.image, null);
    assert.equal(state.testsEntered, undefined);
  });
  await fixture('report-fail', ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /source integration failed/u);
    assert.equal(report, undefined);
    assert.equal(state.image, null);
    assert.equal(state.container, null);
    assert.deepEqual(state.calls.filter(({ args }) => args.includes('image') && args.includes('rm')).map(({ args }) => args.at(-1)), [imageId]);
  });
});

test('unsettled command output fences image cleanup and retains the exact recovery image', qualifiedRuntime, async () => {
  await fixture('unsettled-output', ({ result, state, report }) => {
    assert.equal(result.code, 1);
    assert.match(report.primaryFailure, /source output ownership escaped/u);
    assert.match(report.cleanupFailure, /process-group quiescence remains uncertain/u);
    assert.equal(report.imageRemoved, false);
    assert.equal(state.image.Id, imageId);
    assert.equal(report.commands.find(({ log }) => log === 'source-integration.log').quiescent, false);
    assert.equal(state.calls.some(({ args }) => args.includes('image') && args.includes('rm')), false);
  });
});
