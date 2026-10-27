import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod/v4';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { DESKTOP_HOST_OBSERVATION_PROTOCOL, DESKTOP_VM_CONTROLLER_PROTOCOL, DESKTOP_VM_ENVIRONMENT,
  DESKTOP_VM_EXECUTABLE, DESKTOP_VM_IMAGE_OBSERVATION_LABEL, DESKTOP_VM_IMAGE_PROTOCOL_LABEL,
  DESKTOP_VM_IMAGE_SOURCE_LABEL, DESKTOP_VM_IMAGE_USER_LABEL, DESKTOP_VM_OBSERVATION_PROTOCOL,
  DESKTOP_VM_ROOT, desktopVmObserverCommand } from '../network/desktop/protocol.js';

interface PreparedFile { readonly path: string; readonly sha256: string }
interface PreparedSource {
  readonly directory: string;
  readonly sourceDigest: string;
  readonly files: readonly PreparedFile[];
}

export interface DockerDesktopHostObserverPreparationOptions {
  readonly directory: string;
  readonly toolchain: Readonly<{
    compiler: Readonly<{ path: string; sha256: string }>;
    sdk: Readonly<{ path: string; version: string }>;
    deploymentTarget: string;
  }>;
}

export interface DockerDesktopHostObserverPreparation extends PreparedSource {
  readonly protocol: typeof DESKTOP_HOST_OBSERVATION_PROTOCOL;
  readonly architecture: 'darwin/arm64';
  readonly executable: 'agenai-desktop-host-network';
  readonly toolchain: DockerDesktopHostObserverPreparationOptions['toolchain'];
  readonly commands: readonly Readonly<{ executable: string; arguments: readonly string[] }>[];
}

export interface DockerDesktopVmObserverPreparationOptions {
  readonly directory: string;
  readonly toolchainImageDigest: string;
  readonly baseImageDigest: string;
  readonly user: Readonly<{ uid: number; gid: number }>;
}

export interface DockerDesktopVmObserverPreparation extends PreparedSource {
  readonly protocol: typeof DESKTOP_VM_CONTROLLER_PROTOCOL;
  readonly observationProtocol: typeof DESKTOP_VM_OBSERVATION_PROTOCOL;
  readonly platform: 'linux/arm64';
  readonly executable: typeof DESKTOP_VM_EXECUTABLE;
  readonly toolchainImageDigest: string;
  readonly baseImageDigest: string;
  readonly user: Readonly<{ uid: number; gid: number }>;
}

const physicalPath = z.string().refine((value) => Buffer.byteLength(value) >= 2 && Buffer.byteLength(value) <= 4096
  && isAbsolute(value) && normalize(value) === value && !value.endsWith('/') && !/[\u0000-\u001f\u007f]/u.test(value), 'Canonical absolute path required');
