// ------------------------------------------------------------------------------------------------
//                mounts.ts - Exact workspace and read-only dataset mount policy and readback
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { ContainerInspection } from '../resources/inspect.js';
import type { DockerSandboxDataset } from './types.js';
import { MAX_DATASET_ATTACHMENTS } from './configuration.js';

const hostMountSchema = z.discriminatedUnion('Type', [
  z.strictObject({ Type: z.literal('volume'), Source: z.string(), Target: z.string(), ReadOnly: z.boolean().default(false),
    VolumeOptions: z.strictObject({ NoCopy: z.literal(true) }) }),
  z.strictObject({ Type: z.literal('image'), Source: z.string(), Target: z.string(), ReadOnly: z.literal(true),
    ImageOptions: z.strictObject({ Subpath: z.string() }).optional() }),
]);
const hostMountsSchema = z.array(hostMountSchema).min(1).max(MAX_DATASET_ATTACHMENTS + 1);

export function containerMounts(datasets: readonly DockerSandboxDataset[], role: 'compute' | 'export', storageId: string) {
  return [
    { Type: 'volume' as const, Source: storageId, Target: '/workspace', ReadOnly: role === 'export', VolumeOptions: { NoCopy: true as const } },
    ...(role === 'compute' ? datasets.map((dataset) => ({ Type: 'image' as const, Source: dataset.imageDigest,
      Target: `/datasets/${dataset.name}`, ReadOnly: true as const,
      ...(dataset.subpath === undefined ? {} : { ImageOptions: { Subpath: dataset.subpath } }) })) : []),
  ];
}

export function verifyContainerMounts(container: ContainerInspection, datasets: readonly DockerSandboxDataset[],
  role: 'compute' | 'export', storageId: string): void {
  const expected = containerMounts(datasets, role, storageId);
  const parsed = hostMountsSchema.safeParse(container.HostConfig.Mounts);
  if (!parsed.success || parsed.data.length !== expected.length || container.Mounts.length !== expected.length) {
    throw new SandboxUnsupportedError('Docker mount inventory differs from the private workspace and selected read-only datasets.');
  }
  for (const specification of expected) {
    const requested = parsed.data.find((mount) => mount.Target === specification.Target);
    const effective = container.Mounts.find((mount) => mount.Destination === specification.Target);
    if (!requested || requested.Type !== specification.Type || requested.Source !== specification.Source
      || requested.ReadOnly !== specification.ReadOnly
      || specification.Type === 'image' && (requested.Type !== 'image' || requested.ImageOptions?.Subpath !== specification.ImageOptions?.Subpath)
      || !effective || effective.Type !== specification.Type || effective.Name !== specification.Source
      || effective.RW !== !specification.ReadOnly
      || specification.Type === 'image' && (!effective.Source.startsWith('/') || effective.Driver !== undefined && effective.Driver !== ''
        || effective.Propagation !== 'rprivate')) {
      throw new SandboxUnsupportedError('Docker mount readback does not match the exact workspace or borrowed read-only image identity.');
    }
  }
}
