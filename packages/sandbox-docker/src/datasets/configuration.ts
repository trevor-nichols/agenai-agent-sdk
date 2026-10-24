// ------------------------------------------------------------------------------------------------
//                configuration.ts - Finite mount topology and canonical dataset source selection
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { parseSandboxRelativePath } from '@agen-ai/sandbox';
import type { DockerSandboxDataset } from './types.js';

// Bounds configuration metadata and OS mount topology, independently of dataset file count/bytes.
export const MAX_DATASET_ATTACHMENTS = 32;

export const datasetsSchema = z.array(z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  subpath: z.string().max(1024).optional(),
})).max(MAX_DATASET_ATTACHMENTS)
  .refine((entries) => new Set(entries.map(({ name }) => name)).size === entries.length, 'Dataset names must be unique');

export function normalizeDatasets(entries: readonly DockerSandboxDataset[]): readonly DockerSandboxDataset[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ name: entry.name, imageDigest: entry.imageDigest,
    ...(entry.subpath === undefined ? {} : { subpath: parseSandboxRelativePath(entry.subpath) }) }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
