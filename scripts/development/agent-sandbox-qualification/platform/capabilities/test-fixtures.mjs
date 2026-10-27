export const image = `sha256:${'1'.repeat(64)}`;
const digest = '2'.repeat(64);
const resources = () => ({ cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 16 });
const user = () => ({ uid: 1000, gid: 1000 });
const control = () => ({ heartbeatMs: 1000, leaseTimeoutMs: 60_000 });
const helperBudget = () => ({ resources: resources(), temporaryBytes: 1024 ** 2 });

export function platformManifest(profile = 'linux-x64', engine = 'unix:///tmp/unentered-platform-engine.sock') {
  const desktop = profile !== 'linux-x64';
  return { format: 'agenai.sandbox-platform-manifest.v1', engine, profile, sourceImage: image, observerImage: image,
    expected: { controller: { os: desktop ? 'darwin' : 'linux', architecture: desktop ? 'arm64' : 'x64', nodeVersion: '24.18.0' },
      daemon: { id: 'selected-daemon', version: '29.1.3', apiVersion: '1.52', architecture: desktop ? 'arm64' : 'amd64',
        kernelVersion: 'selected-kernel', operatingSystem: desktop ? 'Docker Desktop' : 'selected-linux' } },
    desktop: desktop ? { version: '4.54.0', applicationPlist: '/unopened/Docker.app/Info.plist',
      vmm: 'apple-virtualization', rosetta: true, enhancedContainerIsolation: false } : null };
}

function authority(platform) {
  const common = { stability: 'caller_owned_quiescence', pollIntervalMs: 1000, commandTimeoutMs: 10_000, maxOutputBytes: 65_536 };
  if (platform.profile === 'linux-x64') return { kind: 'local_linux_same_host', ...common,
    ipExecutable: { path: '/unopened/ip', sha256: digest } };
  return { kind: 'local_docker_desktop', ...common, profile: platform.profile,
    interception: 'caller_owned_no_transparent_or_per_app_interception',
    engine: { endpoint: platform.engine, id: platform.expected.daemon.id },
    deployment: { desktopVersion: platform.desktop.version, desktopBuild: '210000', virtualMachineManager: 'apple_virtualization',
      rosetta: true, enhancedContainerIsolation: false, hostNetworking: false, kernelUdp: false, networkingMode: 'ipv4only',
      dnsInhibition: 'auto', dockerSubnet: '192.168.65.0/24', proxyMode: 'automatic_system', manualProxyConfiguration: false },
    hostObserver: { protocol: 'agenai.desktop-host-network.v1', executable: { path: '/unopened/observer', sha256: digest }, sourceDigest: image },
    vmObserver: { protocol: 'agenai.sandbox.desktop-route-observer.v1', observationProtocol: 'agenai.desktop-vm-network.v1',
      imageDigest: image, sourceDigest: image, executable: '/usr/local/bin/agenai-sandbox-desktop-route', user: user(),
      ...helperBudget(), control: control() } };
}

export function capabilityManifest(row, platformInputSha256, platform = platformManifest()) {
  return { format: 'agenai.sandbox-platform-capabilities.v1', platformManifestSha256: platformInputSha256,
    profile: platform.profile, row, workload: { user: user(), ...helperBudget() },
    limits: { startupMs: 5000, requestMs: 10_000, cleanupMs: 10_000, scenarioMs: 60_000, maxOutputBytes: 65_536 },
    ...(['live-files', 'preserve-internal', 'combined'].includes(row) ? { filesystem: { sourceDigest: image, configuration: {
      imageDigest: image, protocol: 'agenai.sandbox.filesystem.v1', executable: '/usr/local/bin/agenai-sandbox-files',
      layout: 'agenai.sandbox.workspace.v1', user: user(), ...helperBudget(), control: control() } } } : {}),
    ...(['preserve-internal', 'combined'].includes(row) ? { transfers: { hostRoots: platform.profile === 'linux-x64'
      ? [{ role: 'controller', parent: '/unopened/controller' }]
      : [{ role: 'controller_internal', parent: '/unopened/internal' }, { role: 'controller_external', parent: '/unopened/external' }] } } : {}),
    ...(['restricted-https', 'combined'].includes(row) ? { network: { egress: { sourceDigest: image,
      configuration: { imageDigest: image, protocol: 'agenai.sandbox.egress-connect.v1', user: user(),
        broker: helperBudget(), relay: helperBudget(), control: control() } }, routeAuthority: authority(platform),
    positive: { hostname: 'fixture.example', port: 443, path: '/qualification', status: 200, bodyBytes: 24, bodySha256: digest },
    fixtures: { imageDigest: image, publicSubnet: '93.184.216.0/24', publicGateway: '93.184.216.1', hostAddress: '192.168.1.9',
      publicHostname: '93-184-216-12.nip.io', publicAddress: '93.184.216.12' } } } : {}) };
}
