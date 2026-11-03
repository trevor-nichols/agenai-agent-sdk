import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Engine } from '../../engine.mjs';
import { runOwnedCommand } from '../../command.mjs';
import { createTraceProxy } from '../../selective/proxy/index.mjs';
import { admitOutput, installedIdentity } from '../../scalability/identity.mjs';
import { hashFile } from '../../scalability/manifests.mjs';
import { verifyObservedTuple } from '../../platform/configuration.mjs';
import { assertInputCurrent } from '../../platform/capabilities/input.mjs';
import { proxyRetired } from '../../platform/capabilities/cleanup/obligations.mjs';
import { createDaemonObserver, cleanupDaemonObserver } from '../../platform/observer/index.mjs';
import { createRouteObserverCapture } from '../../platform/capabilities/network/observer-capture.mjs';
import { createEngineNetworkCapture } from '../../platform/capabilities/network/engine-capture.mjs';
import { census } from '../../platform/capabilities/network/resources.mjs';
import { jsonWriter } from '../../platform/capabilities/live/evidence.mjs';
import { nativeControllerReady } from '../../platform/native-controller.mjs';
import { acquireAccessCredential, CatalogCredentialRefusal, selectedCredentialPath } from './credentials.mjs';
import { digest, parseArguments, readCatalogManifest, sanitizedConfiguration, usage } from './configuration.mjs';
import { createCatalogBackend, importGuest, installedSdk } from './installed.mjs';
import { harnessIdentity } from './identity.mjs';
import { CatalogFailure, catalogReader, finishCatalogCleanup, observeWork } from './lifecycle.mjs';
import { parseGuestResult } from './protocol.mjs';

async function inspectImage(engine, image, { architecture = 'arm64', user, source, protocol, role } = {}) {
  const actual = (await engine.request('GET', `/images/${encodeURIComponent(image)}/json`)).data;
  assert.equal(actual.Id, image); assert.equal(actual.Os, 'linux'); assert.equal(actual.Architecture, architecture);
  assert.equal(Object.keys(actual.Config?.Volumes ?? {}).length, 0);
  if (user) assert.equal(actual.Config.User, `${user.uid}:${user.gid}`);
  if (role) {
    assert.equal(actual.Config.Labels[`ai.agen.sandbox.${role}.source`], source);
    assert.equal(actual.Config.Labels[`ai.agen.sandbox.${role}.protocol`], protocol);
  }
  return { imageDigest: actual.Id, os: actual.Os, architecture: actual.Architecture,
    user: actual.Config.User, labels: actual.Config.Labels };
}

