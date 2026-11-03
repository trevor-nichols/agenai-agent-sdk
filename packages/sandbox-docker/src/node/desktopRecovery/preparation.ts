import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { z } from 'zod/v4';
import type { DockerDesktopCoordinatorPreparationOptions } from '../prepareDesktopCoordinator.js';
import { DESKTOP_RECOVERY_PROTOCOL } from './contracts.js';

export interface DockerDesktopRecoveryPreparationOptions {
  readonly directory: string;
  readonly toolchain: DockerDesktopCoordinatorPreparationOptions['toolchain'];
}

export interface DockerDesktopRecoveryPreparation {
  readonly directory: string;
  readonly protocol: typeof DESKTOP_RECOVERY_PROTOCOL;
  readonly architecture: 'darwin/arm64';
  readonly executable: 'agenai-desktop-recovery-observer';
  readonly sourceDigest: string;
  readonly files: readonly Readonly<{ path: string; sha256: string }>[];
  readonly commands: readonly Readonly<{ executable: string; arguments: readonly string[] }>[];
}

const physicalPath = z.string().refine((value) => value.isWellFormed() && Buffer.byteLength(value) >= 2
  && Buffer.byteLength(value) <= 4096 && isAbsolute(value) && normalize(value) === value
  && !value.endsWith('/') && !/\p{Cc}/u.test(value), 'Canonical absolute physical path required');
const version = z.string().regex(/^[0-9]{1,3}\.[0-9]{1,3}(?:\.[0-9]{1,3})?$/u);
const preparationSchema = z.strictObject({ directory: physicalPath,
  toolchain: z.strictObject({ compiler: z.strictObject({ path: physicalPath, sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
    sdk: z.strictObject({ path: physicalPath, version }), deploymentTarget: version }) });
const SOURCE_PATHS = Object.freeze([
  'native/desktop/coordinator/coordinator.h',
  'native/desktop/coordinator/authority.c',
  'native/desktop/coordinator/storage.c',
  'native/desktop/recovery/recovery.h',
  'native/desktop/recovery/main.c',
  'native/desktop/recovery/wire.c',
  'native/desktop/recovery/profile.h',
  'native/desktop/recovery/code.c',
  'native/desktop/recovery/processes.c',
  'native/desktop/recovery/endpoint.c',
  'native/desktop/recovery/files.c',
  'native/desktop/recovery/evidence.c',
  'native/desktop/recovery/observation.c',
]);

function capture(input: unknown, depth = 0): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (depth > 3 || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('Desktop recovery preparation requires plain data objects.');
  }
  const names = Reflect.ownKeys(input);
  if (names.length > 16) throw new TypeError('Desktop recovery preparation exceeds its field bound.');
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(input, name);
    if (typeof name !== 'string' || name === '__proto__' || !property?.enumerable || !('value' in property)) {
      throw new TypeError('Desktop recovery preparation forbids accessors, symbols and hidden fields.');
    }
    result[name] = capture(property.value, depth + 1);
  }
  return result;
}

async function readSources() {
  const artifacts = await Promise.all(SOURCE_PATHS.map(async (path) => {
    const bytes = await readFile(new URL(`../../../${path}`, import.meta.url));
    if (bytes.length > 256 * 1024) throw new TypeError('Desktop recovery source exceeds its artifact bound.');
    return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const files = Object.freeze(artifacts.map(({ path, sha256 }) => Object.freeze({ path, sha256 })));
  return { artifacts, files, sourceDigest: `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}` };
}

export async function readDesktopRecoverySourceDigest(): Promise<string> {
  return (await readSources()).sourceDigest;
}

export async function readDesktopRecoveryProfileDigest(): Promise<string> {
  const source = (await readSources()).files.find((file) => file.path === 'native/desktop/recovery/profile.h');
  if (source === undefined) throw new TypeError('Desktop recovery profile asset is missing.');
  return `sha256:${source.sha256}`;
}

/** Writes a fresh, fixed offline context; the caller explicitly builds and verifies it. */
export async function prepareDockerDesktopRecoveryHelper(
  options: DockerDesktopRecoveryPreparationOptions,
): Promise<DockerDesktopRecoveryPreparation> {
  const captured = capture(options);
  const parsed = preparationSchema.safeParse(captured);
  if (!parsed.success) throw new SandboxValidationError(normalizeZodValidationError(preparationSchema, parsed.error, captured));
  const { directory, toolchain } = parsed.data;
  const parent = dirname(directory);
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) {
    throw new TypeError('Desktop recovery preparation requires a stable physical parent directory.');
  }
  const { artifacts, files, sourceDigest } = await readSources();
  const profile = files.find((file) => file.path === 'native/desktop/recovery/profile.h');
  if (profile === undefined) throw new TypeError('Desktop recovery profile asset is missing.');
  const executable = 'agenai-desktop-recovery-observer';
  const flags = ['-isysroot', toolchain.sdk.path, '-arch', 'arm64', `-mmacosx-version-min=${toolchain.deploymentTarget}`,
    '-std=c11', '-Wall', '-Wextra', '-Wformat=2', '-Werror', '-O2', '-fno-ident', '-Wl,-reproducible',
    `-DAGENAI_RECOVERY_SOURCE_DIGEST="${sourceDigest.slice('sha256:'.length)}"`,
    `-DAGENAI_RECOVERY_PROFILE_DIGEST="${profile.sha256}"`,
    ...SOURCE_PATHS.filter((path) => path.endsWith('.c')), '-framework', 'Security', '-framework', 'CoreFoundation', '-lbsm'];
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
  const result: DockerDesktopRecoveryPreparation = Object.freeze({ directory, protocol: DESKTOP_RECOVERY_PROTOCOL,
    architecture: 'darwin/arm64', executable, sourceDigest, files, commands });
  await mkdir(directory, { mode: 0o700 });
  for (const { path, bytes } of artifacts) {
    await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, path), bytes, { flag: 'wx', mode: 0o600 });
  }
  await mkdir(join(directory, 'repeat'), { mode: 0o700 });
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'commands.json'), `${JSON.stringify({ cwd: directory,
    compilerSha256: toolchain.compiler.sha256, sdk: toolchain.sdk, deploymentTarget: toolchain.deploymentTarget,
    protocol: DESKTOP_RECOVERY_PROTOCOL, architecture: 'darwin/arm64', commands }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return result;
}
