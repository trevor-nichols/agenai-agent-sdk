import type { DockerSandboxBackendOptions } from '../../policy/options.js';
import type { DockerSandboxProfile } from '../../policy/profiles.js';

export type DockerImageFileSelection = Readonly<{ path: string }> & (
  | Readonly<{ kind: 'file' | 'symlink' | 'absent' }>
  | Readonly<{ kind: 'directory'; recursive?: boolean }>
);

export interface DockerImageInspectionLimits {
  readonly maxFiles: number;
  readonly maxMembers: number;
  readonly maxBytes: number;
  readonly maxArchiveBytes: number;
  /** Total acquisition/read deadline. Original cleanup has separate bounded, uncancelled Engine requests. */
  readonly timeoutMs: number;
}

export interface DockerImageInspectionOptions extends Pick<DockerSandboxBackendOptions, 'endpoint' | 'imageDigest'> {
  readonly profile: DockerSandboxProfile;
  readonly selections: readonly DockerImageFileSelection[];
  readonly limits: DockerImageInspectionLimits;
  readonly signal?: AbortSignal;
}

interface Metadata {
  readonly path: string;
  /** POSIX permission and special bits, without a file-type encoding. */
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

export type DockerImageFileObservation = Metadata & (
  | Readonly<{ kind: 'file'; size: number; sha256: string }>
  | Readonly<{ kind: 'directory' }>
  | Readonly<{ kind: 'symlink'; target: string }>
);

export interface DockerImageInspection {
  readonly endpoint: string;
  readonly imageDigest: string;
  readonly profile: DockerSandboxProfile;
  readonly platform: 'linux/amd64' | 'linux/arm64';
  readonly daemonId: string;
  readonly imageConfig: Readonly<{
    env: readonly string[]; entrypoint: readonly string[]; cmd: readonly string[];
    user: string; workingDirectory: string; labels: Readonly<Record<string, string>>;
  }>;
  /** Includes real directory ancestors. Directory descendants appear only for recursive selections. */
  readonly entries: readonly DockerImageFileObservation[];
  readonly absences: readonly string[];
}

export interface DockerImageInspectionCleanupIdentity {
  readonly endpoint: string;
  readonly daemonId: string;
  readonly imageDigest: string;
  readonly profile: DockerSandboxProfile;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface DockerImageInspectionCleanup {
  readonly identity: DockerImageInspectionCleanupIdentity;
  /** Retries only original cleanup; never creates, inspects artifacts again, or returns usable observations. */
  retryCleanup(): Promise<void>;
}

export class DockerImageInspectionError extends Error {
  constructor(message: string, readonly cleanup: DockerImageInspectionCleanup | undefined, options: ErrorOptions) {
    super(message, options);
    this.name = 'DockerImageInspectionError';
  }
}
