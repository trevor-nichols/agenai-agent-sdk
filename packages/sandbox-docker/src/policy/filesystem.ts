// ------------------------------------------------------------------------------------------------
//                filesystem.ts - Prepared live helper identity, private layout and isolation readback
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxStateError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerApi } from '../resources/api.js';
import type { ContainerInspection } from '../resources/inspect.js';
import { resourceLabels } from '../recovery/identity.js';
import { DOCKER_API } from './config.js';
import type { DockerSandboxConfig, DockerSandboxFilesystemOptions } from './config.js';
import { dockerProfile } from './profiles.js';
import { empty, isolatedHostPolicy, matchesHostIsolation, sameStrings } from './hostIsolation.js';
import { FILESYSTEM_ENVIRONMENT, FILESYSTEM_IMAGE_PROTOCOL_LABEL, FILESYSTEM_IMAGE_LAYOUT_LABEL, FILESYSTEM_IMAGE_USER_LABEL,
  FILESYSTEM_IMAGE_SOURCE_LABEL, FILESYSTEM_STORE, filesystemCommand } from '../workspace/live/protocol.js';

export type FilesystemAccess = 'read_only' | 'read_write';

const imageSchema = z.object({ Id: z.string(), Os: z.string(), Architecture: z.string(), Config: z.object({
  User: z.string(), Entrypoint: z.array(z.string()).nullable(), Cmd: z.array(z.string()).nullish(),
  Env: z.array(z.string()).nullish(), Volumes: z.record(z.string(), z.unknown()).nullish(),
  Labels: z.record(z.string(), z.string()).nullish(),
}) });
const mountSchema = z.array(z.strictObject({ Type: z.literal('volume'), Source: z.string(), Target: z.literal('/store'),
  ReadOnly: z.boolean().default(false), VolumeOptions: z.strictObject({ NoCopy: z.boolean().default(false) }).optional() })).length(1);

function configured(config: DockerSandboxConfig): DockerSandboxFilesystemOptions {
  if (!config.filesystem) throw new SandboxStateError('Live filesystem ownership requires explicit prepared-helper configuration.');
  return config.filesystem;
}

export async function verifyFilesystemImage(api: DockerApi, config: DockerSandboxConfig, signal?: AbortSignal): Promise<void> {
  const filesystem = configured(config);
  const image = await api.json('GET', `${DOCKER_API}/images/${filesystem.imageDigest}/json`, imageSchema, { signal });
  const labels = image.Config.Labels;
  if (image.Id !== filesystem.imageDigest || image.Os !== 'linux' || image.Architecture !== dockerProfile(config.profile).helperImageArchitecture
    || image.Config.User !== `${filesystem.user.uid}:${filesystem.user.gid}`
    || !sameStrings(image.Config.Entrypoint, [filesystem.executable]) || !empty(image.Config.Cmd)
    || !sameStrings(image.Config.Env, FILESYSTEM_ENVIRONMENT) || !empty(image.Config.Volumes)
    || labels?.[FILESYSTEM_IMAGE_PROTOCOL_LABEL] !== filesystem.protocol
    || labels[FILESYSTEM_IMAGE_LAYOUT_LABEL] !== filesystem.layout
    || labels[FILESYSTEM_IMAGE_USER_LABEL] !== `${filesystem.user.uid}:${filesystem.user.gid}`
    || !/^sha256:[a-f0-9]{64}$/u.test(labels[FILESYSTEM_IMAGE_SOURCE_LABEL] ?? '')) {
    throw new SandboxUnsupportedError('Prepared filesystem image differs from its exact platform, executable, layout, user or source identity.');
  }
}

function command(filesystem: DockerSandboxFilesystemOptions, access: FilesystemAccess): readonly string[] {
  return filesystemCommand(access === 'read_write' ? 'read_write' : 'read', filesystem.control.leaseTimeoutMs);
}

function temporaryStorage(filesystem: DockerSandboxFilesystemOptions) {
  return { '/tmp': `rw,nosuid,nodev,noexec,size=${filesystem.temporaryBytes},mode=0700,uid=${filesystem.user.uid},gid=${filesystem.user.gid}` };
}

