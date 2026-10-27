// ------------------------------------------------------------------------------------------------
//                run.mjs - Explicit platform rows with owned images and daemon-side cleanup evidence
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
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
import { parseArguments, profiles, usage, verifyObservedTuple } from './configuration.mjs';
import { admitPlatformRun } from './capabilities/admission.mjs';
import { assertInputCurrent } from './capabilities/input.mjs';
import { assertHostRootCurrent } from './capabilities/preserve/host-roots.mjs';
import { createRouteObserverCapture } from './capabilities/network/observer-capture.mjs';
import { createEngineNetworkCapture } from './capabilities/network/engine-capture.mjs';
import { createDaemonObserver, cleanupDaemonObserver } from './observer/index.mjs';
import { sourceTestCommand } from './source-tests.mjs';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const encode = (value) => `${JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2)}\n`;
const liveSources = [
  'engine.mjs', 'command.mjs', 'selective/proxy/index.mjs', 'selective/proxy/http.mjs',
  'selective/proxy/upgrade.mjs', 'selective/proxy/trace.mjs', 'capabilities/live/guest.mjs',
  'capabilities/live/publicationGate.mjs', 'capabilities/production/session.mjs', 'platform/capabilities/input.mjs',
  ...['budget', 'installed', 'evidence', 'sentinel', 'operations', 'confinement', 'lifecycle', 'faults',
    'controller-process', 'recovery-child', 'crash', 'owner-cleanup', 'controller'].map((name) => `platform/capabilities/live/${name}.mjs`),
];
const preserveSources = [
  'engine.mjs', 'command.mjs', 'selective/proxy/index.mjs', 'selective/proxy/http.mjs',
  'selective/proxy/upgrade.mjs', 'selective/proxy/trace.mjs', 'capabilities/live/guest.mjs',
  'capabilities/production/session.mjs', 'capabilities/symlinks/fixtures.mjs', 'platform/capabilities/input.mjs',
  ...['budget', 'installed', 'evidence', 'owner-cleanup', 'sentinel'].map((name) => `platform/capabilities/live/${name}.mjs`),
  ...['controller', 'shared', 'host-roots', 'roundtrip', 'admission', 'host-failures'].map((name) => `platform/capabilities/preserve/${name}.mjs`),
];
const networkSources = [
  'engine.mjs', 'command.mjs', 'selective/proxy/index.mjs', 'selective/proxy/http.mjs',
  'selective/proxy/upgrade.mjs', 'selective/proxy/trace.mjs', 'capabilities/desktop/fixtures.mjs',
  'capabilities/desktop/guest.mjs', 'capabilities/production/session.mjs', 'platform/capabilities/input.mjs',
  ...['evidence', 'owner-cleanup', 'controller-process'].map((name) => `platform/capabilities/live/${name}.mjs`),
  ...['budget', 'resources', 'installed', 'guest', 'fixtures', 'connectivity', 'faults', 'controller-child', 'controller']
    .map((name) => `platform/capabilities/network/${name}.mjs`),
];
const combinedSources = [...new Set([
  ...networkSources.filter((name) => !/\/network\/(?:budget|guest|connectivity|faults|controller-child|controller)\.mjs$/u.test(name)),
  'capabilities/live/publicationGate.mjs',
  'capabilities/live/guest.mjs', 'platform/capabilities/live/installed.mjs',
  'platform/capabilities/preserve/host-roots.mjs',
  ...['budget', 'installed', 'scenarios', 'faults', 'controller-child', 'controller']
    .map((name) => `platform/capabilities/combined/${name}.mjs`),
])];

