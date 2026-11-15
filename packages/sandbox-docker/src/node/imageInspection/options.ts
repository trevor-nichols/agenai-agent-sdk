import { z } from 'zod/v4';
import { DOCKER_SANDBOX_PROFILES } from '../../policy/profiles.js';
import { captureDataFields } from '../preparedHelperOptions.js';
import type { DockerImageInspectionOptions } from './contracts.js';

const bounded = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const path = z.string().max(4095).refine((value) => value.isWellFormed() && value.startsWith('/')
  && Buffer.byteLength(value) <= 4095 && !/[\\\p{Cc}]/u.test(value)
  && (value === '/' || value.slice(1).split('/').length <= 128 && value.slice(1).split('/').every((part) => part !== '' && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255)),
'Image paths must be canonical bounded absolute paths');
const schema = z.strictObject({
  endpoint: z.string().min(9).max(512).regex(/^unix:\/\/\/[a-zA-Z0-9_.\-/]+$/u)
    .refine((value) => !value.slice(7).split('/').some((part) => part === '.' || part === '..') && !value.includes('//', 7)),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  profile: z.enum(DOCKER_SANDBOX_PROFILES),
  selections: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ path, kind: z.literal('file') }),
    z.strictObject({ path, kind: z.literal('symlink') }),
    z.strictObject({ path, kind: z.literal('absent') }),
    z.strictObject({ path, kind: z.literal('directory'), recursive: z.boolean().optional() }),
  ])).min(1).max(256).refine((values) => new Set(values.map((value) => value.path)).size === values.length
    && values.every((value) => value.path !== '/' || value.kind === 'directory' && !value.recursive)),
  limits: z.strictObject({ maxFiles: bounded.max(32_768), maxMembers: bounded.min(1).max(65_536), maxBytes: bounded,
    maxArchiveBytes: bounded, timeoutMs: bounded.min(1).max(2_147_483_647) }),
});

export function captureInspectionOptions(input: DockerImageInspectionOptions): DockerImageInspectionOptions {
  const outer = captureDataFields(input, ['endpoint', 'imageDigest', 'profile', 'selections', 'limits', 'signal'], 'Docker image inspection');
  const { signal, ...data } = outer;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Docker image inspection signal must be an AbortSignal.');
  if (!Array.isArray(data.selections) || Object.getPrototypeOf(data.selections) !== Array.prototype || data.selections.length > 256
    || Reflect.ownKeys(data.selections).length !== data.selections.length + 1) throw new TypeError('Docker image inspection requires a bounded dense selection array.');
  const selections = [];
  for (let index = 0; index < data.selections.length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(data.selections, String(index));
    if (!entry || !entry.enumerable || !('value' in entry)) throw new TypeError('Docker image inspection rejects selection accessors.');
    selections.push(captureDataFields(entry.value, ['path', 'kind', 'recursive'], 'Docker image selection'));
  }
  const parsed = schema.parse({ ...data, selections,
    limits: captureDataFields(data.limits, ['maxFiles', 'maxMembers', 'maxBytes', 'maxArchiveBytes', 'timeoutMs'], 'Docker image inspection limits') });
  return Object.freeze({ ...parsed, selections: Object.freeze(parsed.selections.map((value) => Object.freeze(value))),
    limits: Object.freeze(parsed.limits), ...(signal === undefined ? {} : { signal }) });
}
