// ------------------------------------------------------------------------------------------------
//                imageInspection.ts - Explicit bounded borrowed-image observations and original cleanup
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxUnsupportedError } from '@agen-ai/sandbox';
import { DockerEngine } from '../engine/client.js';
import { DockerApi } from '../resources/api.js';
import { DOCKER_API } from '../policy/config.js';
import { dockerProfile } from '../policy/profiles.js';
import { verifyImageInspectionDaemon } from '../policy/preflight.js';
import { ImageInspectionOwner } from './imageInspection/owner.js';
import { ImageArtifactReader } from './imageInspection/archive.js';
import { captureInspectionOptions } from './imageInspection/options.js';
import { DockerImageInspectionError } from './imageInspection/contracts.js';
import type { DockerImageInspection, DockerImageInspectionOptions } from './imageInspection/contracts.js';

const strings = z.array(z.string().max(16_384)).max(1024);
const imageSchema = z.object({ Id: z.string(), Os: z.string(), Architecture: z.string(), Config: z.object({
  Env: strings.nullish(), Entrypoint: strings.nullish(), Cmd: strings.nullish(), User: z.string().max(1024).optional(),
  WorkingDir: z.string().max(4096).optional(), Labels: z.record(z.string().max(256), z.string().max(16_384)).nullish(),
  Volumes: z.record(z.string(), z.unknown()).nullish(),
}) });

/** Observes one existing immutable image through a never-started container; grants no provider attestation. */
export async function inspectDockerImageFiles(input: DockerImageInspectionOptions): Promise<DockerImageInspection> {
  const options = captureInspectionOptions(input);
  options.signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(options.limits.timeoutMs);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  const api = new DockerApi(new DockerEngine(options.endpoint.slice(7)), Math.min(options.limits.timeoutMs, 30_000));
  let owner: ImageInspectionOwner | undefined;
  let result: DockerImageInspection | undefined;
  let failure: { readonly cause: unknown } | undefined;
  try {
    const daemonId = await verifyImageInspectionDaemon(api, options.profile, signal);
    const architecture = dockerProfile(options.profile).workloadImageArchitecture;
    const image = await api.json('GET', `${DOCKER_API}/images/${options.imageDigest}/json`, imageSchema, { signal });
    if (image.Id !== options.imageDigest || image.Os !== 'linux' || image.Architecture !== architecture
      || Object.keys(image.Config.Volumes ?? {}).length !== 0) {
      throw new SandboxUnsupportedError('Docker image inspection requires the exact existing selected Linux image without declared volumes.');
    }
    owner = new ImageInspectionOwner(api, options, daemonId);
    const id = await owner.create(signal);
    const reader = new ImageArtifactReader(api, id, options.limits, signal);
    for (const selection of options.selections) await reader.select(selection);
    signal.throwIfAborted();
    result = Object.freeze({ endpoint: options.endpoint, imageDigest: options.imageDigest, profile: options.profile,
      platform: `linux/${architecture}`, daemonId, imageConfig: Object.freeze({
        env: Object.freeze(image.Config.Env ?? []), entrypoint: Object.freeze(image.Config.Entrypoint ?? []),
        cmd: Object.freeze(image.Config.Cmd ?? []), user: image.Config.User ?? '', workingDirectory: image.Config.WorkingDir ?? '',
        labels: Object.freeze(image.Config.Labels ?? {}),
      }), entries: Object.freeze([...reader.entries.values()]), absences: Object.freeze(reader.absences) });
  } catch (cause) { failure = { cause }; }
  try { await owner?.retryCleanup(); }
  catch (cause) {
    throw new DockerImageInspectionError('Docker image inspection cleanup retains its original owner.', owner,
      { cause: failure ? new AggregateError([failure.cause, cause], 'Image inspection and cleanup both failed.') : cause });
  }
  if (failure) throw new DockerImageInspectionError('Docker image inspection did not complete.', undefined, { cause: failure.cause });
  if (!result) throw new Error('Docker image inspection did not produce observations.');
  return result;
}

export { DockerImageInspectionError } from './imageInspection/contracts.js';
export type {
  DockerImageFileSelection, DockerImageFileObservation, DockerImageInspection, DockerImageInspectionOptions,
  DockerImageInspectionLimits, DockerImageInspectionCleanup, DockerImageInspectionCleanupIdentity,
} from './imageInspection/contracts.js';