export function filesystemContainerBody(config: DockerSandboxConfig, record: SandboxRecoveryRecord, storageId: string, access: FilesystemAccess) {
  const filesystem = configured(config);
  return {
    Image: filesystem.imageDigest, User: `${filesystem.user.uid}:${filesystem.user.gid}`, WorkingDir: FILESYSTEM_STORE,
    Entrypoint: [filesystem.executable], Cmd: command(filesystem, access), Env: FILESYSTEM_ENVIRONMENT,
    Tty: false, OpenStdin: true, StdinOnce: true, AttachStdin: true, AttachStdout: true, AttachStderr: true,
    NetworkDisabled: true, Healthcheck: { Test: ['NONE'] }, Labels: resourceLabels(record, 'filesystem'),
    HostConfig: { ...isolatedHostPolicy(filesystem.resources), NetworkMode: 'none', Tmpfs: temporaryStorage(filesystem),
      Mounts: [{ Type: 'volume', Source: storageId, Target: FILESYSTEM_STORE, ReadOnly: access === 'read_only', VolumeOptions: { NoCopy: false } }],
    },
  };
}

export function verifyFilesystemContainer(container: ContainerInspection, config: DockerSandboxConfig,
  storageId: string, access: FilesystemAccess, started: boolean): void {
  const filesystem = configured(config);
  const host = container.HostConfig;
  const requested = mountSchema.safeParse(host.Mounts);
  const mount = requested.success ? requested.data[0] : undefined;
  const effective = container.Mounts[0];
  const readOnly = access === 'read_only';
  const healthcheck = container.Config.Healthcheck;
  const tmpfs = host.Tmpfs;
  const expectedTmpfs = temporaryStorage(filesystem);
  const networks = Object.keys(container.NetworkSettings.Networks);
  if (container.Image !== filesystem.imageDigest || container.Config.Image !== filesystem.imageDigest
    || container.Config.User !== `${filesystem.user.uid}:${filesystem.user.gid}` || container.Config.WorkingDir !== FILESYSTEM_STORE
    || !sameStrings(container.Config.Entrypoint, [filesystem.executable]) || !sameStrings(container.Config.Cmd, command(filesystem, access))
    || !sameStrings(container.Config.Env, FILESYSTEM_ENVIRONMENT) || !empty(container.Config.Volumes) || !empty(container.Config.ExposedPorts)
    || container.Config.Tty || container.Config.OpenStdin !== true || container.Config.StdinOnce !== true
    || container.Config.AttachStdin !== true || container.Config.AttachStdout !== true || container.Config.AttachStderr !== true
    || container.Config.NetworkDisabled !== true
    || typeof healthcheck !== 'object' || healthcheck === null || !sameStrings(Reflect.get(healthcheck, 'Test'), ['NONE'])
    || !matchesHostIsolation(host, filesystem.resources) || host.NetworkMode !== 'none'
    || !empty(host.ExtraHosts) || !empty(host.Links) || !empty(host.Dns) || !empty(host.DnsOptions) || !empty(host.DnsSearch)
    || !mount || mount.Source !== storageId || mount.ReadOnly !== readOnly || (mount.VolumeOptions?.NoCopy ?? false)
    || container.Mounts.length !== 1 || !effective || effective.Type !== 'volume' || effective.Name !== storageId
    || effective.Destination !== FILESYSTEM_STORE || effective.RW !== !readOnly
    || typeof tmpfs !== 'object' || tmpfs === null || Object.keys(tmpfs).length !== 1 || Reflect.get(tmpfs, '/tmp') !== expectedTmpfs['/tmp']
    || started && (!container.State.Running || container.AppArmorProfile !== dockerProfile(config.profile).appArmorProfile
      || !empty(container.NetworkSettings.Ports) || networks.length !== 0)
    || !started && (container.State.Running || container.State.Status !== 'created')) {
    throw new SandboxUnsupportedError('Filesystem helper readback differs from its exact image, private layout, mount access or control isolation.');
  }
}
