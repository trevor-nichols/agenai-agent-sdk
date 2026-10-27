// ------------------------------------------------------------------------------------------------
//                desktopObserver.ts - Fixed owned Desktop VM route observer policy and readback
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxStateError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerDesktopRouteAuthorityIdentity } from '../network/desktopAuthority.js';
import {
  DESKTOP_VM_CONFIG_ENV, DESKTOP_VM_ENVIRONMENT, DESKTOP_VM_IMAGE_OBSERVATION_LABEL,
  DESKTOP_VM_IMAGE_PROTOCOL_LABEL, DESKTOP_VM_IMAGE_SOURCE_LABEL, DESKTOP_VM_IMAGE_USER_LABEL,
  desktopVmObserverCommand, parseDesktopVmObserverConfiguration,
} from '../network/desktop/protocol.js';
import type { DockerApi } from '../resources/api.js';
import type { ContainerInspection } from '../resources/inspect.js';
import { resourceLabels } from '../recovery/identity.js';
import { DOCKER_API } from './config.js';
import type { DockerSandboxConfig } from './config.js';
import { empty, isolatedHostPolicy, matchesHostIsolation, sameStrings } from './hostIsolation.js';
import { dockerProfile } from './profiles.js';

const imageSchema = z.object({ Id: z.string(), Os: z.string(), Architecture: z.string(), Config: z.object({
  User: z.string(), WorkingDir: z.string(), Env: z.array(z.string()).nullish(),
  Entrypoint: z.array(z.string()).nullish(), Cmd: z.array(z.string()).nullish(),
  Volumes: z.record(z.string(), z.unknown()).nullish(), Labels: z.record(z.string(), z.string()).nullish(),
}) });

export function desktopObserverIdentity(config: DockerSandboxConfig): DockerDesktopRouteAuthorityIdentity {
  if (config.egressAuthority?.kind !== 'local_docker_desktop') {
    throw new SandboxStateError('Desktop observer ownership requires its original configured Desktop authority.');
  }
  return config.egressAuthority.identity;
}

export function desktopObserverConfiguration(identity: DockerDesktopRouteAuthorityIdentity) {
  return parseDesktopVmObserverConfiguration({ protocol: identity.vmObserver.protocol,
    ...identity.vmObserver.control, commandTimeoutMs: identity.commandTimeoutMs, maxOutputBytes: identity.maxOutputBytes });
}

function environment(identity: DockerDesktopRouteAuthorityIdentity): readonly string[] {
  return [...DESKTOP_VM_ENVIRONMENT, `${DESKTOP_VM_CONFIG_ENV}=${JSON.stringify(desktopObserverConfiguration(identity))}`];
}

function temporaryStorage(identity: DockerDesktopRouteAuthorityIdentity) {
  const observer = identity.vmObserver;
  return { '/tmp': `rw,nosuid,nodev,noexec,size=${observer.temporaryBytes},mode=0700,uid=${observer.user.uid},gid=${observer.user.gid}` };
}

export async function verifyDesktopObserverImage(api: DockerApi, config: DockerSandboxConfig, signal?: AbortSignal): Promise<void> {
  const identity = desktopObserverIdentity(config);
  const observer = identity.vmObserver;
  const image = await api.json('GET', `${DOCKER_API}/images/${observer.imageDigest}/json`, imageSchema, { signal });
  const labels = image.Config.Labels;
  if (image.Id !== observer.imageDigest || image.Os !== 'linux'
    || image.Architecture !== dockerProfile(config.profile).helperImageArchitecture
    || !empty(image.Config.Volumes) || !sameStrings(image.Config.Env, DESKTOP_VM_ENVIRONMENT)
    || image.Config.User !== `${observer.user.uid}:${observer.user.gid}` || image.Config.WorkingDir !== '/'
    || !sameStrings(image.Config.Entrypoint, ['/usr/local/bin/node', ...desktopVmObserverCommand()])
    || !empty(image.Config.Cmd)
    || labels?.[DESKTOP_VM_IMAGE_PROTOCOL_LABEL] !== observer.protocol
    || labels[DESKTOP_VM_IMAGE_OBSERVATION_LABEL] !== observer.observationProtocol
    || labels[DESKTOP_VM_IMAGE_SOURCE_LABEL] !== observer.sourceDigest
    || labels[DESKTOP_VM_IMAGE_USER_LABEL] !== `${observer.user.uid}:${observer.user.gid}`) {
    throw new SandboxUnsupportedError('Prepared Desktop observer image differs from its exact image, platform, fixed launch or provenance configuration.');
  }
}