async function run(options) {
  const selected = await admitPlatformRun(options);
  const manifest = selected.manifest;
  const profile = profiles[manifest.profile];
  assert.equal(process.platform, profile.os); assert.equal(process.arch, profile.architecture);
  assert.equal(process.versions.node, manifest.expected.controller.nodeVersion);
  const packageRoot = options.mode === 'monorepo' ? 'packages/ai/sandbox-docker' : 'packages/sandbox-docker';
  assert.equal(JSON.parse((await boundedFile(join(repository, packageRoot, 'package.json'), 64 * 1024)).toString('utf8')).name,
    '@agen-ai/sandbox-docker', 'Selected source layout must contain the Docker package.');
  await admitOutput(options.output, options.consumer);
  const identity = await installedIdentity(options.consumer);
  const entrypoint = ['live-files', 'preserve-internal', 'restricted-https'].includes(options.row) ? null : options.row === 'combined'
    ? join(options.consumer, 'platform-dist/examples/sandbox/combined/index.js') : join(options.consumer, 'platform-dist/examples/sandbox',
    options.row === 'grok-initialize' ? 'evidence.js' : options.row === 'datasets' ? 'datasets.js' : 'docker.js');
  if (entrypoint) await boundedFile(entrypoint, 256 * 1024);
  const compiledEntrypoint = entrypoint ? { path: entrypoint, ...(await hashFile(entrypoint)),
    execution: 'plain Node; prepared by the installed platform consumer compiler' } : null;
  if (options.row === 'combined') compiledEntrypoint.modules = await Promise.all(['index', 'workflow', 'program', 'session'].map(async (name) => {
    const path = join(options.consumer, 'platform-dist/examples/sandbox/combined', `${name}.js`);
    return { path, ...(await hashFile(path)) };
  }));
  const socket = await lstat(manifest.engine.slice(7));
  assert(socket.isSocket() && !socket.isSymbolicLink(), 'Select the physical local Engine socket explicitly.');
  await assertInputCurrent(selected.input);
  if (selected.capabilities) {
    await assertInputCurrent(selected.capabilities.input);
    const directory = options.row === 'live-files' ? 'live' : options.row === 'restricted-https' ? 'network' : options.row === 'combined' ? 'combined' : 'preserve';
    const caseId = options.row === 'live-files' ? 'c99' : 'c999';
    assert(Buffer.byteLength(join(options.output, directory, caseId, 'e.sock')) <= 100,
      options.row === 'live-files' ? 'Use a shorter live output path for native Unix sockets.' : 'Use a shorter preserving output path for native Unix sockets.');
    for (const root of selected.capabilities.hostRoots ?? []) await assertHostRootCurrent(root);
  }
  await mkdir(options.output, { mode: 0o700 });
  await writeFile(join(options.output, 'platform-manifest.json'), selected.utf8, { flag: 'wx', mode: 0o600 });
  if (selected.capabilities) await writeFile(join(options.output, 'capabilities-manifest.json'), selected.capabilities.utf8, { flag: 'wx', mode: 0o600 });
  const dockerConfig = join(options.output, 'docker-config'); await mkdir(dockerConfig, { mode: 0o700 });
  const env = credentialFreeEnvironment(process.env, dockerConfig);
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Platform qualification interrupted.'));
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  const report = { format: 'agenai.sandbox-platform-launcher.v1', status: 'running', options, manifest, manifestInput: selected.input,
    startedAt: new Date().toISOString(), installedIdentity: identity, compiledEntrypoint, observed: null, preparations: [], commands: [],
    observer: null, primaryFailure: null, cleanupFailures: [], borrowedImagesPreserved: [],
    qualificationScope: 'Only the observed controller/daemon/image/profile and selected row; no inference or billing.' };
  const checkpoint = () => writeFile(join(options.output, 'launcher-report.json'), encode(report), { mode: 0o600 });
  let commandQuiescent = true;
  let observer, proxy, routeCapture, engineCapture;
  let observerEntered = false;
  const observerRoot = join(options.output, 'observer');
  const execute = async (name, command, args, childEnv = env, cwd = repository, timeoutMs = 300_000) => {
    let result, error;
    try { result = await runOwnedCommand({ command, args, env: childEnv, cwd, timeoutMs, signal: cancellation.signal,
      ...(['live-files', 'preserve-internal', 'restricted-https', 'combined'].includes(options.row) ? { terminationGraceMs: 120_000 } : {}) }); }
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
    if (selected.capabilities?.manifest.filesystem) {
      const filesystem = selected.capabilities.manifest.filesystem;
      const helper = (await engineControl(manifest.engine, 'GET', `/images/${encodeURIComponent(filesystem.configuration.imageDigest)}/json`)).value;
      assert.equal(helper.Id, filesystem.configuration.imageDigest); assert.equal(helper.Os, 'linux');
      assert.equal(helper.Architecture, profile.daemonArchitecture);
      assert.equal(helper.Config.User, `${filesystem.configuration.user.uid}:${filesystem.configuration.user.gid}`);
      assert.deepEqual(helper.Config.Entrypoint, [filesystem.configuration.executable]);
      assert.equal(helper.Config.Labels['ai.agen.sandbox.filesystem.source'], filesystem.sourceDigest);
      assert.equal(helper.Config.Labels['ai.agen.sandbox.filesystem.protocol'], filesystem.configuration.protocol);
      assert.equal(helper.Config.Labels['ai.agen.sandbox.filesystem.layout'], filesystem.configuration.layout);
      assert.equal(Object.keys(helper.Config.Volumes ?? {}).length, 0);
      report.capabilities = { manifest: selected.capabilities.manifest, input: selected.capabilities.input,
        scenarioBudget: selected.capabilities.scenarioBudget, helperImage: helper };
      await checkpoint();
    }
    if (['restricted-https', 'combined'].includes(options.row)) {
      const network = selected.capabilities.manifest.network;
      const helperImages = [];
      for (const [role, id, source, protocol] of [
        ['egress', network.egress.configuration.imageDigest, network.egress.sourceDigest, network.egress.configuration.protocol],
        ...(manifest.profile === 'linux-x64' ? [] : [['route_observer', network.routeAuthority.vmObserver.imageDigest, network.routeAuthority.vmObserver.sourceDigest, network.routeAuthority.vmObserver.protocol]]),
        ['qualification_fixture', network.fixtures.imageDigest, null, null],
      ]) {
        const actual = (await engineControl(manifest.engine, 'GET', `/images/${encodeURIComponent(id)}/json`)).value;
        assert.equal(actual.Id, id); assert.equal(actual.Os, 'linux'); assert.equal(actual.Architecture, profile.daemonArchitecture);
        assert.equal(Object.keys(actual.Config?.Volumes ?? {}).length, 0);
        if (role === 'egress') { assert.equal(actual.Config.Labels['ai.agen.sandbox.egress.source'], source); assert.equal(actual.Config.Labels['ai.agen.sandbox.egress.protocol'], protocol); }
        if (role === 'route_observer') { assert.equal(actual.Config.Labels['ai.agen.sandbox.desktop-route.source'], source); assert.equal(actual.Config.Labels['ai.agen.sandbox.desktop-route.protocol'], protocol); }
        helperImages.push({ role, actual });
      }
      report.capabilities = { ...report.capabilities, manifest: selected.capabilities.manifest, input: selected.capabilities.input,
        scenarioBudget: selected.capabilities.scenarioBudget, helperImages };
      await checkpoint();
    }
    const imageDigest = await prepare('guest', manifest.sourceImage, profile.imageArchitecture);
    const preparedGuest = JSON.parse((await boundedFile(join(options.output, 'guest-image/preparation/preparation.json'), 64 * 1024)).toString('utf8'));
    const observerImage = await prepare('observer', manifest.observerImage, profile.daemonArchitecture);
    observerEntered = true;
    const fixtureOwner = ['live-files', 'preserve-internal', 'restricted-https', 'combined'].includes(options.row) ? randomUUID() : null;
    const namespacePrefix = fixtureOwner ? `platform-${options.row === 'live-files' ? 'live' : options.row === 'restricted-https' ? 'net' : options.row === 'combined' ? 'combined' : 'preserve'}-${fixtureOwner.slice(0, 8)}-` : null;
    observer = await createDaemonObserver({ endpoint: manifest.engine, imageDigest: observerImage,
      architecture: profile.daemonArchitecture, output: observerRoot,
      ...(options.row === 'preserve-internal' ? { maxScopes: 256 } : {}),
      ...(['restricted-https', 'combined'].includes(options.row) ? { roleImages: { compute: [imageDigest], export: [imageDigest],
        ...(options.row === 'combined' ? { filesystem: [selected.capabilities.manifest.filesystem.configuration.imageDigest] } : {}),
        egress_broker: [selected.capabilities.manifest.network.egress.configuration.imageDigest],
        egress_relay: [selected.capabilities.manifest.network.egress.configuration.imageDigest],
        ...(manifest.profile === 'linux-x64' ? {} : { route_observer: [selected.capabilities.manifest.network.routeAuthority.vmObserver.imageDigest] }) },
      qualificationFixtures: { owner: fixtureOwner, public_marker: [selected.capabilities.manifest.network.fixtures.imageDigest],
        vm_marker: [selected.capabilities.manifest.network.fixtures.imageDigest] }, namespacePrefixes: [namespacePrefix] }
        : selected.capabilities ? { roleImages: { compute: [imageDigest], export: [imageDigest],
        filesystem: [selected.capabilities.manifest.filesystem.configuration.imageDigest] },
      qualificationFixtures: { owner: fixtureOwner, sentinel: [imageDigest] }, namespacePrefixes: [namespacePrefix] }
        : { allowedImages: [imageDigest], namespacePrefixes: ['ms005-', 'sdk-example-', 'platform-grok-'] }) });
    report.observer = observer.record;
    const kernel = await observer.listenKernel(join(options.output, 'kernel.sock'));
    if (['restricted-https', 'combined'].includes(options.row) && manifest.profile !== 'linux-x64') {
      const sourcePath = fileURLToPath(new URL('./capabilities/network/observer-capture.mjs', import.meta.url));
      const source = { path: sourcePath, ...(await hashFile(sourcePath)) };
      const authority = selected.capabilities.manifest.network.routeAuthority;
      routeCapture = await createRouteObserverCapture({ directory: join(options.output, 'route-observer-capture'),
        endpoint: manifest.engine, profile: manifest.profile, namespacePrefix, workloadImage: imageDigest,
        observerImage: authority.vmObserver.imageDigest, observerUser: authority.vmObserver.user,
        configuration: { protocol: authority.vmObserver.protocol, ...authority.vmObserver.control,
          commandTimeoutMs: authority.commandTimeoutMs, maxOutputBytes: authority.maxOutputBytes },
        requestMs: selected.capabilities.manifest.limits.requestMs, source });
      report.routeObserverCapture = { source, indexPath: routeCapture.indexPath, final: null };
      const engineSourcePath = fileURLToPath(new URL('./capabilities/network/engine-capture.mjs', import.meta.url));
      const engineSource = { path: engineSourcePath, ...(await hashFile(engineSourcePath)) };
      engineCapture = await createEngineNetworkCapture({ directory: join(options.output, 'engine-network-capture'),
        profile: manifest.profile, namespacePrefix, workloadImage: imageDigest, source: engineSource });
      report.engineNetworkCapture = { source: engineSource, indexPath: engineCapture.indexPath, final: null };
    }
    proxy = await createTraceProxy({ socketPath: join(options.output, 'engine.sock'), upstreamEndpoint: manifest.engine,
      tracePath: join(options.output, 'engine-requests.jsonl'), observeResponse: observer.observeResponse,
      observeResponseBody: engineCapture?.observeResponseBody,
      observeUpgrade: routeCapture?.observeUpgrade });
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
      const sourceTests = await sourceTestCommand({ integrationRoot, row: options.row, testConcurrency: options.testConcurrency });
      report.sourceTests = sourceTests.selection;
      await checkpoint();
      await execute('source-integration', sourceTests.command, sourceTests.args,
        { ...childEnv, AGENAI_SANDBOX_TEST_OUTPUT: join(options.output, 'source-integration') }, repository, 900_000);
    }
    if (options.row === 'live-files') {
      report.controller = await copyQualificationSources(options.consumer, { name: 'sandbox-platform-live', source: new URL('../', import.meta.url), files: liveSources });
      const configurationPath = join(options.output, 'live-controller.json');
      await writeFile(configurationPath, encode({ format: 'agenai.sandbox-platform-live-controller.v1', endpoint: proxy.endpoint,
        profile: manifest.profile, imageDigest, guestNodeVersion: manifest.expected.controller.nodeVersion,
        consumer: options.consumer, output: join(options.output, 'live'),
        capabilities: selected.capabilities.manifest, fixtureOwner, namespacePrefix, sourceIdentity: report.controller.sources,
        scenarioBudget: selected.capabilities.scenarioBudget }), { flag: 'wx', mode: 0o600 });
      await checkpoint();
      await execute('installed-live-files', process.execPath, [join(report.controller.directory, 'platform/capabilities/live/controller.mjs'), configurationPath],
        env, options.consumer, selected.capabilities.manifest.limits.scenarioMs * 20);
      report.live = JSON.parse((await boundedFile(join(options.output, 'live/live-report.json'), 4 * 1024 ** 2)).toString('utf8'));
      assert.equal(report.live.status, 'passed');
    } else if (options.row === 'preserve-internal') {
      report.controller = await copyQualificationSources(options.consumer, { name: 'sandbox-platform-preserve', source: new URL('../', import.meta.url), files: preserveSources });
      const configurationPath = join(options.output, 'preserve-controller.json');
      await writeFile(configurationPath, encode({ format: 'agenai.sandbox-platform-preserve-controller.v1', endpoint: proxy.endpoint,
        profile: manifest.profile, imageDigest, guestNodeVersion: manifest.expected.controller.nodeVersion,
        consumer: options.consumer, output: join(options.output, 'preserve'), capabilities: selected.capabilities.manifest,
        fixtureOwner, namespacePrefix, sourceIdentity: report.controller.sources, scenarioBudget: selected.capabilities.scenarioBudget,
        hostRoots: selected.capabilities.hostRoots }), { flag: 'wx', mode: 0o600 });
      await checkpoint();
      await execute('installed-preserving-transfers', process.execPath, [join(report.controller.directory, 'platform/capabilities/preserve/controller.mjs'), configurationPath],
        env, options.consumer, selected.capabilities.manifest.limits.scenarioMs * 256);
      report.preserve = JSON.parse((await boundedFile(join(options.output, 'preserve/preserve-report.json'), 1024 ** 2)).toString('utf8'));
      assert.equal(report.preserve.status, 'passed'); assert.equal(report.preserve.hostCleanup.complete, true);
    } else if (options.row === 'restricted-https') {
      report.controller = await copyQualificationSources(options.consumer, { name: 'sandbox-platform-network', source: new URL('../', import.meta.url), files: networkSources });
      const proxySocket = await lstat(proxy.endpoint.slice(7), { bigint: true });
      assert(proxySocket.isSocket() && !proxySocket.isSymbolicLink());
      assert.equal((await engineControl(proxy.endpoint, 'GET', '/info')).value.ID, manifest.expected.daemon.id);
      const endpointProjection = { capturedEndpoint: manifest.engine, effectiveEndpoint: proxy.endpoint, engineId: manifest.expected.daemon.id,
        proxySocket: { device: String(proxySocket.dev), inode: String(proxySocket.ino), mode: String(proxySocket.mode), uid: String(proxySocket.uid), gid: String(proxySocket.gid) },
        upstreamSocket: { device: String(socket.dev), inode: String(socket.ino), mode: String(socket.mode) } };
      report.endpointProjection = endpointProjection;
      const configurationPath = join(options.output, 'network-controller.json');
      await writeFile(configurationPath, encode({ format: 'agenai.sandbox-platform-network-controller.v1', endpoint: proxy.endpoint,
        profile: manifest.profile, imageDigest, guestNodeVersion: manifest.expected.controller.nodeVersion,
        consumer: options.consumer, output: join(options.output, 'network'), capabilities: selected.capabilities.manifest,
        fixtureOwner, namespacePrefix, sourceIdentity: report.controller.sources, scenarioBudget: selected.capabilities.scenarioBudget, endpointProjection }), { flag: 'wx', mode: 0o600 });
      await checkpoint();
      await execute('installed-restricted-https', process.execPath, [join(report.controller.directory, 'platform/capabilities/network/controller.mjs'), configurationPath],
        env, options.consumer, selected.capabilities.manifest.limits.scenarioMs * 26);
      report.network = JSON.parse((await boundedFile(join(options.output, 'network/network-report.json'), 1024 ** 2)).toString('utf8'));
      assert.equal(report.network.status, 'passed'); assert.equal(report.network.fixtures.closed, true);
    } else if (options.row === 'combined') {
      report.controller = await copyQualificationSources(options.consumer, { name: 'sandbox-platform-combined', source: new URL('../', import.meta.url), files: combinedSources });
      const proxySocket = await lstat(proxy.endpoint.slice(7), { bigint: true });
      assert(proxySocket.isSocket() && !proxySocket.isSymbolicLink());
      assert.equal((await engineControl(proxy.endpoint, 'GET', '/info')).value.ID, manifest.expected.daemon.id);
      report.endpointProjection = { capturedEndpoint: manifest.engine, effectiveEndpoint: proxy.endpoint, engineId: manifest.expected.daemon.id,
        proxySocket: { device: String(proxySocket.dev), inode: String(proxySocket.ino), mode: String(proxySocket.mode), uid: String(proxySocket.uid), gid: String(proxySocket.gid) },
        upstreamSocket: { device: String(socket.dev), inode: String(socket.ino), mode: String(socket.mode) } };
      const configurationPath = join(options.output, 'combined-controller.json');
      await writeFile(configurationPath, encode({ format: 'agenai.sandbox-platform-combined-controller.v1', endpoint: proxy.endpoint,
        profile: manifest.profile, imageDigest, guestNodeVersion: manifest.expected.controller.nodeVersion,
        consumer: options.consumer, output: join(options.output, 'combined'), capabilities: selected.capabilities.manifest,
        fixtureOwner, namespacePrefix, sourceIdentity: report.controller.sources, scenarioBudget: selected.capabilities.scenarioBudget,
        endpointProjection: report.endpointProjection, hostRoots: selected.capabilities.hostRoots,
        entrypoint: compiledEntrypoint }), { flag: 'wx', mode: 0o600 });
      await checkpoint();
      await execute('installed-combined', process.execPath, [join(report.controller.directory, 'platform/capabilities/combined/controller.mjs'), configurationPath],
        env, options.consumer, selected.capabilities.manifest.limits.scenarioMs * selected.capabilities.scenarioBudget.maximumCases);
      report.combined = JSON.parse((await boundedFile(join(options.output, 'combined/combined-report.json'), 1024 ** 2)).toString('utf8'));
      assert.equal(report.combined.status, 'passed'); assert.equal(report.combined.fixtures.closed, true);
      assert.equal(report.combined.hostCleanup.complete, true);
    } else if (options.row === 'grok-initialize') {
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
    if (['restricted-https', 'combined'].includes(options.row)) {
      const upstream = await lstat(manifest.engine.slice(7), { bigint: true });
      assert(upstream.isSocket() && !upstream.isSymbolicLink());
      const actual = { device: String(upstream.dev), inode: String(upstream.ino), mode: String(upstream.mode) };
      assert.deepEqual(actual, report.endpointProjection.upstreamSocket, 'Original upstream socket changed before final cleanup census.');
      report.endpointProjection.upstreamFinal = { ...actual, observedAt: new Date().toISOString() };
    }
    report.kernelCleanup = await observer.assertAllEmpty();
    assert(observer.record.scopes.length > 0, 'The daemon observer must have observed actual SDK compute.');
    assert.deepEqual(await installedIdentity(options.consumer), identity, 'Installed package payload changed during qualification.');
    if (options.row === 'combined') for (const module of compiledEntrypoint.modules) {
      assert.deepEqual(await hashFile(module.path), { byteLength: module.byteLength, sha256: module.sha256, allocatedBytes: module.allocatedBytes },
        'Installed public combined workflow payload changed during qualification.');
    }
  } catch (error) { report.primaryFailure = failure(error); }
  finally {
    if (proxy) {
      try { await proxy.close(); } catch (error) { report.cleanupFailures.push(failure(error)); }
    }
    if (routeCapture) {
      try {
        report.routeObserverCapture.final = await routeCapture.close(observer.record.scopes);
        assert.equal(report.routeObserverCapture.final.status, 'captured', 'Passive route-observer capture failed; retained evidence does not qualify this row.');
      } catch (error) { report.cleanupFailures.push(failure(error)); }
    }
    if (engineCapture) {
      try {
        report.engineNetworkCapture.final = await engineCapture.close();
        assert.equal(report.engineNetworkCapture.final.status, 'captured', 'Passive Engine network capture failed; retained evidence does not qualify this row.');
      } catch (error) { report.cleanupFailures.push(failure(error)); }
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
    for (const image of new Set([manifest.sourceImage, manifest.observerImage,
      ...(selected.capabilities?.manifest.filesystem ? [selected.capabilities.manifest.filesystem.configuration.imageDigest] : []),
      ...(selected.capabilities?.manifest.network ? [selected.capabilities.manifest.network.egress.configuration.imageDigest,
        selected.capabilities.manifest.network.routeAuthority.vmObserver?.imageDigest,
        selected.capabilities.manifest.network.fixtures.imageDigest].filter(Boolean) : [])])) {
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
