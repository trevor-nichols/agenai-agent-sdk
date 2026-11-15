import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { prepareSandboxCredentialBootstrap } from '@agen-ai/sandbox/node';
import { GROK_DOCKER_APPROVAL_MAPPING } from '../index.js';
import type { GrokDockerApprovalProfile, GrokDockerApprovalProfilePreparation, GrokDockerApprovalProfilePreparationOptions } from './contracts.js';
import { fields, invalid } from './data.js';
import { ABSENCES, artifacts, BOOTSTRAP, EMPTY_DIRECTORIES, GRANT_SCOPE, GROK_HOME, identity, NATIVE, nativePlatform, profile, sha256 } from './profile.js';

function captureDeniedBashPatterns(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const entries = Object.getOwnPropertyDescriptors<object>(value);
  const length: unknown = entries.length?.value;
  if (typeof length !== 'number' || length > 32 || Reflect.ownKeys(entries).length !== length + 1) invalid();
  const patterns: string[] = [];
  let bytes = 0;
  for (let index = 0; index < length; index += 1) {
    const entry = entries[String(index)];
    if (!entry?.enumerable || !('value' in entry)) invalid();
    const pattern: unknown = entry.value;
    if (typeof pattern !== 'string' || !pattern.isWellFormed() || pattern.length < 1
      || /[\u0000-\u001f\u007f]/u.test(pattern) || Buffer.byteLength(pattern) > 4096) invalid();
    bytes += Buffer.byteLength(pattern);
    if (bytes > 16384) invalid();
    patterns.push(pattern);
  }
  return Object.freeze(patterns);
}

export function captureProfile(value: unknown): GrokDockerApprovalProfile {
  const input = fields(value, ['instanceId', 'nativeSessionId', 'policy', 'credentialBootstrap'], ['deniedBashPatterns']);
  const bootstrap = fields(input.credentialBootstrap, ['sha256']);
  if (typeof bootstrap.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(bootstrap.sha256)) invalid();
  return Object.freeze({ ...identity({ instanceId: input.instanceId, nativeSessionId: input.nativeSessionId, policy: input.policy }),
    credentialBootstrap: Object.freeze({ sha256: bootstrap.sha256 }),
    ...(Object.hasOwn(input, 'deniedBashPatterns') ? { deniedBashPatterns: captureDeniedBashPatterns(input.deniedBashPatterns) } : {}) });
}

/** Writes only offline, credential-free build inputs; all compilation/building is caller-owned. */
export async function prepareGrokDockerApprovalProfile(options: GrokDockerApprovalProfilePreparationOptions): Promise<GrokDockerApprovalProfilePreparation> {
  const input = fields(options, ['directory', 'profile', 'dockerProfile', 'baseImageDigest']);
  const selected = captureProfile(input.profile);
  const selectedProfile = profile(input.dockerProfile);
  const baseImageDigest = input.baseImageDigest;
  if (typeof baseImageDigest !== 'string' || baseImageDigest.length > 512
    || !/^(?:sha256:[a-f0-9]{64}|[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64})$/u.test(baseImageDigest)) invalid();
  const directory = input.directory;
  if (typeof directory !== 'string' || directory.length > 4096 || !isAbsolute(directory)
    || normalize(directory) !== directory || directory.endsWith('/') || /[\u0000-\u001f\u007f]/u.test(directory)) invalid();
  const parent = dirname(directory);
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) invalid();
  const prepared = artifacts(selected);
  const directories = [...new Set(['/opt', '/opt/agenai', '/opt/agenai/bin', GROK_HOME, `${GROK_HOME}/sessions`, GRANT_SCOPE,
    ...EMPTY_DIRECTORIES, '/etc', '/usr', '/usr/share', '/root', '/home', '/home/node', '/home/sandbox'])];
  const contextFiles = [
    { path: 'Dockerfile', bytes: Buffer.from([
      `FROM --platform=${nativePlatform(selectedProfile)} ${baseImageDigest} AS base`,
      'FROM scratch', 'COPY --from=base / /',
      `RUN rm -rf /opt/agenai ${ABSENCES.join(' ')} && mkdir -p ${directories.join(' ')} && chown 0:0 ${directories.join(' ')} && chmod 0755 ${directories.join(' ')}`,
      'COPY --chown=0:0 rootfs/ /',
      'COPY --chown=0:0 --chmod=0111 grok /opt/agenai/bin/grok',
      `COPY --chown=0:0 --chmod=0555 agenai-credential-bootstrap ${BOOTSTRAP}`,
      `RUN chown 0:0 ${directories.join(' ')} && chmod 0755 ${directories.join(' ')} && chmod 0555 /opt/agenai/bin/launch-grok && chmod 0444 ${prepared.filter((item) => item.mode === 0o444).map((item) => item.path).join(' ')} && ln -s /home/sandbox/session ${GRANT_SCOPE}/${selected.nativeSessionId} && ln -s /home/sandbox/logs ${GROK_HOME}/logs`,
      'WORKDIR /workspace/work', '',
    ].join('\n')) },
    { path: 'BUILDING.md', bytes: Buffer.from([
      '# Controlled Grok offline context', '',
      'Supply the trusted, explicitly pinned base filesystem locally. This context executes no build commands during preparation.',
      'Compile the unmodified SDK sources in credential-bootstrap-sources/ explicitly using a trusted Linux toolchain for this target.',
      `Place that executable at agenai-credential-bootstrap; its SHA-256 must be ${selected.credentialBootstrap.sha256}.`,
      `Place the official Grok 1.0.77 ELF at grok: ${NATIVE[selectedProfile].size} bytes, SHA-256 ${NATIVE[selectedProfile].sha256}.`,
      'Explicitly build for the recorded platform with network disabled and pulling disabled. No credentials belong in this context.',
      'The base filesystem and caller toolchain are trusted inputs; the bootstrap hash identifies the compiled SDK helper and does not attest arbitrary helper behavior.',
      'The final image is borrowed. Keep it unchanged through admission and workload destruction, then delete it explicitly if desired.',
      'Preparation directories and partial offline output remain caller-owned. Native installed qualification is a separate milestone.', '',
    ].join('\n')) },
    ...prepared.map((artifact) => ({ path: `rootfs${artifact.path}`, bytes: artifact.bytes })),
  ];
  const [recipe, ...supportFiles] = contextFiles;
  await mkdir(directory, { mode: 0o700 });
  const credentialBootstrapSources = await prepareSandboxCredentialBootstrap({ directory: join(directory, 'credential-bootstrap-sources') });
  for (const artifact of supportFiles) {
    await mkdir(dirname(join(directory, artifact.path)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, artifact.path), artifact.bytes, { flag: 'wx', mode: 0o600 });
  }
  const result: GrokDockerApprovalProfilePreparation = Object.freeze({ directory, mapping: GROK_DOCKER_APPROVAL_MAPPING,
    profile: selected, dockerProfile: selectedProfile, baseImageDigest, native: NATIVE[selectedProfile], credentialBootstrapSources,
    files: Object.freeze(contextFiles.map(({ path, bytes }) => Object.freeze({ path, sha256: sha256(bytes) }))) });
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  // Publish the executable build recipe only after its complete offline input set exists.
  await writeFile(join(directory, 'Dockerfile'), recipe.bytes, { flag: 'wx', mode: 0o600 });
  return result;
}
