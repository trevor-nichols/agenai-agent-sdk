// ------------------------------------------------------------------------------------------------
//                preflight.ts - Qualified daemon and image admission - No resource acquisition
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { SandboxPolicy } from '@agen-ai/sandbox';
import type { DockerApi } from '../resources/api.js';
import type { DockerSandboxConfig } from './config.js';
import { DOCKER_API } from './config.js';
import { dockerProfile } from './profiles.js';
import { empty, sameStrings } from './hostIsolation.js';
import { EGRESS_PROTOCOL, HELPER_ENVIRONMENT, HELPER_IMAGE_PROTOCOL_LABEL, HELPER_IMAGE_SOURCE_LABEL, HELPER_IMAGE_USER_LABEL } from '../helpers/protocol.js';
import type { DockerLinuxRouteCensus } from '../network/routeAuthority.js';

const versionSchema = z.object({ Version: z.string().max(64).optional(), ApiVersion: z.string(), MinAPIVersion: z.string(), Os: z.string(), Arch: z.string() });
const infoSchema = z.object({
  ID: z.string().min(1).max(256).regex(/^[^\s/\\]+$/u), OSType: z.string(), Architecture: z.string(),
  CgroupVersion: z.string(), CgroupDriver: z.string(), SecurityOptions: z.array(z.string()).max(64),
  OperatingSystem: z.string().optional(),
  Driver: z.string().optional(),
  DriverStatus: z.array(z.tuple([z.string(), z.string()])).max(64).optional(),
  MemoryLimit: z.boolean(), SwapLimit: z.boolean(), PidsLimit: z.boolean(), CpuCfsPeriod: z.boolean(), CpuCfsQuota: z.boolean(),
});
const imageSchema = z.object({ Id: z.string(), Os: z.string(), Architecture: z.string(),
  Config: z.object({ Volumes: z.record(z.string(), z.unknown()).nullish(),
    Env: z.array(z.string()).nullish(), Labels: z.record(z.string(), z.string()).nullish(),
    User: z.string().optional(), Entrypoint: z.array(z.string()).nullish(), Cmd: z.array(z.string()).nullish(), WorkingDir: z.string().optional() }) });
const datasetImageSchema = z.object({ Id: z.string(), Os: z.string(), RootFS: z.object({ Type: z.string() }) });

function versionNumber(value: string): number {
  if (!/^\d+\.\d+$/u.test(value)) return Number.NaN;
  const [major, minor] = value.split('.').map(Number);
  return major * 1000 + minor;
}

