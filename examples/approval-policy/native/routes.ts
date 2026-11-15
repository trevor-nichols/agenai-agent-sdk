import { createDockerDesktopRouteAuthority, createDockerLinuxRouteAuthority } from '@agen-ai/sandbox-docker/node';
import type { DockerRouteAuthority } from '@agen-ai/sandbox-docker';
import { digest, fields, integer, invalid, literal, path, sha, text } from './data.js';

export function user(value: unknown) {
  const data = fields(value, ['uid', 'gid']); return { uid: integer(data.uid, 1, 262143), gid: integer(data.gid, 1, 262143) };
}
export function resources(value: unknown) {
  const data = fields(value, ['cpus', 'memoryBytes', 'pids']);
  if (typeof data.cpus !== 'number' || !Number.isFinite(data.cpus) || data.cpus <= 0 || data.cpus > 1024) invalid();
  return { cpus: data.cpus, memoryBytes: integer(data.memoryBytes, 6 * 1024 ** 2), pids: integer(data.pids) };
}
export function control(value: unknown) {
  const data = fields(value, ['heartbeatMs', 'leaseTimeoutMs']);
  return { heartbeatMs: integer(data.heartbeatMs, 1, 5000), leaseTimeoutMs: integer(data.leaseTimeoutMs, 100, 120000) };
}
export function helper(value: unknown) {
  const data = fields(value, ['resources', 'temporaryBytes']);
  return { resources: resources(data.resources), temporaryBytes: integer(data.temporaryBytes) };
}
export function routeAuthority(value: unknown): DockerRouteAuthority {
  if (!value || typeof value !== 'object' || !('kind' in value)) invalid();
  if (value.kind === 'local_linux_same_host') {
    const data = fields(value, ['kind', 'stability', 'ipExecutable', 'pollIntervalMs', 'commandTimeoutMs', 'maxOutputBytes']);
    const executable = fields(data.ipExecutable, ['path', 'sha256']);
    return createDockerLinuxRouteAuthority({ kind: 'local_linux_same_host', stability: literal(data.stability, 'caller_owned_quiescence'),
      ipExecutable: { path: path(executable.path), sha256: sha(executable.sha256) }, pollIntervalMs: integer(data.pollIntervalMs, 25, 60000),
      commandTimeoutMs: integer(data.commandTimeoutMs, 1, 30000), maxOutputBytes: integer(data.maxOutputBytes, 1024, 4 * 1024 ** 2) });
  }
  const data = fields(value, ['kind', 'profile', 'stability', 'interception', 'engine', 'deployment', 'hostObserver', 'vmObserver', 'pollIntervalMs', 'commandTimeoutMs', 'maxOutputBytes']);
  const engine = fields(data.engine, ['endpoint', 'id']);
  const deployment = fields(data.deployment, ['desktopVersion', 'desktopBuild', 'virtualMachineManager', 'rosetta', 'enhancedContainerIsolation',
    'hostNetworking', 'kernelUdp', 'networkingMode', 'dnsInhibition', 'dockerSubnet', 'proxyMode', 'manualProxyConfiguration']);
  const host = fields(data.hostObserver, ['protocol', 'executable', 'sourceDigest']);
  const executable = fields(host.executable, ['path', 'sha256']);
  const vm = fields(data.vmObserver, ['protocol', 'observationProtocol', 'imageDigest', 'sourceDigest', 'executable', 'user', 'resources', 'temporaryBytes', 'control']);
  return createDockerDesktopRouteAuthority({ kind: literal(data.kind, 'local_docker_desktop'),
    profile: literal(data.profile, 'desktop-apple-virtualization-native-arm64'), stability: literal(data.stability, 'caller_owned_quiescence'),
    interception: literal(data.interception, 'caller_owned_no_transparent_or_per_app_interception'),
    engine: { endpoint: text(engine.endpoint, 512), id: text(engine.id, 256) },
    deployment: { desktopVersion: text(deployment.desktopVersion, 64), desktopBuild: text(deployment.desktopBuild, 64),
      virtualMachineManager: literal(deployment.virtualMachineManager, 'apple_virtualization'), rosetta: literal(deployment.rosetta, true),
      enhancedContainerIsolation: literal(deployment.enhancedContainerIsolation, false), hostNetworking: literal(deployment.hostNetworking, false),
      kernelUdp: literal(deployment.kernelUdp, false), networkingMode: literal(deployment.networkingMode, 'ipv4only'), dnsInhibition: literal(deployment.dnsInhibition, 'auto'),
      dockerSubnet: literal(deployment.dockerSubnet, '192.168.65.0/24'), proxyMode: literal(deployment.proxyMode, 'automatic_system'),
      manualProxyConfiguration: literal(deployment.manualProxyConfiguration, false) },
    hostObserver: { protocol: literal(host.protocol, 'agenai.desktop-host-network.v1'), executable: { path: path(executable.path), sha256: sha(executable.sha256) },
      sourceDigest: digest(host.sourceDigest) },
    vmObserver: { protocol: literal(vm.protocol, 'agenai.sandbox.desktop-route-observer.v1'), observationProtocol: literal(vm.observationProtocol, 'agenai.desktop-vm-network.v1'),
      imageDigest: digest(vm.imageDigest), sourceDigest: digest(vm.sourceDigest), executable: literal(vm.executable, '/usr/local/bin/agenai-sandbox-desktop-route'),
      user: user(vm.user), resources: resources(vm.resources), temporaryBytes: integer(vm.temporaryBytes), control: control(vm.control) },
    pollIntervalMs: integer(data.pollIntervalMs, 25, 60000), commandTimeoutMs: integer(data.commandTimeoutMs, 1, 30000),
    maxOutputBytes: integer(data.maxOutputBytes, 1024, 4 * 1024 ** 2) });
}
