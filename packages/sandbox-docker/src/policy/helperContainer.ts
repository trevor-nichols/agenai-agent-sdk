// ------------------------------------------------------------------------------------------------
//                helperContainer.ts - Fixed broker/relay isolation, socket mounts and topology readback
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxStateError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { EGRESS_CONFIG_ENV, EGRESS_ROOT, EGRESS_SOCKET_DIRECTORY, HELPER_ENVIRONMENT, helperCommand } from '../helpers/protocol.js';
import type { EgressHelperConfiguration } from '../helpers/protocol.js';
import { resourceLabels } from '../recovery/identity.js';
import type { ContainerInspection } from '../resources/inspect.js';
import type { DockerSandboxConfig } from './config.js';
import { dockerProfile } from './profiles.js';
import { empty, isolatedHostPolicy, matchesHostIsolation, sameStrings } from './hostIsolation.js';

export type EgressHelperPlacement =
  | Readonly<{ role: 'egress_broker'; networkId: string; configuration: Extract<EgressHelperConfiguration, { role: 'broker' }> }>
  | Readonly<{ role: 'egress_relay'; computeId: string; configuration: Extract<EgressHelperConfiguration, { role: 'relay' }> }>;

const mountSchema = z.array(z.strictObject({ Type: z.literal('volume'), Source: z.string(), Target: z.string(),
  ReadOnly: z.boolean().default(false), VolumeOptions: z.strictObject({ NoCopy: z.boolean().default(false) }).optional() })).length(1);

function helperPolicy(config: DockerSandboxConfig, placement: EgressHelperPlacement) {
  if (!config.egress) throw new SandboxStateError('Egress helper construction requires its explicit immutable configuration.');
  return { egress: config.egress, budget: placement.role === 'egress_broker' ? config.egress.broker : config.egress.relay };
}

function helperEnvironment(placement: EgressHelperPlacement): readonly string[] {
  const encoded = JSON.stringify(placement.configuration);
  if (Buffer.byteLength(encoded) > 65536) throw new SandboxUnsupportedError('Egress helper configuration exceeds its bounded environment envelope.');
  return [...HELPER_ENVIRONMENT, `${EGRESS_CONFIG_ENV}=${encoded}`];
}

function namespace(placement: EgressHelperPlacement): string {
  return placement.role === 'egress_broker' ? placement.networkId : `container:${placement.computeId}`;
}

function temporaryStorage(config: DockerSandboxConfig, placement: EgressHelperPlacement) {
  const { egress, budget } = helperPolicy(config, placement);
  return { '/tmp': `rw,nosuid,nodev,noexec,size=${budget.temporaryBytes},mode=0700,uid=${egress.user.uid},gid=${egress.user.gid}` };
}

export function helperContainerBody(config: DockerSandboxConfig, record: SandboxRecoveryRecord,
  socketVolumeId: string, placement: EgressHelperPlacement) {
  const { egress, budget } = helperPolicy(config, placement);
  return {
    Image: egress.imageDigest, User: `${egress.user.uid}:${egress.user.gid}`, WorkingDir: EGRESS_ROOT,
    Entrypoint: ['/usr/local/bin/node'], Cmd: helperCommand(placement.configuration.role), Env: helperEnvironment(placement),
    Tty: false, OpenStdin: true, StdinOnce: true, AttachStdin: true, AttachStdout: true, AttachStderr: true,
    NetworkDisabled: false, Healthcheck: { Test: ['NONE'] }, Labels: resourceLabels(record, placement.role),
    HostConfig: {
      ...isolatedHostPolicy(budget.resources), NetworkMode: namespace(placement), Tmpfs: temporaryStorage(config, placement),
      Mounts: [{ Type: 'volume', Source: socketVolumeId, Target: EGRESS_SOCKET_DIRECTORY,
        ReadOnly: placement.role === 'egress_relay', VolumeOptions: { NoCopy: placement.role === 'egress_relay' } }],
    },
  };
}

export function verifyHelperContainer(container: ContainerInspection, config: DockerSandboxConfig,
  socketVolumeId: string, placement: EgressHelperPlacement, started: boolean): void {
  const { egress, budget } = helperPolicy(config, placement);
  const host = container.HostConfig;
  const requested = mountSchema.safeParse(host.Mounts);
  const mount = requested.success ? requested.data[0] : undefined;
  const actual = container.Mounts[0];
  const readOnly = placement.role === 'egress_relay';
  const expectedTmpfs = temporaryStorage(config, placement);
  const tmpfs = host.Tmpfs;
  const healthcheck = container.Config.Healthcheck;
  const attachments = Object.values(container.NetworkSettings.Networks);
  const topology = placement.role === 'egress_broker'
    ? attachments.length === 1 && attachments[0].NetworkID === placement.networkId
    : attachments.length === 0;
  if (container.Image !== egress.imageDigest || container.Config.Image !== egress.imageDigest
    || container.Config.User !== `${egress.user.uid}:${egress.user.gid}` || container.Config.WorkingDir !== EGRESS_ROOT
    || !sameStrings(container.Config.Entrypoint, ['/usr/local/bin/node']) || !sameStrings(container.Config.Cmd, helperCommand(placement.configuration.role))
    || !sameStrings(container.Config.Env, helperEnvironment(placement)) || container.Config.Tty
    || container.Config.OpenStdin !== true || container.Config.StdinOnce !== true
    || container.Config.AttachStdin !== true || container.Config.AttachStdout !== true || container.Config.AttachStderr !== true
    || container.Config.NetworkDisabled !== undefined && container.Config.NetworkDisabled !== false
    || !empty(container.Config.Volumes) || !empty(container.Config.ExposedPorts)
    || typeof healthcheck !== 'object' || healthcheck === null || !sameStrings(Reflect.get(healthcheck, 'Test'), ['NONE'])
    || !matchesHostIsolation(host, budget.resources) || host.NetworkMode !== namespace(placement)
    || !empty(host.ExtraHosts) || !empty(host.Links) || !empty(host.Dns) || !empty(host.DnsOptions) || !empty(host.DnsSearch)
    || !mount || mount.Source !== socketVolumeId || mount.Target !== EGRESS_SOCKET_DIRECTORY || mount.ReadOnly !== readOnly
    || (mount.VolumeOptions?.NoCopy ?? false) !== readOnly
    || container.Mounts.length !== 1 || !actual || actual.Type !== 'volume' || actual.Name !== socketVolumeId
    || actual.Destination !== EGRESS_SOCKET_DIRECTORY || actual.RW !== !readOnly
    || typeof tmpfs !== 'object' || tmpfs === null || Object.keys(tmpfs).length !== 1
    || Reflect.get(tmpfs, '/tmp') !== expectedTmpfs['/tmp']
    || started && (!container.State.Running || container.AppArmorProfile !== dockerProfile(config.profile).appArmorProfile
      || !empty(container.NetworkSettings.Ports) || !topology)
    || !started && (container.State.Running || container.State.Status !== 'created')) {
    throw new SandboxUnsupportedError('Docker egress helper readback differs from its exact image, isolation, control, socket or topology policy.');
  }
}
