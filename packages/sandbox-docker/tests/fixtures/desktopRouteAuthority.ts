// ------------------------------------------------------------------------------------------------
//                desktopRouteAuthority.ts - Inert explicit Desktop authority input
// ------------------------------------------------------------------------------------------------

import type { DockerDesktopRouteAuthorityOptions } from '../../src/node/index.js';

export function desktopRouteAuthorityOptions(profile: DockerDesktopRouteAuthorityOptions['profile'],
  endpoint = 'unix:///absent-desktop-engine.sock') {
  return {
    kind: 'local_docker_desktop', profile, stability: 'caller_owned_quiescence',
    interception: 'caller_owned_no_transparent_or_per_app_interception',
    engine: { endpoint, id: 'desktop-unit-daemon' },
    deployment: { desktopVersion: '4.0.0-unit', desktopBuild: 'unit-build', virtualMachineManager: 'apple_virtualization',
      rosetta: true, enhancedContainerIsolation: false, hostNetworking: false, kernelUdp: false, networkingMode: 'ipv4only',
      dnsInhibition: 'auto', dockerSubnet: '192.168.65.0/24', proxyMode: 'automatic_system', manualProxyConfiguration: false },
    hostObserver: { protocol: 'agenai.desktop-host-network.v1',
      executable: { path: '/absent-desktop-observer/host-network', sha256: 'a'.repeat(64) }, sourceDigest: `sha256:${'b'.repeat(64)}` },
    vmObserver: { protocol: 'agenai.sandbox.desktop-route-observer.v1', observationProtocol: 'agenai.desktop-vm-network.v1',
      imageDigest: `sha256:${'c'.repeat(64)}`, sourceDigest: `sha256:${'d'.repeat(64)}`,
      executable: '/usr/local/bin/agenai-sandbox-desktop-route', user: { uid: 1000, gid: 1000 },
      resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2,
      control: { heartbeatMs: 100, leaseTimeoutMs: 60_000 } },
    pollIntervalMs: 100, commandTimeoutMs: 1000, maxOutputBytes: 65_536,
  } satisfies DockerDesktopRouteAuthorityOptions;
}
