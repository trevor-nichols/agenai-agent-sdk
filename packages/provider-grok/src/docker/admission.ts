import { inspectDockerImageFiles } from '@agen-ai/sandbox-docker/node';
import type { DockerImageFileObservation, DockerImageFileSelection } from '@agen-ai/sandbox-docker/node';
import type { GrokDockerApprovalProfile, GrokDockerBackendOptions } from './contracts.js';
import { ABSENCES, artifacts, BOOTSTRAP, EMPTY_DIRECTORIES, GRANT_SCOPE, GROK_HOME, NATIVE, nativePlatform, PATH, sha256 } from './profile.js';

/** Actual borrowed-image observations; vendor policy remains here, above the neutral Engine owner. */
export async function admitImage(input: GrokDockerApprovalProfile, backend: Pick<GrokDockerBackendOptions, 'profile' | 'endpoint' | 'imageDigest'>): Promise<void> {
  const expected = artifacts(input);
  const selections: DockerImageFileSelection[] = [
    { path: '/opt/agenai/bin/grok', kind: 'file' }, { path: BOOTSTRAP, kind: 'file' },
    ...expected.map(({ path }) => ({ path, kind: 'file' as const })),
    { path: GROK_HOME, kind: 'directory', recursive: true },
    ...EMPTY_DIRECTORIES.map((path) => ({ path, kind: 'directory' as const, recursive: true })),
    { path: `${GRANT_SCOPE}/${input.nativeSessionId}`, kind: 'symlink' }, { path: `${GROK_HOME}/logs`, kind: 'symlink' },
    ...ABSENCES.map((path) => ({ path, kind: 'absent' as const })),
  ];
  const observed = await inspectDockerImageFiles({ endpoint: backend.endpoint, imageDigest: backend.imageDigest,
    profile: backend.profile, selections, limits: { maxFiles: 128, maxMembers: 256, maxBytes: 256 * 1024 ** 2,
      maxArchiveBytes: 272 * 1024 ** 2, timeoutMs: 60_000 } });
  const entries = new Map(observed.entries.map((entry) => [entry.path, entry]));
  const refuse = (): never => { throw new TypeError('The actual Docker image does not match the controlled Grok profile.'); };
  if (observed.platform !== nativePlatform(backend.profile)) refuse();
  const env = observed.imageConfig.env;
  const defaults = [`HOME=/home/sandbox`, 'TMPDIR=/tmp', `PATH=${PATH}`];
  // BuildKit initializes a scratch image with its standard PATH even without an ENV instruction.
  const canonicalPathOnly = env.length === 1 && env[0] === `PATH=${PATH}`;
  if (!canonicalPathOnly && env.length !== 0
    && (env.length !== defaults.length || env.some((value, index) => value !== defaults[index]))) refuse();
  for (const entry of observed.entries) {
    if (entry.uid !== 0 || entry.gid !== 0 || entry.kind === 'directory' && entry.mode !== 0o755
      || entry.kind === 'symlink' && entry.mode !== 0o777 || entry.kind === 'file' && (entry.mode & 0o7022) !== 0) refuse();
  }
  const file = (path: string, hash: string, size?: number, mode?: number): void => {
    const entry = entries.get(path);
    if (!entry || entry.kind !== 'file' || entry.sha256 !== hash || size !== undefined && entry.size !== size
      || mode !== undefined && entry.mode !== mode) refuse();
  };
  const native = NATIVE[backend.profile];
  file('/opt/agenai/bin/grok', native.sha256, native.size, 0o111);
  file(BOOTSTRAP, input.credentialBootstrap.sha256, undefined, 0o555);
  for (const artifact of expected) file(artifact.path, sha256(artifact.bytes), artifact.bytes.byteLength, artifact.mode);
  for (const path of EMPTY_DIRECTORIES) {
    const entry = entries.get(path);
    if (!entry || entry.kind !== 'directory' || observed.entries.some((child) => child.path.startsWith(`${path}/`))) refuse();
  }
  const profilePaths = new Set([GROK_HOME, `${GROK_HOME}/sessions`, GRANT_SCOPE,
    ...EMPTY_DIRECTORIES, ...expected.map(({ path }) => path), `${GRANT_SCOPE}/${input.nativeSessionId}`, `${GROK_HOME}/logs`]);
  if (observed.entries.some((entry) => entry.path.startsWith(`${GROK_HOME}/`) && !profilePaths.has(entry.path))) refuse();
  const link = (path: string, target: string): void => {
    const entry: DockerImageFileObservation | undefined = entries.get(path);
    if (!entry || entry.kind !== 'symlink' || entry.target !== target) refuse();
  };
  link(`${GRANT_SCOPE}/${input.nativeSessionId}`, '/home/sandbox/session');
  link(`${GROK_HOME}/logs`, '/home/sandbox/logs');
  if (ABSENCES.some((path) => !observed.absences.includes(path))) refuse();
}
