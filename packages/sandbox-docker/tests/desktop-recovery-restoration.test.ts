import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi } from '../src/resources/api.js';
import { captureRecoveryEngine, assertNoRunningRecoveryContainers, assertRestoredEngine } from '../src/node/desktopRecovery/restoration/engine.js';
import type { RecoveryEngineObservation } from '../src/node/desktopRecovery/restoration/engine.js';
import { RestorationClassifier } from '../src/node/desktopRecovery/restoration/classifier.js';
import { parseRecoveryMetadata } from '../src/node/desktopRecovery/restoration/metadata.js';
import type { NativeFact, RecoveryNativeLogBytes } from '../src/node/desktopRecovery/native/schemas.js';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const vmId = '11111111-1111-4111-8111-111111111111';
const containerId = 'a'.repeat(64);
const version = { Version: '29.1.2', ApiVersion: '1.52', MinAPIVersion: '1.44', GitCommit: 'de45c2a',
  Os: 'linux', Arch: 'arm64', KernelVersion: '6.12.54-linuxkit' };
const info = { ID: 'original-engine', DockerRootDir: '/var/lib/docker', Driver: 'overlayfs',
  DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']], Architecture: 'aarch64', KernelVersion: '6.12.54-linuxkit',
  LiveRestoreEnabled: false, OSType: 'linux', OperatingSystem: 'Docker Desktop', CgroupVersion: '2', CgroupDriver: 'cgroupfs',
  SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'], ServerVersion: '29.1.2', Name: 'docker-desktop',
  MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true };