/** Opt-in installed public-SDK discovery. No image pull/build or model Task is available. */
export async function runCatalog(options) {
  const selected = await readCatalogManifest(options), manifest = selected.manifest;
  const platform = selected.platform.manifest, network = selected.network.manifest.network;
  const identity = await installedIdentity(options.consumer);
  assert.equal(digest(identity), manifest.installedIdentitySha256);
  await admitOutput(options.output, options.consumer);
  const sourceIdentity = await harnessIdentity();
  const sdk = await installedSdk(options.consumer);
  const engine = new Engine(platform.engine.slice(7), '1.52', { requestMs: 30000, outputBytes: 4 * 1024 ** 2 });
  const socket = await lstat(platform.engine.slice(7), { bigint: true }); assert(socket.isSocket() && !socket.isSymbolicLink());
  const socketIdentity = { device: String(socket.dev), inode: String(socket.ino), mode: String(socket.mode) };
  const observed = verifyObservedTuple(platform, (await engine.request('GET', '/version')).data, (await engine.request('GET', '/info')).data);
  const desktop = await runOwnedCommand({ command: '/usr/libexec/PlistBuddy',
    args: ['-c', 'Print:CFBundleShortVersionString', platform.desktop.applicationPlist],
    env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10000, maxOutputBytes: 65536 });
  assert.equal(desktop.stdout.trim(), platform.desktop.version);
  observed.desktopVersion = desktop.stdout.trim();
  const images = [];
  images.push(await inspectImage(engine, manifest.workload.imageDigest, { user: manifest.workload.user }));
  images.push(await inspectImage(engine, platform.observerImage));
  images.push(await inspectImage(engine, network.egress.configuration.imageDigest, { user: network.egress.configuration.user,
    source: network.egress.sourceDigest, protocol: network.egress.configuration.protocol, role: 'egress' }));
  images.push(await inspectImage(engine, network.routeAuthority.vmObserver.imageDigest, { user: network.routeAuthority.vmObserver.user,
    source: network.routeAuthority.vmObserver.sourceDigest, protocol: network.routeAuthority.vmObserver.protocol, role: 'desktop-route' }));
  const hostObserver = network.routeAuthority.hostObserver.executable;
  assert.equal((await hashFile(hostObserver.path)).sha256, hostObserver.sha256);
  for (const input of [selected.input, selected.platform.input, selected.network.input]) await assertInputCurrent(input);
  await mkdir(options.output, { mode: 0o700 });
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new CatalogFailure('cancelled'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const namespace = `catalog-${randomUUID()}`;
  const configuration = sanitizedConfiguration(manifest, selected.network.manifest, platform);
  const report = { format: 'agenai.native-catalog-host.v1', observation: 'native', status: 'running',
    startedAt: new Date().toISOString(), sourceIdentity, sourceSha256: digest(sourceIdentity), installedIdentity: identity,
    sdkLoader: sdk.loader,
    configuration, configurationSha256: digest(configuration), manifestSha256: selected.input.sha256,
    platformManifestSha256: selected.platform.input.sha256, networkManifestSha256: selected.network.input.sha256,
    observed, images, namespace, effective: null, guest: null, failure: null,
    cleanup: { complete: false, readerJoined: false, failures: [], absence: [],
      originalOwnerDestroyed: false, processReaderJoined: false, independentAbsence: false,
      daemonScopesEmpty: false, observerRemoved: false, proxyClosed: false, borrowedImagesPreserved: false } };
  const state = {};
  const save = jsonWriter(join(options.output, 'catalog-report.json'));
  const persist = () => save(report);
  let observer, proxy, routeCapture, engineCapture, observerEntered = false, stage = 'admission_failed';
  const observerDirectory = join(options.output, 'observer');
  try {
    await persist();
    await nativeControllerReady();
    await writeFile(join(options.output, 'manifest.json'), selected.utf8, { mode: 0o600, flag: 'wx' });
    // Public preparation only writes the exact shipped closure; it never builds or contacts Engine.
    report.helperPreparation = await sdk.dockerNode.prepareDockerSandboxEgressHelpers({ directory: join(options.output, 'helper-source'),
      baseImageDigest: manifest.helperBaseImage, user: network.egress.configuration.user });
    assert.equal(report.helperPreparation.sourceDigest, network.egress.sourceDigest);
    stage = 'credential_refused';
    state.credential = await acquireAccessCredential(sdk.sandboxNode, selectedCredentialPath(), cancellation.signal);
    cancellation.signal.throwIfAborted();
    stage = 'observer_failed'; observerEntered = true;
    observer = await createDaemonObserver({ endpoint: platform.engine, imageDigest: platform.observerImage,
      architecture: 'arm64', output: observerDirectory, roleImages: {
        compute: [manifest.workload.imageDigest], export: [manifest.workload.imageDigest],
        egress_broker: [network.egress.configuration.imageDigest], egress_relay: [network.egress.configuration.imageDigest],
        route_observer: [network.routeAuthority.vmObserver.imageDigest],
      }, namespacePrefixes: [namespace] });
    cancellation.signal.throwIfAborted();
    report.observer = { recordPath: observer.recordPath };
    const captureSource = async (name) => { const path = fileURLToPath(new URL(`../../platform/capabilities/network/${name}.mjs`, import.meta.url));
      return { path, ...(await hashFile(path)) }; };
    routeCapture = await createRouteObserverCapture({ directory: join(options.output, 'route-capture'), endpoint: platform.engine,
      profile: platform.profile, namespacePrefix: namespace, workloadImage: manifest.workload.imageDigest,
      observerImage: network.routeAuthority.vmObserver.imageDigest, observerUser: network.routeAuthority.vmObserver.user,
      configuration: { protocol: network.routeAuthority.vmObserver.protocol, ...network.routeAuthority.vmObserver.control,
        commandTimeoutMs: network.routeAuthority.commandTimeoutMs, maxOutputBytes: network.routeAuthority.maxOutputBytes },
      requestMs: 30000, source: await captureSource('observer-capture') });
    engineCapture = await createEngineNetworkCapture({ directory: join(options.output, 'engine-capture'), profile: platform.profile,
      namespacePrefix: namespace, workloadImage: manifest.workload.imageDigest, source: await captureSource('engine-capture') });
    proxy = await createTraceProxy({ socketPath: join(options.output, 'engine.sock'), upstreamEndpoint: platform.engine,
      tracePath: join(options.output, 'engine-requests.jsonl'), observeResponse: observer.observeResponse,
      observeResponseBody: engineCapture.observeResponseBody, observeUpgrade: routeCapture.observeUpgrade,
      maxConnections: 32, maxPendingRequests: 32 });
    proxy.setRow('catalog');
    const selectedBackend = await createCatalogBackend(sdk, { manifest, network, profile: platform.profile,
      endpoint: proxy.endpoint, namespace, output: options.output });
    const writeRecord = jsonWriter(join(options.output, 'recovery.json')); let sequence = 0;
    const recovery = { kind: 'persisted', async persist(record) {
      assert(++sequence <= 256);
      await writeFile(join(options.output, `checkpoint-${String(sequence).padStart(4, '0')}.json`),
        `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await writeRecord(record);
    } };
    state.owner = selectedBackend.backend.reserve(selectedBackend.request, recovery);
    await writeRecord(state.owner.recoveryRecord);
    stage = 'sandbox_work_failed';
    state.work = (async () => {
      const sandbox = await state.owner.start({ signal: cancellation.signal }); report.effective = sandbox.effective;
      const guest = await importGuest(sdk, sandbox, manifest);
      cancellation.signal.throwIfAborted();
      state.processOwner = sdk.sandboxNode.reserveSandboxCredentialProcess(sandbox, {
        bootstrapExecutable: manifest.bootstrap.executable, process: guest.process,
        file: { name: 'grok-auth.json', bytes: state.credential.bytes }, preparationTimeoutMs: 30000,
      });
      const streams = await state.processOwner.start({ signal: cancellation.signal }); state.credential.prepared();
      state.reader = catalogReader(streams, parseGuestResult); streams.stdin.end();
      const result = await state.reader.result; report.guest = result.result;
      if (result.exit?.kind !== 'exited' || result.exit.code !== 0) throw new CatalogFailure('guest_process_failed');
      return result;
    })();
    void state.work.catch(() => {});
    await observeWork(state.work, { timeoutMs: 180000, signal: cancellation.signal });
  } catch (error) {
    report.status = 'failed';
    report.failure = error instanceof CatalogFailure || error instanceof CatalogCredentialRefusal ? error.code : stage;
    cancellation.abort(new CatalogFailure(report.failure));
  } finally {
    await finishCatalogCleanup({ state, report, save: persist, independentAbsence: async (record) => {
      verifyObservedTuple(platform, (await engine.request('GET', '/version')).data, (await engine.request('GET', '/info')).data);
      const absence = await census(engine, record, 'original-owner-destroyed', true);
      verifyObservedTuple(platform, (await engine.request('GET', '/version')).data, (await engine.request('GET', '/info')).data);
      report.cleanup.independentAbsence = absence.length > 0 && absence.every(({ status }) => status === 404); return absence;
    },
      afterOwners: [
        async () => {
          if (observer) {
            report.cleanup.kernel = await observer.assertAllEmpty();
            if (state.reader) assert(observer.record.scopes.some((scope) => scope.role === 'compute'));
            report.cleanup.daemonScopesEmpty = observer.record.scopes.length > 0 && report.cleanup.kernel.kernelEmpty;
          }
        },
        async () => { if (proxy) {
          try { await proxy.close(); }
          catch (error) { if (!await proxyRetired(proxy, error)) throw error; report.failure ??= 'proxy_forwarding_failed'; }
          report.cleanup.proxyClosed = true;
        } },
        async () => { if (routeCapture) {
          report.routeCapture = await routeCapture.close(observer.record.scopes);
          if (report.routeCapture.status !== 'captured') report.failure ??= 'route_capture_failed';
        } },
        async () => { if (engineCapture) {
          report.engineCapture = await engineCapture.close();
          if (report.engineCapture.status !== 'captured') report.failure ??= 'engine_capture_failed';
        } },
        async () => {
          if (observer) { await observer.close(); report.cleanup.observerRemoved = observer.record.observerRemoved; }
          else if (observerEntered) await cleanupDaemonObserver({ endpoint: platform.engine, recordPath: join(observerDirectory, 'record.json') });
        },
      ] });
    try {
      const current = await lstat(platform.engine.slice(7), { bigint: true }); assert(current.isSocket() && !current.isSymbolicLink());
      assert.deepEqual({ device: String(current.dev), inode: String(current.ino), mode: String(current.mode) }, socketIdentity);
      report.observedFinal = verifyObservedTuple(platform, (await engine.request('GET', '/version')).data, (await engine.request('GET', '/info')).data);
      assert.deepEqual(await installedIdentity(options.consumer), identity);
      assert.deepEqual(await harnessIdentity(), sourceIdentity);
      for (const source of sdk.loader.sources) {
        const actual = await hashFile(join(sdk.loader.directory, source.name));
        assert.equal(actual.byteLength, source.bytes); assert.equal(actual.sha256, source.sha256);
      }
      for (const image of images) assert.equal((await engine.request('GET', `/images/${encodeURIComponent(image.imageDigest)}/json`)).data.Id, image.imageDigest);
      report.cleanup.borrowedImagesPreserved = true;
    } catch { report.failure ??= 'final_admission_failed'; }
    if (!report.guest && state.joined) report.guest = state.joined.result;
    const cleanupComplete = ['complete', 'originalOwnerDestroyed', 'processReaderJoined', 'independentAbsence',
      'daemonScopesEmpty', 'observerRemoved', 'proxyClosed', 'borrowedImagesPreserved'].every((field) => report.cleanup[field] === true);
    report.status = !report.failure && report.cleanup.failures.length === 0 && cleanupComplete && report.guest?.status === 'passed'
      && report.guest.observation === 'native' && report.guest.refresh.status === 'confirmed' ? 'passed' : 'failed';
    report.finishedAt = new Date().toISOString(); await persist();
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
  return { status: report.status, report: join(options.output, 'catalog-report.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(usage);
    else { const result = await runCatalog(parseArguments(process.argv.slice(2))); process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status !== 'passed') process.exitCode = 1; }
  } catch { process.stderr.write('{"status":"failed","failure":"admission_failed"}\n'); process.exitCode = 1; }
}