function supportsDatasetMountNames(version: string | undefined): boolean {
  if (version === undefined || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(BigInt);
  // Moby #51829 replaces overlong image-layer filenames with a hash in Engine 29.1.4.
  return major > 29n || major === 29n && (minor > 1n || minor === 1n && patch >= 4n);
}

export function assertDockerController(config: DockerSandboxConfig): void {
  const profile = dockerProfile(config.profile);
  if (process.platform !== profile.controllerOS || process.arch !== profile.controllerArchitecture) {
    throw new SandboxUnsupportedError(`Docker profile ${config.profile} requires a ${profile.controllerOS}/${profile.controllerArchitecture} controller.`);
  }
}

export async function verifyDaemon(api: DockerApi, config: DockerSandboxConfig, signal?: AbortSignal): Promise<string> {
  assertDockerController(config);
  const profile = dockerProfile(config.profile);
  const version = await api.json('GET', '/version', versionSchema, { signal });
  const info = await api.json('GET', '/info', infoSchema, { signal });
  const security = info.SecurityOptions;
  const imageStore = info.DriverStatus?.filter(([name]) => name === 'driver-type');
  if (version.Os !== 'linux' || version.Arch !== profile.daemonArchitecture
    || !profile.daemonInfoArchitectures.includes(info.Architecture) || info.OSType !== 'linux'
    || (info.OperatingSystem === 'Docker Desktop') !== profile.desktop
    || !(versionNumber(version.MinAPIVersion) <= 1052 && versionNumber(version.ApiVersion) >= 1052)
    || info.CgroupVersion !== '2' || info.CgroupDriver !== profile.cgroupDriver
    || !info.MemoryLimit || !info.SwapLimit || !info.PidsLimit || !info.CpuCfsPeriod || !info.CpuCfsQuota
    || security.some((item) => /rootless|userns/iu.test(item))
    || security.includes('name=apparmor') === profile.desktop
    || !security.includes('name=seccomp,profile=builtin')
    || !security.includes('name=cgroupns')) {
    throw new SandboxUnsupportedError(`Docker daemon does not match profile ${config.profile}, its architecture, cgroup-v2 controllers or required default isolation.`);
  }
  if (config.datasets.length > 0 && (info.Driver !== 'overlayfs' || imageStore?.length !== 1 || imageStore[0][1] !== 'io.containerd.snapshotter.v1')) {
    throw new SandboxUnsupportedError('Docker image datasets require the explicitly admitted overlayfs containerd image store.');
  }
  if (config.datasets.length > 0 && !supportsDatasetMountNames(version.Version)) {
    throw new SandboxUnsupportedError('Docker image datasets require a stable Engine release of at least 29.1.4 with the image-layer filename fix.');
  }
  if (config.egressAuthority?.kind === 'local_docker_desktop' && info.ID !== config.egressAuthority.identity.engine.id) {
    throw new SandboxUnsupportedError('Docker daemon differs from the exact Engine selected by the Desktop route authority.');
  }
  return info.ID;
}

export async function verifyDatasetImages(api: DockerApi, config: DockerSandboxConfig, signal?: AbortSignal): Promise<void> {
  for (const dataset of config.datasets) {
    const image = await api.json('GET', `${DOCKER_API}/images/${dataset.imageDigest}/json`, datasetImageSchema, { signal });
    if (image.Id !== dataset.imageDigest || image.Os !== 'linux' || image.RootFS.Type !== 'layers') {
      throw new SandboxUnsupportedError('Docker datasets require their exact existing Linux filesystem image ID.');
    }
  }
}

export async function verifyImage(api: DockerApi, config: DockerSandboxConfig, signal?: AbortSignal): Promise<void> {
  const profile = dockerProfile(config.profile);
  const image = await api.json('GET', `${DOCKER_API}/images/${config.imageDigest}/json`, imageSchema, { signal });
  if (image.Id !== config.imageDigest || image.Os !== 'linux' || image.Architecture !== profile.workloadImageArchitecture
    || Object.keys(image.Config.Volumes ?? {}).length !== 0) {
    throw new SandboxUnsupportedError(`Docker profile ${config.profile} requires the exact local Linux ${profile.workloadImageArchitecture} image ID without declared image volumes.`);
  }
}

export async function verifyEgressImage(api: DockerApi, config: DockerSandboxConfig, signal?: AbortSignal): Promise<void> {
  if (!config.egress) throw new SandboxUnsupportedError('Restricted HTTPS requires explicit prepared egress configuration.');
  const egress = config.egress;
  const image = await api.json('GET', `${DOCKER_API}/images/${egress.imageDigest}/json`, imageSchema, { signal });
  const labels = image.Config.Labels;
  if (image.Id !== egress.imageDigest || image.Os !== 'linux' || image.Architecture !== dockerProfile(config.profile).helperImageArchitecture
    || !empty(image.Config.Volumes) || !sameStrings(image.Config.Env, HELPER_ENVIRONMENT)
    || image.Config.User !== `${egress.user.uid}:${egress.user.gid}` || image.Config.WorkingDir !== '/'
    || !sameStrings(image.Config.Entrypoint, ['/usr/local/bin/node']) || !sameStrings(image.Config.Cmd, ['--version'])
    || labels?.[HELPER_IMAGE_PROTOCOL_LABEL] !== EGRESS_PROTOCOL
    || labels[HELPER_IMAGE_USER_LABEL] !== `${egress.user.uid}:${egress.user.gid}`
    || !/^sha256:[a-f0-9]{64}$/u.test(labels[HELPER_IMAGE_SOURCE_LABEL] ?? '')) {
    throw new SandboxUnsupportedError('Prepared egress image identity, platform, fixed launch configuration or protocol/user provenance labels do not match.');
  }
}

const deploymentSchema = z.object({ Name: z.string().min(1).max(256), KernelVersion: z.string().min(1).max(256) });

/** Supplemental observed comparison; the caller-owned same-host/quiescence assertion remains explicit. */
export async function verifyEgressDeployment(api: DockerApi, config: DockerSandboxConfig,
  census: DockerLinuxRouteCensus, signal?: AbortSignal): Promise<void> {
  if (config.profile !== 'linux-x64' || !config.egress) throw new SandboxUnsupportedError('Restricted HTTPS deployment authority is unavailable on this profile.');
  const info = await api.json('GET', '/info', deploymentSchema, { signal });
  if (info.Name !== census.hostname || info.KernelVersion !== census.kernel) {
    throw new SandboxUnsupportedError('Docker daemon hostname/kernel observations differ from the explicitly selected Linux route authority.');
  }
}

export function assertDockerPolicy(policy: SandboxPolicy): void {
  if (!Number.isSafeInteger(policy.resources.cpus * 1_000_000_000)
    || policy.resources.cpus > 1024 || policy.resources.memoryBytes < 6 * 1024 ** 2) {
    throw new SandboxUnsupportedError('Docker requires representable NanoCPUs and at least 6 MiB of memory.');
  }
}
