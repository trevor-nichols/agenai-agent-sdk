import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { z } from 'zod/v4';
import type { DockerDesktopHostObserverPreparationOptions } from './prepareDesktopObservers.js';

export interface DockerDesktopCoordinatorPreparationOptions {
  readonly directory: string;
  readonly toolchain: DockerDesktopHostObserverPreparationOptions['toolchain'];
}

export interface DockerDesktopCoordinatorPreparation {
  readonly directory: string;
  readonly protocol: 'agenai.desktop-coordinator.v1';
  readonly architecture: 'darwin/arm64';
  readonly executable: 'agenai-desktop-coordinator';
  readonly sourceDigest: string;
  readonly files: readonly Readonly<{ path: string; sha256: string }>[];
  readonly commands: readonly Readonly<{ executable: string; arguments: readonly string[] }>[];
}

const physicalPath = z.string().refine((value) => Buffer.byteLength(value) >= 2 && Buffer.byteLength(value) <= 4096
  && isAbsolute(value) && normalize(value) === value && !value.endsWith('/') && !/[\u0000-\u001f\u007f]/u.test(value), 'Canonical absolute path required');
const version = z.string().regex(/^[0-9]{1,3}\.[0-9]{1,3}(?:\.[0-9]{1,3})?$/u);
const preparationSchema = z.strictObject({ directory: physicalPath,
  toolchain: z.strictObject({ compiler: z.strictObject({ path: physicalPath, sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
    sdk: z.strictObject({ path: physicalPath, version }), deploymentTarget: version }) });
const SOURCE_PATHS = Object.freeze([
  'native/desktop/coordinator/coordinator.h',
  'native/desktop/coordinator/authority.c',
  'native/desktop/coordinator/storage.c',
  'native/desktop/coordinator/main.c',
]);

function capture(input: unknown, depth = 0): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (depth > 3 || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('Desktop coordinator preparation requires plain data objects.');
  }
  const names = Reflect.ownKeys(input);
  if (names.length > 16) throw new TypeError('Desktop coordinator preparation exceeds its field bound.');
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(input, name);
    if (typeof name !== 'string' || name === '__proto__' || !property?.enumerable || !('value' in property)) {
      throw new TypeError('Desktop coordinator preparation forbids accessors, symbols and hidden fields.');
    }
    result[name] = capture(property.value, depth + 1);
  }
  return result;
}

async function readSources() {
  const artifacts = await Promise.all(SOURCE_PATHS.map(async (path) => {
    const bytes = await readFile(new URL(`../../${path}`, import.meta.url));
    if (bytes.length > 256 * 1024) throw new TypeError('Desktop coordinator source exceeds its artifact bound.');
    return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const files = Object.freeze(artifacts.map(({ path, sha256 }) => Object.freeze({ path, sha256 })));
  return { artifacts, files, sourceDigest: `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}` };
}

/** Explicit activation verifies preparation against the fixed packaged assets. */
export async function readDesktopCoordinatorSourceDigest(): Promise<string> {
  return (await readSources()).sourceDigest;
}

export async function prepareDockerDesktopCoordinatorHelper(
  options: DockerDesktopCoordinatorPreparationOptions,
): Promise<DockerDesktopCoordinatorPreparation> {
  const captured = capture(options);
  const parsed = preparationSchema.safeParse(captured);
  if (!parsed.success) throw new SandboxValidationError(normalizeZodValidationError(preparationSchema, parsed.error, captured));
  const { directory, toolchain } = parsed.data;
  const parent = dirname(directory);
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) {
    throw new TypeError('Desktop coordinator preparation requires a stable physical parent directory.');
  }
  const { artifacts, files, sourceDigest } = await readSources();
  const executable = 'agenai-desktop-coordinator';
  const flags = ['-isysroot', toolchain.sdk.path, '-arch', 'arm64', `-mmacosx-version-min=${toolchain.deploymentTarget}`,
    '-std=c11', '-Wall', '-Wextra', '-Wformat=2', '-Werror', '-O2', '-fno-ident', '-Wl,-reproducible',
    'native/desktop/coordinator/main.c', 'native/desktop/coordinator/authority.c', 'native/desktop/coordinator/storage.c'];
  const commands = Object.freeze([
    Object.freeze({ executable: '/usr/bin/shasum', arguments: Object.freeze(['-a', '256', toolchain.compiler.path]) }),
    Object.freeze({ executable: toolchain.compiler.path, arguments: Object.freeze(['--version']) }),
    Object.freeze({ executable: toolchain.compiler.path, arguments: Object.freeze([...flags, '-o', executable]) }),
    Object.freeze({ executable: '/bin/cp', arguments: Object.freeze([executable, `repeat/${executable}`]) }),
    Object.freeze({ executable: toolchain.compiler.path, arguments: Object.freeze([...flags, '-o', executable]) }),
    Object.freeze({ executable: '/usr/bin/cmp', arguments: Object.freeze([executable, `repeat/${executable}`]) }),
    Object.freeze({ executable: '/usr/bin/shasum', arguments: Object.freeze(['-a', '256', executable]) }),
    Object.freeze({ executable: '/usr/bin/codesign', arguments: Object.freeze(['--display', '--verbose=4', executable]) }),
  ]);
  const result: DockerDesktopCoordinatorPreparation = Object.freeze({ directory, protocol: 'agenai.desktop-coordinator.v1',
    architecture: 'darwin/arm64', executable, sourceDigest, files, commands });
  await mkdir(directory, { mode: 0o700 });
  for (const { path, bytes } of artifacts) {
    await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, path), bytes, { flag: 'wx', mode: 0o600 });
  }
  await mkdir(join(directory, 'repeat'), { mode: 0o700 });
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'commands.json'), `${JSON.stringify({ cwd: directory, compilerSha256: toolchain.compiler.sha256,
    commands }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return result;
}