async function withEngine(use: (context: Readonly<{ api: DockerApi; requests: string[];
  changeInfo: (change: Readonly<Record<string, unknown>>) => void;
  setContainers: (containers: readonly unknown[]) => void }>) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agenai-recovery-engine-')));
  const path = join(directory, 'engine.sock');
  let currentInfo: unknown = info;
  let containers: readonly unknown[] = [{ Id: containerId, Names: ['/preserved'], State: 'created' }];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const value = request.url === '/version' ? version : request.url === '/info' ? currentInfo
      : request.url === '/v1.52/containers/json?all=1' ? containers : undefined;
    response.writeHead(value === undefined || request.method !== 'GET' ? 400 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value ?? {}));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  try { await use({ api: new DockerApi(new DockerEngine(path), 1_000), requests,
    changeInfo: (change) => { currentInfo = { ...info, ...change }; }, setContainers: (value) => { containers = value; } }); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('restoration reads actual bounded GETs, preserves the exact Engine/store identity and excludes workload counters from its stable identity', async () => {
  await withEngine(async ({ api, requests, changeInfo, setContainers }) => {
    const before = await captureRecoveryEngine(api, 'original-engine');
    assertNoRunningRecoveryContainers(before);
    changeInfo({ Containers: 99, ContainersStopped: 99, SystemTime: 'later', SecurityOptions: [...info.SecurityOptions].reverse() });
    setContainers([]);
    const after = await captureRecoveryEngine(api, 'original-engine');
    assertRestoredEngine(before, after);
    assert.equal(before.engineIdentityDigest, after.engineIdentityDigest);
    assert.deepEqual(before.containers.map((container) => container.Id), [containerId]);
    assert.deepEqual(after.containers, []);
    assert.deepEqual(requests, Array.from({ length: 2 }, () => ['GET /version', 'GET /info', 'GET /v1.52/containers/json?all=1']).flat());
    for (const change of [{ ID: 'other-engine' }, { DockerRootDir: '/different-store' }, { LiveRestoreEnabled: true },
      { DriverStatus: [['driver-type', 'other-store']] }, { KernelVersion: 'other-kernel' }]) {
      changeInfo(change);
      await assert.rejects(captureRecoveryEngine(api, 'original-engine'));
    }
  });
});

test('observation refuses running containers, truncated IDs, duplicate IDs and an overflowing complete container census', async () => {
  await withEngine(async ({ api, setContainers }) => {
    setContainers([{ Id: containerId, Names: ['/running'], State: 'running' }]);
    const running = await captureRecoveryEngine(api, 'original-engine');
    assert.throws(() => assertNoRunningRecoveryContainers(running));
    for (const containers of [[{ Id: containerId.slice(0, 12), Names: ['/short'], State: 'created' }],
      [{ Id: containerId, Names: ['/one'], State: 'created' }, { Id: containerId, Names: ['/two'], State: 'created' }],
      Array.from({ length: 4097 }, (_, index) => ({ Id: index.toString(16).padStart(64, '0'), Names: [`/c${index}`], State: 'created' }))]) {
      setContainers(containers);
      await assert.rejects(captureRecoveryEngine(api, 'original-engine'));
    }
  });
});

function startupLines(warnings = true): string[] {
  const line = (component: string, msg: string, fields: Readonly<Record<string, unknown>> = {}) => JSON.stringify({ component, level: 'info', msg, ...fields });
  return [line('kmsg', 'Linux version 6.12.54-linuxkit (qualified build)'),
    line('kmsg', `Kernel command line: init=/initd com.docker.VMID=${vmId}`),
    line('containerd', 'starting containerd', { version: 'v2.2.0', revision: '1c4457e00facac03ce1d75f7b6777a7a851e5c41' }),
    ...(warnings ? [line('containerd', 'Configuration migrated from version 2, use `containerd config migrate` to avoid migration', { level: 'warning' })] : []),
    ...(warnings ? [line('containerd', 'skip loading plugin', { id: 'io.containerd.snapshotter.v1.blockfile', type: 'io.containerd.snapshotter.v1', error: 'no scratch file generator: skip plugin' }),
      line('containerd', 'skip loading plugin', { id: 'io.containerd.differ.v1.erofs', type: 'io.containerd.differ.v1', error: 'failed to check mkfs.erofs availability: failed to run mkfs.erofs --help: exec: "mkfs.erofs": executable file not found in $PATH: skip plugin' }),
      line('containerd', 'skip loading plugin', { id: 'io.containerd.internal.v1.tracing', type: 'io.containerd.internal.v1', error: 'skip plugin: tracing endpoint not configured' })] : []),
    line('dockerd', 'containerd is ready'), line('dockerd', 'adding process 280 to /sys/fs/cgroup/restricted'),
    line('dockerd', 'Starting up'),
    ...(warnings ? [line('dockerd', '"containerd-snapshotter" is now the default and no longer needed to be set', { level: 'warning' })] : []),
    line('dockerd', 'Loading containers: start.'), line('dockerd', 'Restoring containers: start.'),
    ...(warnings ? [line('dockerd', 'failed to determine if container is already mounted', { level: 'warning', container: containerId }),
      line('dockerd', 'Deleting nftables IPv4 rules', { error: 'exit status 1' }),
      line('otelcol', 'telemetry not implemented', { level: 'warning' })] : []),
    line('dockerd', 'Loading containers: done.'), line('dockerd', 'Daemon has completed initialization'),
    line('dockerd', 'API listen on /var/run/docker.raw.sock')];
}

function chunks(bytes: Uint8Array, split = 193, source: 'init' | 'console' = 'init'): Array<RecoveryNativeLogBytes & { bytes: Uint8Array }> {
  const result: Array<RecoveryNativeLogBytes & { bytes: Uint8Array }> = [];
  for (let index = 0; index < bytes.length; index += split) {
    const piece = bytes.subarray(index, index + split);
    const initialOffset = source === 'init' ? 100 : 0;
    result.push({ kind: 'log_bytes', phase: 'observed', source, sourceIdentity: source === 'init' ? 'native-inode-1' : 'native-console-1',
      sequence: result.length + 1, start: String(index + initialOffset), end: String(index + initialOffset + piece.length),
      sha256: sha(piece), bytesBase64: Buffer.from(piece).toString('base64'), bytes: piece, done: index + split >= bytes.length });
  }
  return result;
}

function factBinding(): Omit<Extract<NativeFact, { kind: 'finished' }>, 'kind' | 'facts' | 'spans' | 'spanManifestSha256'> {
  return { format: 'agenai.desktop-recovery-native-fact.v1', engineKey: 'a'.repeat(64), authorityId: vmId,
    generationId: vmId, recoveryKey: 'b'.repeat(64), attempt: 1, originFrameDigest: 'c'.repeat(64), canonicalPayloadSha256: 'd'.repeat(64),
    claim: { rootDevice: '1', rootInode: '2', lockDevice: '3', lockInode: '4' }, previousHistory: { kind: 'none' }, previous: null,
    issuer: { sourceDigest: 'e'.repeat(64), executableSha256: 'f'.repeat(64) }, profileDigest: '1'.repeat(64), hostBoot: vmId,
    uid: 501, startedContinuousNs: '100', finishedContinuousNs: '200' };
}
function armedFact(parts: readonly RecoveryNativeLogBytes[]): Extract<NativeFact, { kind: 'armed' }> {
  return { ...factBinding(), kind: 'armed', producers: [], watchCount: 2, deadlineContinuousNs: '600000000100',
    logSources: [{ source: 'init', sourceIdentity: parts[0]?.sourceIdentity ?? 'native-inode-1', initialOffset: '100' },
      { source: 'console', sourceIdentity: 'native-console-1', initialOffset: '0' }] };
}
function finishedFact(parts: readonly RecoveryNativeLogBytes[]): Extract<NativeFact, { kind: 'finished' }> {
  const spans = parts.map(({ source, sourceIdentity, sequence, start, end, sha256 }) => ({ source, sourceIdentity, sequence, start, end, sha256 }));
  return { ...factBinding(), kind: 'finished', spans, spanManifestSha256: sha(JSON.stringify(spans)),
    facts: { profileDigest: '1'.repeat(64), hostBoot: vmId, uid: 501, continuousNs: '200', images: [], processes: [],
      peer: { pid: 50, uid: 501, pidVersion: 1, device: '2', inode: '3' },
      store: { parentDevice: '1', parentInode: '2', device: '1', inode: '3', uid: '501', mode: '33152', birthSeconds: '1', birthNanoseconds: '0' },
      metadata: { components: { sha256: 'a'.repeat(64), bytes: 5 }, settings: { sha256: 'b'.repeat(64), bytes: 5 } } } };
}

const tcpListener = JSON.stringify({ component: 'dockerd', level: 'info', msg: 'API listen on [::]:2375' });

for (const tcpFirst of [false, true]) {
  test(`streamed classifier accepts ${tcpFirst ? 'TCP then Unix' : 'Unix then TCP'} listeners after initialization and binds full-ID restored visibility`, async () => {
    await withEngine(async ({ api, setContainers }) => {
      const engine = await captureRecoveryEngine(api, 'original-engine');
      const shutdown = JSON.stringify({ component: 'dockerd', level: 'info', msg: 'stopping event stream following graceful shutdown', error: null });
      const lines = startupLines();
      const unix = lines.pop(); assert(unix);
      const listeners = tcpFirst ? [tcpListener, unix] : [unix, tcpListener];
      const parts = chunks(Buffer.from(`${shutdown}\n${[...lines, ...listeners].join('\n')}\n`));
      const classifier = new RestorationClassifier('33333333-3333-4333-8333-333333333333');
      parts.forEach((part) => classifier.consume(part));
      assert.equal(classifier.complete, true);
      const evidence = classifier.finish(finishedFact(parts), engine, armedFact(parts));
      assert.equal(evidence.events.length, 10);
      assert.deepEqual(evidence.warnings.map((warning) => warning.kind), ['containerd_config_migration', 'snapshotter_deprecation', 'mount_probe', 'nftables_cleanup']);
      assert.deepEqual(evidence.diagnostics.map((diagnostic) => diagnostic.kind), ['containerd_blockfile_unconfigured',
        'containerd_erofs_differ_unavailable', 'containerd_tracing_unconfigured', 'telemetry_unimplemented']);
      assert.equal(evidence.engineIdentityDigest, engine.engineIdentityDigest);
      assert(Object.isFrozen(evidence));
      const missing = new RestorationClassifier(); parts.forEach((part) => missing.consume(part));
      setContainers([]);
      await assert.rejects(async () => missing.finish(finishedFact(parts), await captureRecoveryEngine(api, 'original-engine'), armedFact(parts)), /full-ID container visibility/u);
    });
  });
}

test('classifier independently orders containerd startup while preserving every required boot and dockerd boundary', async () => {
  await withEngine(async ({ api }) => {
    const engine = await captureRecoveryEngine(api, 'original-engine');
    const lines = startupLines();
    const containerd = lines.filter((line) => line.includes('"component":"containerd"'));
    const other = lines.filter((line) => !line.includes('"component":"containerd"'));
    const positions = [1, 2, ...other.flatMap((line, index) => line.includes('"component":"dockerd"') ? [index + 1] : [])];
    for (const position of positions) {
      const input = [...other.slice(0, position), ...containerd, ...other.slice(position)];
      const parts = chunks(Buffer.from(`${input.join('\n')}\n`), 73);
      const classifier = new RestorationClassifier();
      parts.forEach((part) => classifier.consume(part));
      const evidence = classifier.finish(finishedFact(parts), engine, armedFact(parts));
      assert.equal(classifier.complete, true, `containerd position ${position}`);
      assert.deepEqual(evidence.events.map((event) => event.kind), ['linux_boot', 'vm_identity', 'containerd_ready',
        'dockerd_process', 'dockerd_start', 'load_start', 'restore_start', 'load_complete', 'initialization_complete', 'api_listen']);
      assert.equal(evidence.diagnostics.filter((diagnostic) => diagnostic.kind.startsWith('containerd_')).length, 3);
    }
    const delayed = chunks(Buffer.from(`${[...other, tcpListener].join('\n')}\n`));
    const missing = new RestorationClassifier(); delayed.forEach((part) => missing.consume(part));
    assert.equal(missing.complete, false);
    assert.throws(() => missing.finish(finishedFact(delayed), engine, armedFact(delayed)), /no complete fresh Linux/u);
    const start = containerd[0]; const last = containerd.at(-1); assert(start && last);
    const invalid = [[...containerd.slice(1), start], [start, ...containerd],
      containerd.map((line) => line.replace('v2.2.0', 'v2.2.1')),
      containerd.map((line) => line.replace('tracing endpoint not configured', 'tracing backend failed')),
      [...containerd, last]];
    for (const startup of invalid) {
      const parts = chunks(Buffer.from(`${[...other, ...startup].join('\n')}\n`));
      const classifier = new RestorationClassifier();
      assert.throws(() => parts.forEach((part) => classifier.consume(part)));
    }
  });
});

test('classifier rejects saved-resume, missing/reordered boundaries, unknown restore anomalies and unreviewed migration branches', async () => {
  await withEngine(async ({ api }) => {
    const engine = await captureRecoveryEngine(api, 'original-engine');
    const lines = startupLines();
    const invalid = [lines.filter((line) => !line.includes('Linux version')),
      [...lines.slice(0, -2), tcpListener, ...lines.slice(-2)],
      [...lines.slice(0, -1), tcpListener],
      [...lines, lines.at(-1)],
      [...lines.slice(0, -1), tcpListener.replace('[::]:2375', '127.0.0.1:2375'), ...lines.slice(-1)],
      [...lines.slice(0, -1), tcpListener.replace('"level":"info"', '"level":"error"'), ...lines.slice(-1)],
      [...lines.slice(0, -1), JSON.stringify({ component: 'dockerd', level: 'info', msg: 'API listen on [::]:2375', error: 'unclassified' }), ...lines.slice(-1)],
      lines.map((line) => line.replace('Linux version 6.12.54-linuxkit', 'Linux version 6.12.55-linuxkit')),
      [lines[0], ...lines],
      [lines[0], ...lines.slice(2), lines[1]],
      [...lines.slice(0, 1), JSON.stringify({ component: 'dockerd', level: 'info', msg: 'stopping event stream following graceful shutdown', error: null }), ...lines.slice(1)],
      lines.filter((line) => !line.includes('Restoring containers: start.')),
      [...lines.slice(0, -1), JSON.stringify({ component: 'dockerd', level: 'info', msg: 'failed to register container' }), ...lines.slice(-1)],
      lines.map((line) => line.replace('Configuration migrated from version 2', 'Configuration migrated from version 1')),
      lines.map((line) => line.replace('1c4457e00facac03ce1d75f7b6777a7a851e5c41', '0'.repeat(40))),
      lines.map((line) => line.replace('no scratch file generator: skip plugin', 'scratch file unreadable: skip plugin')),
      lines.map((line) => line.replace('io.containerd.snapshotter.v1.blockfile', 'io.containerd.snapshotter.v1.overlayfs')),
      lines.map((line) => line.replace('skip loading plugin', 'failed to load required plugin')),
      lines.map((line) => line.replace('Loading containers: done.', 'Loading containers: start.'))];
    for (const input of invalid) {
      const classifier = new RestorationClassifier();
      const parts = chunks(Buffer.from(`${input.join('\n')}\n`));
      assert.throws(() => { parts.forEach((part) => classifier.consume(part)); classifier.finish(finishedFact(parts), engine, armedFact(parts)); });
    }
    const sameVm = new RestorationClassifier(vmId);
    assert.throws(() => chunks(Buffer.from(`${lines.join('\n')}\n`)).forEach((part) => sameVm.consume(part)), /new qualified VM identity/u);
  });
});

test('classifier covers opaque console bytes without applying init record framing and still requires exact complete native coverage', async () => {
  await withEngine(async ({ api }) => {
    const engine = await captureRecoveryEngine(api, 'original-engine');
    const init = chunks(Buffer.from(`${startupLines(false).join('\n')}\n`));
    const consoleBytes = Buffer.concat([Buffer.alloc(66_981, 120), Buffer.from('\r\n'), Uint8Array.of(0xff, 0xfe), Buffer.from('partial console record')]);
    const consoleParts = chunks(consoleBytes, 65_536, 'console').map((part) => ({ ...part, sequence: part.sequence + init.length }));
    const parts = [...init, ...consoleParts];
    const classifier = new RestorationClassifier();
    parts.forEach((part) => classifier.consume(part));
    const evidence = classifier.finish(finishedFact(parts), engine, armedFact(parts));
    assert.equal(classifier.complete, true);
    assert.deepEqual(evidence.spans.filter((span) => span.source === 'console'), consoleParts.map((part) => ({
      source: part.source, sourceIdentity: part.sourceIdentity, sequence: part.sequence,
      start: part.start, end: part.end, sha256: `sha256:${part.sha256}` })));
    const incomplete = new RestorationClassifier(); consoleParts.forEach((part) => incomplete.consume(part));
    assert.throws(() => incomplete.finish(finishedFact(consoleParts), engine, armedFact(init)), /no complete fresh Linux/u);
    const omitted = new RestorationClassifier(); parts.forEach((part) => omitted.consume(part));
    assert.throws(() => omitted.finish(finishedFact(init), engine, armedFact(parts)), /exactly the classified byte interval/u);
    const first = consoleParts[0]; const second = consoleParts[1]; assert(first && second);
    for (const wrong of [first, { ...second, start: String(BigInt(second.start) + 1n), end: String(BigInt(second.end) + 1n) }]) {
      const invalid = new RestorationClassifier(); [...init, first].forEach((part) => invalid.consume(part));
      assert.throws(() => invalid.consume(wrong), /ordering|gap, replay/u);
    }
  });
});

test('classifier binds exact covered spans and refuses gap/replay, omitted final spans, baseline bytes and invalid UTF8 or oversized lines', async () => {
  await withEngine(async ({ api }) => {
    const engine: RecoveryEngineObservation = await captureRecoveryEngine(api, 'original-engine');
    const parts = chunks(Buffer.from(`${startupLines(false).join('\n')}\n`));
    const first = parts[0]; const second = parts[1]; assert(first && second);
    for (const wrong of [{ ...second, start: String(BigInt(second.start) + 1n), end: String(BigInt(second.end) + 1n) },
      { ...second, sequence: first.sequence }, { ...second, phase: 'baseline' as const }]) {
      const classifier = new RestorationClassifier(); classifier.consume(first);
      assert.throws(() => classifier.consume(wrong));
    }
    const classifier = new RestorationClassifier(); parts.forEach((part) => classifier.consume(part));
    assert.throws(() => classifier.finish(finishedFact(parts.slice(0, -1)), engine, armedFact(parts)), /exactly the classified byte interval/u);
    const wrongOffset = new RestorationClassifier(); parts.forEach((part) => wrongOffset.consume(part));
    const armed = armedFact(parts);
    assert.throws(() => wrongOffset.finish(finishedFact(parts), engine,
      { ...armed, logSources: armed.logSources.map((source) => ({ ...source, initialOffset: '0' })) }), /actual armed source offset/u);
    for (const bytes of [Uint8Array.of(0xff, 10), Buffer.alloc(65_537, 32)]) {
      const invalid = new RestorationClassifier();
      assert.throws(() => chunks(bytes, 65_536).forEach((part) => invalid.consume(part)));
    }
  });
});

test('metadata parsing binds full canonical configuration without retaining raw secret-bearing metadata', () => {
  const components = { appVersion: '4.54.0', buildNumber: '212467', engineVersion: '29.1.2', desktopCliVersion: 'v0.2.0', linuxVersion: 'v6.12.54' };
  assert.match(parseRecoveryMetadata('components', Buffer.from(JSON.stringify(components))).digest, /^sha256:[a-f0-9]{64}$/u);
  assert.throws(() => parseRecoveryMetadata('components', Buffer.from(JSON.stringify({ ...components, engineVersion: '29.1.3' }))));
  const original = parseRecoveryMetadata('settings', Buffer.from('{"Cpus":4,"localSecret":"redacted-fixture"}'));
  const equivalent = parseRecoveryMetadata('settings', Buffer.from('{"localSecret":"redacted-fixture","Cpus":4}'));
  const changed = parseRecoveryMetadata('settings', Buffer.from('{"Cpus":8,"localSecret":"redacted-fixture"}'));
  assert.deepEqual(original, equivalent); assert.notEqual(original.digest, changed.digest);
  assert.deepEqual(Object.keys(original), ['digest']);
  const privateText = 'private-token-123';
  const sanitized = (cause: unknown) => {
    let current = cause;
    while (current instanceof Error) { assert(!current.message.includes(privateText)); current = current.cause; }
    return true;
  };
  assert.throws(() => parseRecoveryMetadata('settings', Buffer.from(privateText)), sanitized);
  const classifier = new RestorationClassifier();
  assert.throws(() => chunks(Buffer.from(`${privateText}\n`)).forEach((part) => classifier.consume(part)), sanitized);
});
