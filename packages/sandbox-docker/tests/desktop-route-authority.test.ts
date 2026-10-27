// ------------------------------------------------------------------------------------------------
//                desktop-route-authority.test.ts - Public inert Desktop authority/configuration boundary
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '../src/index.js';
import type { DockerSandboxBackendOptions } from '../src/index.js';
import { createDockerDesktopRouteAuthority, createDockerLinuxRouteAuthority } from '../src/node/index.js';
import type { DockerDesktopRouteAuthorityOptions, DockerRouteAuthority } from '../src/node/index.js';
import { desktopRouteAuthorityOptions } from './fixtures/desktopRouteAuthority.js';
import { imageDigest, sandboxRequest } from './fixtures/engine.js';

const nativeProfile = 'desktop-apple-virtualization-native-arm64';
const rosettaProfile = 'desktop-apple-virtualization-rosetta-amd64';

function backendOptions(routeAuthority: DockerRouteAuthority): DockerSandboxBackendOptions {
  return { profile: routeAuthority.kind === 'local_docker_desktop' ? routeAuthority.profile : 'linux-x64',
    endpoint: 'unix:///absent-desktop-engine.sock', namespace: 'desktop-authority', imageDigest,
    spillDirectory: '/absent-desktop-spill', user: { uid: 1000, gid: 1000 },
    egress: { imageDigest: `sha256:${'e'.repeat(64)}`, protocol: 'agenai.sandbox.egress-connect.v1', user: { uid: 1000, gid: 1000 },
      broker: { resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2 },
      relay: { resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2 },
      routeAuthority, control: { heartbeatMs: 100, leaseTimeoutMs: 60_000 } } };
}

function reservationDigest(routeAuthority: DockerRouteAuthority): string {
  return createDockerSandboxBackend(backendOptions(routeAuthority)).reserve(sandboxRequest(), { kind: 'in_process' }).recoveryRecord.configurationDigest;
}

test('original Desktop authorities construct and reserve exact restricted ownership inertly', () => {
  for (const profile of [nativeProfile, rosettaProfile] as const) {
    const authority = createDockerDesktopRouteAuthority(desktopRouteAuthorityOptions(profile));
    assert.deepEqual(Object.keys(authority).sort(), ['kind', 'profile', 'stability']);
    assert.equal(Reflect.set(authority, 'profile', 'linux-x64'), false);
    const backend = createDockerSandboxBackend(backendOptions(authority));
    const owner = backend.reserve(sandboxRequest(), { kind: 'in_process' });
    assert.deepEqual(owner.state, { kind: 'reserved' });
    assert.deepEqual(owner.recoveryRecord.authority, { kind: 'unverified' });
    assert.deepEqual(owner.recoveryRecord.resources.map((resource) => resource.role), ['compute', 'storage', 'export']);
    const restricted = backend.reserve(sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] }),
      { kind: 'in_process' });
    assert.deepEqual(restricted.state, { kind: 'reserved' });
    assert.deepEqual(restricted.recoveryRecord.resources.map((resource) => resource.role),
      ['compute', 'storage', 'export', 'network', 'egress_socket', 'egress_broker', 'egress_relay', 'route_observer']);
  }
});

test('captured Desktop descriptor is detached from caller mutation and binds recovery identity', () => {
  const original = desktopRouteAuthorityOptions(nativeProfile);
  const authority = createDockerDesktopRouteAuthority(original);
  const before = reservationDigest(authority);
  original.engine.id = 'changed-engine';
  original.deployment.desktopBuild = 'changed-build';
  original.hostObserver.executable.sha256 = 'f'.repeat(64);
  original.vmObserver.resources.pids = 9;
  original.vmObserver.control.leaseTimeoutMs = 61_000;
  original.pollIntervalMs = 200;
  assert.equal(reservationDigest(authority), before);
  assert.notEqual(reservationDigest(createDockerDesktopRouteAuthority(original)), before);
  for (const mutate of [
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.engine.id = 'changed-engine'; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.deployment.desktopBuild = 'changed-build'; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.hostObserver.executable.sha256 = 'f'.repeat(64); },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.hostObserver.sourceDigest = `sha256:${'f'.repeat(64)}`; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.vmObserver.imageDigest = `sha256:${'f'.repeat(64)}`; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.vmObserver.sourceDigest = `sha256:${'f'.repeat(64)}`; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.vmObserver.resources.pids = 9; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.vmObserver.user.uid = 1001; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.vmObserver.temporaryBytes += 1; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.vmObserver.control.leaseTimeoutMs = 61_000; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.pollIntervalMs = 200; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.commandTimeoutMs = 2000; },
    (value: ReturnType<typeof desktopRouteAuthorityOptions>) => { value.maxOutputBytes = 131_072; },
  ]) {
    const changed = desktopRouteAuthorityOptions(nativeProfile);
    mutate(changed);
    assert.notEqual(reservationDigest(createDockerDesktopRouteAuthority(changed)), before);
  }
});

