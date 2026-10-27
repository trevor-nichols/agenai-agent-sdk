import assert from 'node:assert/strict';
import { physicalPath } from './input.mjs';
import { boundedText, control, endpoint, imageDigest, integer, keys, resources, sha256, temporaryBytes, user } from './validation.mjs';

function executable(value) {
  keys(value, ['path', 'sha256']); physicalPath(value.path); sha256(value.sha256);
}

export function routeAuthority(value, platform) {
  if (platform.profile === 'linux-x64') {
    keys(value, ['kind', 'stability', 'ipExecutable', 'pollIntervalMs', 'commandTimeoutMs', 'maxOutputBytes']);
    assert.equal(value.kind, 'local_linux_same_host', 'Linux profile requires Linux route authority.');
    assert.equal(value.stability, 'caller_owned_quiescence');
    executable(value.ipExecutable);
    assert(!value.ipExecutable.path.includes(' '), 'Linux observer path must preserve the public no-whitespace grammar.');
    // The existing Linux public authority retains its original timing bounds.
    integer(value.pollIntervalMs, 25, 2_147_483_647, 'pollIntervalMs');
    integer(value.commandTimeoutMs, 1, 2_147_481_147, 'commandTimeoutMs');
    integer(value.maxOutputBytes, 1024, 4 * 1024 ** 2, 'maxOutputBytes');
    return;
  }
  keys(value, ['kind', 'profile', 'stability', 'interception', 'engine', 'deployment', 'hostObserver', 'vmObserver',
    'pollIntervalMs', 'commandTimeoutMs', 'maxOutputBytes']);
  assert.equal(value.kind, 'local_docker_desktop', 'Desktop profile requires Desktop route authority.');
  assert.equal(value.profile, platform.profile, 'Authority profile differs from the baseline manifest.');
  assert.equal(value.stability, 'caller_owned_quiescence');
  assert.equal(value.interception, 'caller_owned_no_transparent_or_per_app_interception');
  keys(value.engine, ['endpoint', 'id']); endpoint(value.engine.endpoint); boundedText(value.engine.id, 1, 256, 'Engine ID');
  assert.equal(value.engine.endpoint, platform.engine, 'Authority Engine endpoint differs from the baseline manifest.');
  assert.equal(value.engine.id, platform.expected.daemon.id, 'Authority Engine ID differs from the baseline manifest.');
  keys(value.deployment, ['desktopVersion', 'desktopBuild', 'virtualMachineManager', 'rosetta', 'enhancedContainerIsolation',
    'hostNetworking', 'kernelUdp', 'networkingMode', 'dnsInhibition', 'dockerSubnet', 'proxyMode', 'manualProxyConfiguration']);
  boundedText(value.deployment.desktopVersion, 1, 64, 'Desktop version');
  boundedText(value.deployment.desktopBuild, 1, 64, 'Desktop build');
  assert.equal(value.deployment.desktopVersion, platform.desktop.version, 'Authority Desktop version differs from baseline.');
  assert.equal(platform.desktop.vmm, 'apple-virtualization');
  assert.equal(platform.desktop.rosetta, true, 'Advanced Desktop qualification requires explicit Rosetta enablement.');
  assert.equal(platform.desktop.enhancedContainerIsolation, false);
  for (const [field, expected] of Object.entries({ virtualMachineManager: 'apple_virtualization', rosetta: true,
    enhancedContainerIsolation: false, hostNetworking: false, kernelUdp: false, networkingMode: 'ipv4only', dnsInhibition: 'auto',
    dockerSubnet: '192.168.65.0/24', proxyMode: 'automatic_system', manualProxyConfiguration: false })) {
    assert.equal(value.deployment[field], expected, `Unsupported Desktop deployment ${field}.`);
  }
  keys(value.hostObserver, ['protocol', 'executable', 'sourceDigest']);
  assert.equal(value.hostObserver.protocol, 'agenai.desktop-host-network.v1');
  executable(value.hostObserver.executable); imageDigest(value.hostObserver.sourceDigest);
  keys(value.vmObserver, ['protocol', 'observationProtocol', 'imageDigest', 'sourceDigest', 'executable', 'user', 'resources',
    'temporaryBytes', 'control']);
  assert.equal(value.vmObserver.protocol, 'agenai.sandbox.desktop-route-observer.v1');
  assert.equal(value.vmObserver.observationProtocol, 'agenai.desktop-vm-network.v1');
  assert.equal(value.vmObserver.executable, '/usr/local/bin/agenai-sandbox-desktop-route');
  imageDigest(value.vmObserver.imageDigest); imageDigest(value.vmObserver.sourceDigest);
  user(value.vmObserver.user); resources(value.vmObserver.resources); temporaryBytes(value.vmObserver.temporaryBytes);
  integer(value.pollIntervalMs, 25, 60_000, 'pollIntervalMs');
  integer(value.commandTimeoutMs, 1, 30_000, 'commandTimeoutMs');
  integer(value.maxOutputBytes, 1024, 4 * 1024 ** 2, 'maxOutputBytes');
  control(value.vmObserver.control, value.commandTimeoutMs);
}
