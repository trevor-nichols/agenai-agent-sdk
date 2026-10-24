// ------------------------------------------------------------------------------------------------
//                run.mjs - Explicit platform rows with owned images and daemon-side cleanup evidence
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFreeEnvironment } from '../ci-profile.mjs';
import { runOwnedCommand } from '../command.mjs';
import { boundedFile } from '../native/configuration.mjs';
import { failure } from '../scalability/configuration.mjs';
import { admitOutput, copyQualificationSources, installedIdentity } from '../scalability/identity.mjs';
import { cleanupFixtureImage, prepareFixtureImage } from '../scalability/image.mjs';
import { hashFile } from '../scalability/manifests.mjs';
import { engineControl } from '../scalability/resources.mjs';
import { createTraceProxy } from '../selective/proxy/index.mjs';
import { parseArguments, profiles, readManifest, usage, verifyObservedTuple } from './configuration.mjs';
import { createDaemonObserver, cleanupDaemonObserver } from './observer/index.mjs';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const encode = (value) => `${JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2)}\n`;

async function run(options) {
  const manifest = await readManifest(options.manifestPath, options.row);
  const profile = profiles[manifest.profile];
  assert.equal(process.platform, profile.os); assert.equal(process.arch, profile.architecture);
  assert.equal(process.versions.node, manifest.expected.controller.nodeVersion);
  const packageRoot = options.mode === 'monorepo' ? 'packages/ai/sandbox-docker' : 'packages/sandbox-docker';
  assert.equal(JSON.parse((await boundedFile(join(repository, packageRoot, 'package.json'), 64 * 1024)).toString('utf8')).name,
    '@agen-ai/sandbox-docker', 'Selected source layout must contain the Docker package.');
  await admitOutput(options.output, options.consumer);
  const identity = await installedIdentity(options.consumer);
  const entrypoint = join(options.consumer, 'platform-dist/examples/sandbox',
    options.row === 'grok-initialize' ? 'evidence.js' : options.row === 'datasets' ? 'datasets.js' : 'docker.js');
  await boundedFile(entrypoint, 256 * 1024);
  const compiledEntrypoint = { path: entrypoint, ...(await hashFile(entrypoint)),
    execution: 'plain Node; prepared by the installed platform consumer compiler' };
  const socket = await lstat(manifest.engine.slice(7));
  assert(socket.isSocket() && !socket.isSymbolicLink(), 'Select the physical local Engine socket explicitly.');
  await mkdir(options.output, { mode: 0o700 });
  const dockerConfig = join(options.output, 'docker-config'); await mkdir(dockerConfig, { mode: 0o700 });
  const env = credentialFreeEnvironment(process.env, dockerConfig);
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Platform qualification interrupted.'));
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  const report = { format: 'agenai.sandbox-platform-launcher.v1', status: 'running', options, manifest,
    startedAt: new Date().toISOString(), installedIdentity: identity, compiledEntrypoint, observed: null, preparations: [], commands: [],
    observer: null, primaryFailure: null, cleanupFailures: [], borrowedImagesPreserved: [],
    qualificationScope: 'Only the observed controller/daemon/image/profile and selected row; no inference or billing.' };
  const checkpoint = () => writeFile(join(options.output, 'launcher-report.json'), encode(report), { mode: 0o600 });
  let commandQuiescent = true;
  let observer, proxy;
  let observerEntered = false;
  const observerRoot = join(options.output, 'observer');
  const execute = async (name, command, args, childEnv = env, cwd = repository, timeoutMs = 300_000) => {
    let result, error;
    try { result = await runOwnedCommand({ command, args, env: childEnv, cwd, timeoutMs, signal: cancellation.signal }); }
    catch (caught) { result = caught; error = caught; commandQuiescent &&= caught.quiescent === true; }
    const log = `${name}.log`;
    report.commands.push({ name, command, args, status: result.status, quiescent: result.quiescent, log });
    await writeFile(join(options.output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`, { mode: 0o600 });
    await checkpoint();
    if (error) throw error;
    return result.stdout.trim();
  };
  const prepare = async (name, sourceImage, architecture) => {
    const directory = join(options.output, `${name}-image`); await mkdir(directory, { mode: 0o700 });
    const preparation = join(directory, 'preparation');
    const item = { name, sourceImage, architecture, preparation, image: null, removed: false };
    report.preparations.push(item); await checkpoint();
    try { item.image = await prepareFixtureImage({ endpoint: manifest.engine, sourceImage, architecture, preparation, env, signal: cancellation.signal }); }
    catch (error) { commandQuiescent &&= error.quiescent === true; throw error; }
    await checkpoint();
    return item.image;
  };
  try {
    await checkpoint();
    const version = (await engineControl(manifest.engine, 'GET', '/version')).value;
    const info = (await engineControl(manifest.engine, 'GET', '/info')).value;
    report.observed = verifyObservedTuple(manifest, version, info);
    report.imageStore = { driver: info.Driver, driverTypes: info.DriverStatus?.filter(([name]) => name === 'driver-type').map(([, value]) => value) ?? [] };
    if (manifest.desktop !== null) {
      await boundedFile(manifest.desktop.applicationPlist, 1024 ** 2);
      report.desktopApplication = { path: manifest.desktop.applicationPlist, ...(await hashFile(manifest.desktop.applicationPlist)) };
      report.desktopVersion = await execute('desktop-version', '/usr/libexec/PlistBuddy',
        ['-c', 'Print:CFBundleShortVersionString', manifest.desktop.applicationPlist], env, repository, 10_000);
      assert.equal(report.desktopVersion, manifest.desktop.version, 'Selected Desktop application version changed.');
    }
    for (const [image, architecture] of [[manifest.sourceImage, profile.imageArchitecture], [manifest.observerImage, profile.daemonArchitecture]]) {
      const inspected = (await engineControl(manifest.engine, 'GET', `/images/${encodeURIComponent(image)}/json`)).value;
      assert.equal(inspected.Id, image); assert.equal(inspected.Os, 'linux'); assert.equal(inspected.Architecture, architecture);
      assert.equal(Object.keys(inspected.Config?.Volumes ?? {}).length, 0);
    }
    const imageDigest = await prepare('guest', manifest.sourceImage, profile.imageArchitecture);
    const preparedGuest = JSON.parse((await boundedFile(join(options.output, 'guest-image/preparation/preparation.json'), 64 * 1024)).toString('utf8'));
    const observerImage = await prepare('observer', manifest.observerImage, profile.daemonArchitecture);
    observerEntered = true;
    observer = await createDaemonObserver({ endpoint: manifest.engine, imageDigest: observerImage,
      architecture: profile.daemonArchitecture, output: observerRoot, allowedImages: [imageDigest],
      namespacePrefixes: ['ms005-', 'sdk-example-', 'platform-grok-'] });
    report.observer = observer.record;
    const kernel = await observer.listenKernel(join(options.output, 'kernel.sock'));
    proxy = await createTraceProxy({ socketPath: join(options.output, 'engine.sock'), upstreamEndpoint: manifest.engine,
      tracePath: join(options.output, 'engine-requests.jsonl'), observeResponse: observer.observeResponse });
    proxy.setRow(options.row);
    const fixturePath = join(options.output, 'fixture.json');
    await writeFile(fixturePath, encode({ format: 'agenai.sandbox-docker-fixture.v1', imageDigest,
      profile: manifest.profile, user: { uid: 65534, gid: 65534 }, nodeVersion: '24.18.0',
      datasets: [{ name: 'reference', imageDigest, subpath: preparedGuest.datasetFixture.subpath }],
      datasetFixture: { name: 'reference', ...preparedGuest.datasetFixture } }), { mode: 0o600 });
    const childEnv = { ...env, AGENAI_SANDBOX_TEST_ENGINE: proxy.endpoint, AGENAI_SANDBOX_TEST_PROFILE: manifest.profile,
      AGENAI_SANDBOX_TEST_MANIFEST: fixturePath, AGENAI_SANDBOX_TEST_KERNEL_OBSERVER: kernel.endpoint,
      ...(options.row === 'datasets' ? { AGENAI_SANDBOX_TEST_DATASETS: '1' } : {}) };
    if (options.row === 'core' || options.row === 'datasets') {
      const integrationRoot = join(repository, packageRoot, 'tests/integration');
      const selectedTests = options.row === 'datasets' ? ['datasets.test.ts', 'recovery.test.ts']
        : (await readdir(integrationRoot)).filter((name) => name.endsWith('.test.ts') && name !== 'datasets.test.ts').sort();
      assert(selectedTests.length > 0);
      await execute('source-integration', process.execPath, ['--import', 'tsx', '--test', ...selectedTests.map((name) => join(integrationRoot, name))],
        { ...childEnv, AGENAI_SANDBOX_TEST_OUTPUT: join(options.output, 'source-integration') }, repository, 900_000);
    }
    if (options.row === 'grok-initialize') {
      report.controller = await copyQualificationSources(options.consumer, { name: 'sandbox-platform', source: new URL('../', import.meta.url),
        files: ['platform/grok.mjs', 'platform/grok-binary.mjs'] });
      const configurationPath = join(options.output, 'grok-controller.json');
      await writeFile(configurationPath, encode({ endpoint: proxy.endpoint, profile: manifest.profile, imageDigest,
        output: join(options.output, 'grok'), harness: manifest.harness }), { flag: 'wx', mode: 0o600 });
      await execute('grok-initialize', process.execPath, [join(report.controller.directory, 'platform/grok.mjs'), configurationPath],
        env, options.consumer, 300_000);
      report.grok = JSON.parse((await boundedFile(join(options.output, 'grok/grok-report.json'), 256 * 1024)).toString('utf8'));
      assert.equal(report.grok.status, 'passed');
    } else if (options.row === 'datasets') {
      const output = await execute('installed-datasets', process.execPath, [entrypoint],
        { ...childEnv, AGENAI_SANDBOX_TEST_OUTPUT: join(options.output, 'installed-datasets') }, options.consumer, 180_000);
      report.installedDatasets = JSON.parse(output);
      assert.equal(report.installedDatasets.proof, 'packed-sandbox-datasets-example');
    } else {
      const output = await execute('installed-example', process.execPath, ['platform-dist/examples/sandbox/docker.js'],
        { ...childEnv, AGENAI_SANDBOX_TEST_OUTPUT: join(options.output, 'installed-example') }, options.consumer, 180_000);
      report.installedExample = JSON.parse(output);
      assert.equal(report.installedExample.proof, 'packed-sandbox-docker-example');
    }
    await proxy.idle();
    report.kernelCleanup = await observer.assertAllEmpty();
    assert(observer.record.scopes.length > 0, 'The daemon observer must have observed actual SDK compute.');
    assert.deepEqual(await installedIdentity(options.consumer), identity, 'Installed package payload changed during qualification.');
  } catch (error) { report.primaryFailure = failure(error); }
  finally {
    if (proxy) {
      try { await proxy.close(); } catch (error) { report.cleanupFailures.push(failure(error)); }
    }
    if (observerEntered) {
      try {
        assert(commandQuiescent, 'An entered child remains active; retain diagnostic ownership until it settles.');
        if (observer) await observer.close();
        else await cleanupDaemonObserver({ endpoint: manifest.engine, recordPath: join(observerRoot, 'record.json') });
      } catch (error) { report.cleanupFailures.push(failure(error)); }
    }
    for (const item of [...report.preparations].reverse()) {
      try { item.removed = await cleanupFixtureImage({ endpoint: manifest.engine, sourceImage: item.sourceImage,
        preparation: item.preparation, daemonId: report.observed.daemon.id, commandsQuiescent: commandQuiescent }); }
      catch (error) { report.cleanupFailures.push(failure(error)); }
    }
    for (const image of new Set([manifest.sourceImage, manifest.observerImage])) {
      try {
        assert.equal((await engineControl(manifest.engine, 'GET', `/images/${encodeURIComponent(image)}/json`)).value.Id, image);
        report.borrowedImagesPreserved.push(image);
      } catch (error) { report.cleanupFailures.push(failure(error)); }
    }
    report.status = report.primaryFailure || report.cleanupFailures.length ? 'failed' : 'passed';
    report.finishedAt = new Date().toISOString();
    process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    await checkpoint();
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, report: join(options.output, 'launcher-report.json') })}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(usage);
  else await run(parseArguments(process.argv.slice(2)));
} catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`); process.exitCode = 1; }