test('configuration rejects copied, serialized and descriptor substitutions and binds authority to the exact profile/endpoint', () => {
  const descriptor = desktopRouteAuthorityOptions(nativeProfile);
  const authority = createDockerDesktopRouteAuthority(descriptor);
  const options = backendOptions(authority);
  for (const replacement of [{ ...authority }, structuredClone(authority), JSON.parse(JSON.stringify(authority)), descriptor]) {
    assert.throws(() => Reflect.apply(createDockerSandboxBackend, undefined, [{ ...options,
      egress: { ...options.egress, routeAuthority: replacement } }]), SandboxValidationError);
  }
  for (const mismatch of [
    { ...options, profile: 'linux-x64' }, { ...options, profile: rosettaProfile },
    { ...options, endpoint: 'unix:///another-desktop-engine.sock' },
  ]) assert.throws(() => Reflect.apply(createDockerSandboxBackend, undefined, [mismatch]), SandboxValidationError);
  const linuxAuthority = createDockerLinuxRouteAuthority({ kind: 'local_linux_same_host', stability: 'caller_owned_quiescence',
    ipExecutable: { path: '/absent-linux-observer/ip', sha256: '1'.repeat(64) }, pollIntervalMs: 100, commandTimeoutMs: 1000, maxOutputBytes: 65_536 });
  const linuxOptions = backendOptions(linuxAuthority);
  assert.deepEqual(createDockerSandboxBackend(linuxOptions).reserve(sandboxRequest(), { kind: 'in_process' }).state, { kind: 'reserved' });
  assert.throws(() => createDockerSandboxBackend({ ...linuxOptions, profile: nativeProfile }), SandboxValidationError);
});

test('Desktop authority boundary rejects non-data graphs and unsupported fields without invoking accessors', () => {
  let reads = 0;
  const options = desktopRouteAuthorityOptions(nativeProfile);
  const accessor = { ...options.hostObserver, get sourceDigest() { reads += 1; return options.hostObserver.sourceDigest; } };
  const missingAssertion = { ...options };
  Reflect.deleteProperty(missingAssertion, 'interception');
  const missingSource = { ...options.vmObserver };
  Reflect.deleteProperty(missingSource, 'sourceDigest');
  for (const invalid of [
    missingAssertion, { ...options, vmObserver: missingSource },
    { ...options, hostObserver: accessor },
    { ...options, vmObserver: Object.defineProperty({ ...options.vmObserver }, 'hidden', { value: true }) },
    { ...options, deployment: { ...options.deployment, [Symbol('unknown')]: true } },
    { ...options, engine: Object.assign(Object.create({ inherited: true }), options.engine) },
    { ...options, observer: () => ({ excludedCidrs: [] }) },
    { ...options, vmObserver: { ...options.vmObserver, arguments: ['--arbitrary'] } },
    { ...options, exclusions: ['0.0.0.0/0'] },
  ]) assert.throws(() => Reflect.apply(createDockerDesktopRouteAuthority, undefined, [invalid]), SandboxValidationError);
  assert.equal(reads, 0);
});

test('Desktop descriptor enforces deployment, protocol, byte, resource and liveness bounds at construction', () => {
  const options = desktopRouteAuthorityOptions(nativeProfile);
  const invalid: readonly unknown[] = [
    { ...options, profile: 'linux-x64' },
    { ...options, interception: 'observed_safe' },
    { ...options, engine: { ...options.engine, endpoint: 'tcp://127.0.0.1:2375' } },
    { ...options, engine: { ...options.engine, id: '\u0000engine' } },
    { ...options, engine: { ...options.engine, id: 'é'.repeat(129) } },
    ...['rosetta', 'enhancedContainerIsolation', 'hostNetworking', 'kernelUdp', 'manualProxyConfiguration'].map((key) => ({
      ...options, deployment: { ...options.deployment, [key]: !Reflect.get(options.deployment, key) },
    })),
    { ...options, deployment: { ...options.deployment, networkingMode: 'dual-stack' } },
    { ...options, deployment: { ...options.deployment, desktopBuild: 'é'.repeat(33) } },
    { ...options, hostObserver: { ...options.hostObserver, executable: { ...options.hostObserver.executable, path: '/observer/../host' } } },
    { ...options, hostObserver: { ...options.hostObserver, executable: { ...options.hostObserver.executable, path: `/${'é'.repeat(2048)}` } } },
    { ...options, hostObserver: { ...options.hostObserver, sourceDigest: 'a'.repeat(64) } },
    { ...options, vmObserver: { ...options.vmObserver, observationProtocol: 'agenai.desktop-vm-network.v2' } },
    { ...options, vmObserver: { ...options.vmObserver, executable: '/bin/arbitrary' } },
    { ...options, vmObserver: { ...options.vmObserver, user: { uid: 0, gid: 1000 } } },
    { ...options, vmObserver: { ...options.vmObserver, resources: { ...options.vmObserver.resources, cpus: 0.0000000001 } } },
    { ...options, vmObserver: { ...options.vmObserver, resources: { ...options.vmObserver.resources, memoryBytes: Number.MAX_SAFE_INTEGER + 1 } } },
    { ...options, vmObserver: { ...options.vmObserver, control: { heartbeatMs: 100, leaseTimeoutMs: 1199 } } },
    { ...options, pollIntervalMs: 60_001 }, { ...options, commandTimeoutMs: 30_001 }, { ...options, maxOutputBytes: 4_194_305 },
  ];
  for (const value of invalid) assert.throws(() => Reflect.apply(createDockerDesktopRouteAuthority, undefined, [value]), SandboxValidationError);
  const exactLease: DockerDesktopRouteAuthorityOptions = { ...options,
    hostObserver: { ...options.hostObserver, executable: { ...options.hostObserver.executable, path: '/absent observer/host' } },
    vmObserver: { ...options.vmObserver, control: { heartbeatMs: 100, leaseTimeoutMs: 1200 } } };
  const authority = createDockerDesktopRouteAuthority(exactLease);
  assert.deepEqual(createDockerSandboxBackend(backendOptions(authority)).reserve(sandboxRequest(), { kind: 'in_process' }).state, { kind: 'reserved' });
});
