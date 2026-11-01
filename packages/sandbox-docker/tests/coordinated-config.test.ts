import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSandboxRequest, SandboxValidationError, SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS,
} from '@agen-ai/sandbox';
import type { DockerDesktopRouteAuthorityIdentity } from '../src/network/desktopAuthority.js';
import { createCoordinatedDockerSandboxBackend } from '../src/index.js';
import { registerDesktopCoordinatorAuthority } from '../src/network/desktop/coordinator/binding.js';
import type { DesktopCoordinatorBinding } from '../src/network/desktop/coordinator/binding.js';
import { parseDesktopCoordinatorConfiguration } from '../src/node/desktopCoordinatorOptions.js';
import { createDockerDesktopRouteAuthority } from '../src/node/desktopRouteAuthority.js';
import { parseCoordinatedDockerConfig, parseDockerConfig } from '../src/policy/config.js';
import type { DockerDesktopCoordinatorMemberConfiguration } from '../src/policy/options.js';
import type { DockerDesktopSandboxProfile } from '../src/policy/profiles.js';
import { configurationDigest, newRecoveryRecord, validateRecord } from '../src/recovery/identity.js';
import { desktopRouteAuthorityOptions } from './fixtures/desktopRouteAuthority.js';

const native = 'desktop-apple-virtualization-native-arm64';
const rosetta = 'desktop-apple-virtualization-rosetta-amd64';
const endpoint = 'unix:///absent-desktop-engine.sock';
const imageDigest = `sha256:${'e'.repeat(64)}`;
const control = { heartbeatMs: 1_000, leaseTimeoutMs: 60_000 };
const generation: DesktopCoordinatorBinding['identity']['generation'] = {
  generationId: 'ed746482-d594-434a-b7a1-567e5af396f1', ordinal: 1, coordinationRevision: 'desktop-coordination-v1',
  coordinationPolicyDigest: `sha256:${'1'.repeat(64)}`, engineBindingDigest: `sha256:${'2'.repeat(64)}`,
  endpointBindingDigest: `sha256:${'3'.repeat(64)}`, hostPreparationDigest: `sha256:${'4'.repeat(64)}`,
  nativeAssetDigest: `sha256:${'5'.repeat(64)}`,
};
const identity: DesktopCoordinatorBinding['identity'] = {
  protocol: 'agenai.desktop-coordinator.v1', authorityId: '862a54d9-c2dd-44f7-a465-1d9d0636322d',
  engineKey: `sha256:${'6'.repeat(64)}`, daemonId: 'desktop-unit-daemon', generation,
};

function routeOptions(profile: DockerDesktopSandboxProfile): DockerDesktopRouteAuthorityIdentity {
  const options = desktopRouteAuthorityOptions(profile, endpoint);
  return { ...options, pollIntervalMs: 1_000, commandTimeoutMs: 5_000,
    vmObserver: { ...options.vmObserver, control } };
}

function memberOptions(profile: DockerDesktopSandboxProfile, route = routeOptions(profile)): DockerDesktopCoordinatorMemberConfiguration {
  const helper = { resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2 };
  return { profile, endpoint: route.engine.endpoint, namespace: 'unit-tests', imageDigest,
    spillDirectory: '/absent-coordinated-spill', user: { uid: 1000, gid: 1000 },
    egress: { imageDigest: `sha256:${'f'.repeat(64)}`, protocol: 'agenai.sandbox.egress-connect.v1',
      user: { uid: 1000, gid: 1000 }, broker: helper, relay: helper,
      routeAuthority: createDockerDesktopRouteAuthority(route), control } };
}

function authority(options: DockerDesktopCoordinatorMemberConfiguration, original = identity) {
  const configuration = parseDesktopCoordinatorConfiguration({ routeAuthority: options.egress.routeAuthority,
    helper: { protocol: 'agenai.desktop-coordinator.v1', executable: { path: '/absent-coordinator', sha256: 'a'.repeat(64) },
      sourceDigest: `sha256:${'b'.repeat(64)}` } });
  return registerDesktopCoordinatorAuthority({ generation: original.generation.generationId, endpoint: configuration.route.identity.engine.endpoint,
    configurationDigest: configuration.sharedDigest, identity: original, assertAdmission() {},
    async enroll() { throw new Error('Configuration parsing cannot enroll a member.'); } });
}

function invalidConfiguration(path: readonly string[], message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SandboxValidationError);
    assert.deepEqual(error.issues, [{ code: 'invalid_input', path, message }]);
    return true;
  };
}

const request = parseSandboxRequest({ policy: { resources: { cpus: 0.5, memoryBytes: 64 * 1024 ** 2, pids: 32 },
  temporaryStorage: { homeBytes: 1024 ** 2, tempBytes: 2 * 1024 ** 2 },
  network: { kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] },
  execution: { kind: 'deadline', timeoutMs: 5000 }, deadlines: { startupMs: 5000, cleanupMs: 5000 },
  transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: SANDBOX_DEFAULT_STREAM_LIMITS } });

