// ------------------------------------------------------------------------------------------------
//                prepareFilesystem.ts - Explicit source recipe for an offline static filesystem helper
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod/v4';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { FILESYSTEM_ENVIRONMENT, FILESYSTEM_EXECUTABLE, FILESYSTEM_IMAGE_LAYOUT_LABEL, FILESYSTEM_IMAGE_PROTOCOL_LABEL, FILESYSTEM_IMAGE_SOURCE_LABEL,
  FILESYSTEM_IMAGE_USER_LABEL, FILESYSTEM_LAYOUT, FILESYSTEM_MARKER, FILESYSTEM_PROTOCOL } from '../workspace/live/protocol.js';

export interface DockerFilesystemHelperPreparationOptions {
  readonly directory: string;
  readonly toolchainImageDigest: string;
  readonly user: Readonly<{ uid: number; gid: number }>;
}
export interface DockerFilesystemHelperPreparation {
  readonly directory: string;
  readonly toolchainImageDigest: string;
  readonly protocol: typeof FILESYSTEM_PROTOCOL;
  readonly layout: typeof FILESYSTEM_LAYOUT;
  readonly executable: typeof FILESYSTEM_EXECUTABLE;
  readonly sourceDigest: string;
  readonly user: Readonly<{ uid: number; gid: number }>;
  readonly files: readonly Readonly<{ path: string; sha256: string }>[];
}

const sourceFiles = Object.freeze(['helper.c', 'protocol.h', 'operations.c', 'filesystem.h', 'transport.c']);
const preparationSchema = z.strictObject({
  directory: z.string().min(2).max(4096).refine((value) => isAbsolute(value) && normalize(value) === value && !value.endsWith('/')
    && !/[\u0000-\u001f\u007f]/u.test(value), 'Canonical absolute fresh directory required'),
  toolchainImageDigest: z.string().max(512).regex(/^(?:sha256:[a-f0-9]{64}|[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64})$/u),
  user: z.strictObject({ uid: z.number().int().min(1).max(262143), gid: z.number().int().min(1).max(262143) }),
});

export async function prepareDockerSandboxFilesystemHelper(options: DockerFilesystemHelperPreparationOptions): Promise<DockerFilesystemHelperPreparation> {
  const parsed = preparationSchema.safeParse(options);
  if (!parsed.success) throw new SandboxValidationError(normalizeZodValidationError(preparationSchema, parsed.error, options));
  const { directory, toolchainImageDigest, user } = parsed.data;
  const parent = dirname(directory);
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new TypeError('Filesystem preparation requires a stable physical parent directory.');
  // Shipped native assets are package inputs, independent of the controller's compiler and PATH.
  const artifacts: Array<{ path: string; bytes: Buffer; sha256: string }> = [];
  for (const path of sourceFiles) {
    const bytes = await readFile(new URL(`../../native/filesystem/${path}`, import.meta.url));
    if (bytes.length > 256 * 1024) throw new TypeError('Filesystem helper source exceeds its artifact bound.');
    artifacts.push({ path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const files = Object.freeze(artifacts.map(({ path, sha256 }) => Object.freeze({ path, sha256 })));
  const sourceDigest = `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
  const result = Object.freeze({ directory, toolchainImageDigest, protocol: FILESYSTEM_PROTOCOL, layout: FILESYSTEM_LAYOUT,
    executable: FILESYSTEM_EXECUTABLE, sourceDigest, user: Object.freeze(user), files });
  await mkdir(directory, { mode: 0o700 });
  for (const artifact of artifacts) await writeFile(join(directory, artifact.path), artifact.bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const compiler = '/usr/local/bin/gcc';
  const flags = '-std=c17 -O2 -static -Wall -Wextra -Werror -Wformat=2 -Wconversion -fno-ident -ffile-prefix-map=/build=. -Wl,--build-id=none';
  const marker = JSON.stringify({ layout: FILESYSTEM_LAYOUT, uid: user.uid, gid: user.gid });
  const dockerfile = [
    `FROM ${toolchainImageDigest} AS compiler`, 'WORKDIR /build', 'COPY helper.c protocol.h operations.c filesystem.h transport.c /build/',
    `RUN ${compiler} --version > compiler.txt && ${compiler} ${flags} helper.c operations.c transport.c -o helper && \\`,
    `    ${compiler} ${flags} helper.c operations.c transport.c -o repeated && /usr/bin/cmp helper repeated && \\`,
    '    /usr/bin/sha256sum helper > helper.sha256 && /bin/chmod 0555 helper',
    `RUN /bin/mkdir -m 0700 /layout /layout/store /layout/store/work /layout/store/stage && \\`,
    `    /usr/bin/printf '%s\\n' '${marker}' > /layout/store/${FILESYSTEM_MARKER} && \\`,
    `    /bin/chmod 0400 /layout/store/${FILESYSTEM_MARKER} && /bin/chown -R ${user.uid}:${user.gid} /layout/store`,
    'FROM scratch', `COPY --from=compiler /build/helper ${FILESYSTEM_EXECUTABLE}`,
    'COPY --from=compiler /build/helper.sha256 /build/compiler.txt /usr/local/share/agenai-filesystem/',
    'COPY --from=compiler /layout/ /', ...FILESYSTEM_ENVIRONMENT.map((entry) => `ENV ${entry}`), `USER ${user.uid}:${user.gid}`, 'WORKDIR /store',
    `LABEL ${FILESYSTEM_IMAGE_PROTOCOL_LABEL}="${FILESYSTEM_PROTOCOL}" ${FILESYSTEM_IMAGE_SOURCE_LABEL}="${sourceDigest}" ${FILESYSTEM_IMAGE_LAYOUT_LABEL}="${FILESYSTEM_LAYOUT}" ${FILESYSTEM_IMAGE_USER_LABEL}="${user.uid}:${user.gid}"`,
    `ENTRYPOINT ["${FILESYSTEM_EXECUTABLE}"]`, '',
  ].join('\n');
  // Publish the fixed build recipe last; a partial context never represents complete preparation.
  await writeFile(join(directory, 'Dockerfile'), dockerfile, { flag: 'wx', mode: 0o600 });
  return result;
}
