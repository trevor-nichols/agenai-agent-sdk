// ------------------------------------------------------------------------------------------------
//                prepareHelpers.ts - Explicit fresh build context for an exact borrowed Node image
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod/v4';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { EGRESS_PROTOCOL, EGRESS_ROOT, EGRESS_SOCKET_DIRECTORY, HELPER_ENVIRONMENT,
  HELPER_IMAGE_PROTOCOL_LABEL, HELPER_IMAGE_SOURCE_LABEL, HELPER_IMAGE_USER_LABEL } from '../helpers/protocol.js';

export interface DockerEgressHelperPreparationOptions {
  readonly directory: string;
  readonly baseImageDigest: string;
  readonly user: Readonly<{ uid: number; gid: number }>;
}

export interface DockerEgressHelperPreparation {
  readonly directory: string;
  readonly protocol: typeof EGRESS_PROTOCOL;
  readonly baseImageDigest: string;
  readonly sourceDigest: string;
  readonly user: Readonly<{ uid: number; gid: number }>;
  readonly files: readonly Readonly<{ path: string; sha256: string }>[];
}

const preparationSchema = z.strictObject({
  directory: z.string().min(2).max(4096).refine((value) => isAbsolute(value) && normalize(value) === value && !value.endsWith('/')
    && !/[\u0000-\u001f\u007f]/u.test(value), 'Canonical absolute fresh directory required'),
  baseImageDigest: z.string().max(512).regex(/^(?:sha256:[a-f0-9]{64}|[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64})$/u),
  user: z.strictObject({ uid: z.number().int().min(1).max(262143), gid: z.number().int().min(1).max(262143) }),
});

const ARTIFACTS = Object.freeze(['helpers/broker.js', 'helpers/connection.js', 'helpers/control.js', 'helpers/entry.js', 'helpers/protocol.js', 'helpers/relay.js', 'helpers/socketDirectory.js', 'network/address.js', 'network/policy.js']);

export async function prepareDockerSandboxEgressHelpers(options: DockerEgressHelperPreparationOptions): Promise<DockerEgressHelperPreparation> {
  const parsed = preparationSchema.safeParse(options);
  if (!parsed.success) throw new SandboxValidationError(normalizeZodValidationError(preparationSchema, parsed.error, options));
  const { directory, baseImageDigest, user } = parsed.data;
  const parent = dirname(directory);
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new TypeError('Helper preparation requires a stable physical parent directory.');
  // Read the shipped compiled closure before reserving a new caller-owned namespace.
  const artifacts: Array<{ path: string; bytes: Buffer; sha256: string }> = [];
  for (const path of ARTIFACTS) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    if (bytes.length > 256 * 1024) throw new TypeError('Prepared helper source exceeds its artifact bound.');
    artifacts.push({ path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const files = Object.freeze(artifacts.map(({ path, sha256 }) => Object.freeze({ path, sha256 })));
  const sourceDigest = `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
  const result = Object.freeze({ directory, baseImageDigest, protocol: EGRESS_PROTOCOL, sourceDigest, user: Object.freeze(user), files });
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'runtime'), { mode: 0o700 });
  await mkdir(join(directory, 'runtime/helpers'), { mode: 0o700 });
  await mkdir(join(directory, 'runtime/network'), { mode: 0o700 });
  for (const artifact of artifacts) await writeFile(join(directory, 'runtime', artifact.path), artifact.bytes, { flag: 'wx', mode: 0o644 });
  await writeFile(join(directory, 'runtime/package.json'), '{"type":"module","private":true}\n', { flag: 'wx', mode: 0o644 });
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const initialize = [
    "const fs = require('node:fs');",
    `for (const path of ${JSON.stringify(['/opt/agenai', EGRESS_ROOT, `${EGRESS_ROOT}/helpers`, `${EGRESS_ROOT}/network`])}) fs.chmodSync(path,0o755);`,
    `fs.mkdirSync(${JSON.stringify(EGRESS_SOCKET_DIRECTORY)}, {recursive:true});`,
    `fs.chownSync(${JSON.stringify(EGRESS_SOCKET_DIRECTORY)},${user.uid},${user.gid});`,
    `fs.chmodSync(${JSON.stringify(EGRESS_SOCKET_DIRECTORY)},0o700);`,
  ].join(' ');
  const dockerfile = [
    `FROM ${baseImageDigest} AS source`, 'FROM scratch', 'COPY --from=source / /', `COPY runtime/ ${EGRESS_ROOT}/`,
    `RUN ${JSON.stringify(['/usr/local/bin/node', '--eval', initialize])}`,
    ...HELPER_ENVIRONMENT.map((entry) => `ENV ${entry}`), `USER ${user.uid}:${user.gid}`, 'WORKDIR /',
    `LABEL ${HELPER_IMAGE_PROTOCOL_LABEL}="${EGRESS_PROTOCOL}" ${HELPER_IMAGE_SOURCE_LABEL}="${sourceDigest}" ${HELPER_IMAGE_USER_LABEL}="${user.uid}:${user.gid}"`,
    'ENTRYPOINT ["/usr/local/bin/node"]', 'CMD ["--version"]', '',
  ].join('\n');
  // Dockerfile is the final publication marker. A partial directory has no executable build recipe.
  await writeFile(join(directory, 'Dockerfile'), dockerfile, { flag: 'wx', mode: 0o600 });
  return result;
}