test('coordinated members share native and Rosetta preparation while retaining their own recovery identity', () => {
  const nativeOptions = memberOptions(native);
  const coordinator = authority(nativeOptions);
  const nativeConfig = parseCoordinatedDockerConfig({ ...nativeOptions, coordinator });
  const rosettaConfig = parseCoordinatedDockerConfig({ ...memberOptions(rosetta), coordinator });
  const nativeRecord = newRecoveryRecord(nativeConfig, request);
  const rosettaRecord = newRecoveryRecord(rosettaConfig, request);
  assert.equal(nativeRecord.backendRevision, 'engine-1.52-v7-desktop-apple-virtualization-native-arm64');
  assert.equal(rosettaRecord.backendRevision, 'engine-1.52-v7-desktop-apple-virtualization-rosetta-amd64');
  assert.equal(validateRecord(nativeRecord, nativeConfig), true);
  assert.equal(validateRecord(rosettaRecord, rosettaConfig), true);
  assert.equal(validateRecord(nativeRecord, rosettaConfig), false);
  assert.equal(validateRecord(rosettaRecord, nativeConfig), false);
  assert.equal(Object.isFrozen(nativeConfig.coordination), true);
  assert.equal(Object.isFrozen(nativeConfig.coordination.generation), true);
});

test('coordinated recovery binds every immutable generation identity field and exact member configuration', () => {
  const options = memberOptions(native);
  const config = parseCoordinatedDockerConfig({ ...options, coordinator: authority(options) });
  const record = newRecoveryRecord(config, request);
  const alternate = `sha256:${'9'.repeat(64)}`;
  const changedIdentities: DesktopCoordinatorBinding['identity'][] = [
    { ...identity, authorityId: '4047283c-2b78-4f34-9807-13800728f192' },
    { ...identity, engineKey: alternate }, { ...identity, daemonId: 'replacement-daemon' },
    { ...identity, generation: { ...generation, generationId: '230deff5-a518-48e9-9306-c43b1b3df4b1' } },
    { ...identity, generation: { ...generation, ordinal: 2 } },
    ...(['coordinationPolicyDigest', 'engineBindingDigest', 'endpointBindingDigest', 'hostPreparationDigest', 'nativeAssetDigest'] as const)
      .map((field) => ({ ...identity, generation: { ...generation, [field]: alternate } })),
  ];
  for (const original of changedIdentities) {
    const changed = parseCoordinatedDockerConfig({ ...options, coordinator: authority(options, original) });
    assert.equal(validateRecord(record, changed), false);
  }
  for (const changedOptions of [{ ...options, namespace: 'another-member' },
    { ...options, spillDirectory: '/another-original-spill' }, { ...options, imageDigest: alternate }]) {
    const changed = parseCoordinatedDockerConfig({ ...changedOptions, coordinator: authority(options) });
    assert.equal(validateRecord(record, changed), false);
  }
  assert.equal(validateRecord(record, config), true);
});

test('coordinated configuration refuses copied capability, wrong member route, shared preparation, endpoint and helper timing', () => {
  const options = memberOptions(native);
  const coordinator = authority(options);
  for (const copied of [{ ...coordinator }, { kind: 'desktop_coordinator', generation: coordinator.generation }]) {
    assert.throws(() => Reflect.apply(createCoordinatedDockerSandboxBackend, undefined, [{ ...options, coordinator: copied }]),
      /original active coordinator capability/u);
  }
  assert.throws(() => parseCoordinatedDockerConfig({ ...options, profile: rosetta, coordinator }), SandboxValidationError);
  const route = routeOptions(native);
  const changedHost = { ...route, hostObserver: { ...route.hostObserver, sourceDigest: `sha256:${'9'.repeat(64)}` } };
  const changedEndpoint = { ...route, engine: { ...route.engine, endpoint: 'unix:///another-engine.sock' } };
  for (const changedRoute of [changedHost, changedEndpoint]) {
    assert.throws(() => parseCoordinatedDockerConfig({ ...memberOptions(native, changedRoute), coordinator }),
      invalidConfiguration(['coordinator'], 'Member route authority must match the original coordinator endpoint and shared Desktop preparation'));
  }
  assert.throws(() => parseCoordinatedDockerConfig({ ...options, coordinator,
    egress: { ...options.egress, control: { ...control, heartbeatMs: 100 } } }),
  invalidConfiguration(['egress', 'control'], 'Coordinated Desktop members require the fixed helper control timing composition'));
  assert.throws(() => parseCoordinatedDockerConfig({ ...options, coordinator, filesystem: {
    imageDigest, protocol: 'agenai.sandbox.filesystem.v1', executable: '/usr/local/bin/agenai-sandbox-files',
    layout: 'agenai.sandbox.workspace.v1', user: options.user, resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 },
    temporaryBytes: 1024 ** 2, control: { ...control, leaseTimeoutMs: 50_000 },
  } }), invalidConfiguration(['egress', 'control'], 'Coordinated Desktop members require the fixed helper control timing composition'));
  const config = parseCoordinatedDockerConfig({ ...options, coordinator });
  assert.equal(config.profile, native);
  assert.equal(config.egress.routeAuthority.engine.endpoint, endpoint);
});

test('legacy Desktop configuration keeps its original digest and v6 recovery boundary', () => {
  const config = parseDockerConfig({ profile: native, endpoint, namespace: 'unit-tests', imageDigest,
    spillDirectory: '/absent-coordinated-spill', user: { uid: 1000, gid: 1000 } });
  assert.equal(configurationDigest(config), 'sha256:14f7ce040928a94d121ac778f743a2d3cfdefc754e9e0980df1299cdf5b7f85d');
  const isolatedRequest = parseSandboxRequest({ ...request, policy: { ...request.policy, network: { kind: 'isolated' } } });
  assert.equal(newRecoveryRecord(config, isolatedRequest).backendRevision, 'engine-1.52-v6-desktop-apple-virtualization-native-arm64');
  const options = memberOptions(native);
  const coordinated = parseCoordinatedDockerConfig({ ...options, coordinator: authority(options) });
  assert.equal(validateRecord(newRecoveryRecord(coordinated, request), config), false);
});