const imageDigest = z.string().max(512).regex(/^(?:sha256:[a-f0-9]{64}|[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64})$/u);
const version = z.string().regex(/^[0-9]{1,3}\.[0-9]{1,3}(?:\.[0-9]{1,3})?$/u);
const hostSchema = z.strictObject({ directory: physicalPath,
  toolchain: z.strictObject({ compiler: z.strictObject({ path: physicalPath, sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
    sdk: z.strictObject({ path: physicalPath, version }), deploymentTarget: version }) });
const vmSchema = z.strictObject({ directory: physicalPath, toolchainImageDigest: imageDigest, baseImageDigest: imageDigest,
  user: z.strictObject({ uid: z.number().int().min(1).max(262143), gid: z.number().int().min(1).max(262143) }) });
const HOST_SOURCES = Object.freeze(['native/desktop/host/observer.c', 'native/desktop/host/observer.h']);
const VM_SOURCES = Object.freeze(['native/desktop/vm/observer.c', 'dist/network/desktop/protocol.js',
  'dist/network/desktop/native.js', 'dist/network/desktop/controller.js', 'dist/network/desktop/entry.js']);

function capture(input: unknown, depth = 0): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (depth > 3 || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('Desktop preparation requires plain data objects.');
  const names = Reflect.ownKeys(input);
  if (names.length > 16) throw new TypeError('Desktop preparation exceeds its field bound.');
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(input, name);
    if (typeof name !== 'string' || name === '__proto__' || !property?.enumerable || !('value' in property)) throw new TypeError('Desktop preparation forbids accessors, symbols and hidden fields.');
    result[name] = capture(property.value, depth + 1);
  }
  return result;
}

async function sources(directory: string, paths: readonly string[]) {
  const parent = dirname(directory);
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new TypeError('Desktop preparation requires a stable physical parent directory.');
  const artifacts: Array<{ path: string; bytes: Buffer; sha256: string }> = [];
  for (const path of paths) {
    const bytes = await readFile(new URL(path.startsWith('dist/') ? `../${path.slice(5)}` : `../../${path}`, import.meta.url));
    if (bytes.length > 256 * 1024) throw new TypeError('Desktop observer source exceeds its artifact bound.');
    artifacts.push({ path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const files = Object.freeze(artifacts.map(({ path, sha256 }) => Object.freeze({ path, sha256 })));
  const sourceDigest = `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
  return { artifacts, files, sourceDigest };
}

async function publishSources(directory: string, artifacts: readonly { path: string; bytes: Buffer }[]) {
  await mkdir(directory, { mode: 0o700 });
  for (const { path, bytes } of artifacts) {
    await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, path), bytes, { flag: 'wx', mode: 0o600 });
  }
}

export async function prepareDockerDesktopHostNetworkObserver(options: DockerDesktopHostObserverPreparationOptions): Promise<DockerDesktopHostObserverPreparation> {
  const captured = capture(options);
  const parsed = hostSchema.safeParse(captured);
  if (!parsed.success) throw new SandboxValidationError(normalizeZodValidationError(hostSchema, parsed.error, captured));
  const { directory } = parsed.data;
  const toolchain = Object.freeze({ compiler: Object.freeze(parsed.data.toolchain.compiler), sdk: Object.freeze(parsed.data.toolchain.sdk),
    deploymentTarget: parsed.data.toolchain.deploymentTarget });
  const { artifacts, files, sourceDigest } = await sources(directory, HOST_SOURCES);
  const flags = ['-isysroot', toolchain.sdk.path, '-arch', 'arm64', `-mmacosx-version-min=${toolchain.deploymentTarget}`,
    '-std=c11', '-Wall', '-Wextra', '-Wformat=2', '-Werror', '-O2', '-fno-ident', '-Wl,-reproducible',
    'native/desktop/host/observer.c', '-framework', 'CoreFoundation', '-framework', 'SystemConfiguration'];
  const executable = 'agenai-desktop-host-network';
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
  const result: DockerDesktopHostObserverPreparation = Object.freeze({ directory, protocol: DESKTOP_HOST_OBSERVATION_PROTOCOL,
    architecture: 'darwin/arm64', executable, sourceDigest, toolchain, commands, files });
  await publishSources(directory, artifacts);
  await mkdir(join(directory, 'repeat'), { mode: 0o700 });
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  // Recipes are data only. The caller verifies the selected compiler/SDK and explicitly executes them.
  await writeFile(join(directory, 'commands.json'), `${JSON.stringify({ cwd: directory, compilerSha256: toolchain.compiler.sha256,
    commands }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return result;
}

export async function prepareDockerDesktopVmRouteObserver(options: DockerDesktopVmObserverPreparationOptions): Promise<DockerDesktopVmObserverPreparation> {
  const captured = capture(options);
  const parsed = vmSchema.safeParse(captured);
  if (!parsed.success) throw new SandboxValidationError(normalizeZodValidationError(vmSchema, parsed.error, captured));
  const { directory, toolchainImageDigest, baseImageDigest } = parsed.data;
  const user = Object.freeze(parsed.data.user);
  const { artifacts, files, sourceDigest } = await sources(directory, VM_SOURCES);
  const result: DockerDesktopVmObserverPreparation = Object.freeze({ directory, toolchainImageDigest, baseImageDigest,
    protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, observationProtocol: DESKTOP_VM_OBSERVATION_PROTOCOL,
    platform: 'linux/arm64', executable: DESKTOP_VM_EXECUTABLE, sourceDigest, user, files });
  await publishSources(directory, artifacts);
  await writeFile(join(directory, 'dist/package.json'), '{"type":"module","private":true}\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const compiler = '/usr/local/bin/gcc';
  const flags = '-std=c17 -O2 -static -Wall -Wextra -Werror -Wformat=2 -Wconversion -fno-ident -ffile-prefix-map=/build=. -Wl,--build-id=none';
  const dockerfile = [
    `FROM --platform=linux/arm64 ${toolchainImageDigest} AS compiler`, 'WORKDIR /build', 'COPY native/desktop/vm/observer.c /build/observer.c',
    `RUN ${compiler} --version > compiler.txt && ${compiler} ${flags} observer.c -o observer && \\`,
    `    ${compiler} ${flags} observer.c -o repeated && /usr/bin/cmp observer repeated && \\`,
    '    /usr/bin/sha256sum observer > observer.sha256 && /bin/chmod 0555 observer',
    `FROM --platform=linux/arm64 ${baseImageDigest} AS source`, 'FROM scratch', 'COPY --from=source / /',
    `COPY --from=compiler /build/observer ${DESKTOP_VM_EXECUTABLE}`,
    'COPY --from=compiler /build/observer.sha256 /build/compiler.txt /usr/local/share/agenai-desktop-route/',
    `COPY dist/ ${DESKTOP_VM_ROOT}/`,
    `RUN ["/usr/local/bin/node","--eval",${JSON.stringify(`const fs=require('node:fs'); for (const p of ${JSON.stringify(['/opt/agenai', DESKTOP_VM_ROOT, `${DESKTOP_VM_ROOT}/network`, `${DESKTOP_VM_ROOT}/network/desktop`])}) fs.chmodSync(p,0o755); for (const p of ${JSON.stringify(VM_SOURCES.filter((path) => path.startsWith('dist/')).map((path) => `${DESKTOP_VM_ROOT}/${path.slice(5)}`))}) fs.chmodSync(p,0o444); fs.chmodSync('${DESKTOP_VM_ROOT}/package.json',0o444);`)}]`,
    ...DESKTOP_VM_ENVIRONMENT.map((entry) => `ENV ${entry}`), `USER ${user.uid}:${user.gid}`, 'WORKDIR /',
    `LABEL ${DESKTOP_VM_IMAGE_PROTOCOL_LABEL}="${DESKTOP_VM_CONTROLLER_PROTOCOL}" ${DESKTOP_VM_IMAGE_OBSERVATION_LABEL}="${DESKTOP_VM_OBSERVATION_PROTOCOL}" ${DESKTOP_VM_IMAGE_SOURCE_LABEL}="${sourceDigest}" ${DESKTOP_VM_IMAGE_USER_LABEL}="${user.uid}:${user.gid}"`,
    `ENTRYPOINT ${JSON.stringify(['/usr/local/bin/node', ...desktopVmObserverCommand()])}`, 'CMD []', '',
  ].join('\n');
  await writeFile(join(directory, 'Dockerfile'), dockerfile, { flag: 'wx', mode: 0o600 });
  return result;
}