export function desktopObserverContainerBody(config: DockerSandboxConfig, record: SandboxRecoveryRecord) {
  const identity = desktopObserverIdentity(config);
  const observer = identity.vmObserver;
  return { Image: observer.imageDigest, User: `${observer.user.uid}:${observer.user.gid}`, WorkingDir: '/',
    Entrypoint: ['/usr/local/bin/node'], Cmd: desktopVmObserverCommand(), Env: environment(identity),
    Tty: false, OpenStdin: true, StdinOnce: true, AttachStdin: true, AttachStdout: true, AttachStderr: true,
    NetworkDisabled: false, Healthcheck: { Test: ['NONE'] }, Labels: resourceLabels(record, 'route_observer'),
    HostConfig: { ...isolatedHostPolicy(observer.resources), NetworkMode: 'host', Mounts: [], Tmpfs: temporaryStorage(identity) } };
}

export function verifyDesktopObserverContainer(container: ContainerInspection, config: DockerSandboxConfig, started: boolean): void {
  const identity = desktopObserverIdentity(config);
  const observer = identity.vmObserver;
  const host = container.HostConfig;
  const tmpfs = host.Tmpfs;
  const healthcheck = container.Config.Healthcheck;
  const networks = Object.keys(container.NetworkSettings.Networks);
  if (container.Image !== observer.imageDigest || container.Config.Image !== observer.imageDigest
    || container.Config.User !== `${observer.user.uid}:${observer.user.gid}` || container.Config.WorkingDir !== '/'
    || !sameStrings(container.Config.Entrypoint, ['/usr/local/bin/node']) || !sameStrings(container.Config.Cmd, desktopVmObserverCommand())
    || !sameStrings(container.Config.Env, environment(identity)) || container.Config.Tty
    || container.Config.OpenStdin !== true || container.Config.StdinOnce !== true
    || container.Config.AttachStdin !== true || container.Config.AttachStdout !== true || container.Config.AttachStderr !== true
    || container.Config.NetworkDisabled !== undefined && container.Config.NetworkDisabled !== false
    || !empty(container.Config.Volumes) || !empty(container.Config.ExposedPorts)
    || typeof healthcheck !== 'object' || healthcheck === null || !sameStrings(Reflect.get(healthcheck, 'Test'), ['NONE'])
    || !matchesHostIsolation(host, observer.resources) || host.NetworkMode !== 'host'
    || !empty(host.Mounts) || !empty(container.Mounts) || !empty(host.ExtraHosts) || !empty(host.Links)
    || !empty(host.Dns) || !empty(host.DnsOptions) || !empty(host.DnsSearch)
    || !empty(host.VolumesFrom) || !empty(host.DeviceCgroupRules) || !empty(host.Sysctls)
    || host.UTSMode !== undefined && host.UTSMode !== '' || host.CgroupParent !== undefined && host.CgroupParent !== ''
    || typeof tmpfs !== 'object' || tmpfs === null || Object.keys(tmpfs).length !== 1
    || Reflect.get(tmpfs, '/tmp') !== temporaryStorage(identity)['/tmp']
    || started && (!container.State.Running || container.AppArmorProfile !== dockerProfile(config.profile).appArmorProfile
      || !empty(container.NetworkSettings.Ports) || networks.length !== 1 || networks[0] !== 'host')
    || !started && (container.State.Running || container.State.Status !== 'created')) {
    throw new SandboxUnsupportedError('Desktop observer readback differs from its exact image, fixed control, host network or unprivileged isolation policy.');
  }
}
