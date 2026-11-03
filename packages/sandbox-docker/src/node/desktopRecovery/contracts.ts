import type { OperationOptions, SandboxReconciliation, SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type {
  DockerDesktopCoordinatorOperationOptions, DockerDesktopCoordinatorOptions,
} from '../../network/desktop/coordinator/contracts.js';
import type { DockerDesktopCoordinatorMemberConfiguration } from '../../policy/options.js';

export const DESKTOP_RECOVERY_PROTOCOL = 'agenai.desktop-recovery-observer.v1';
export const DESKTOP_RECOVERY_PROFILE = 'stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1';

export interface DockerDesktopRecoveryHelper {
  readonly protocol: typeof DESKTOP_RECOVERY_PROTOCOL;
  readonly sourceDigest: string;
  readonly executable: Readonly<{ path: string; sha256: string }>;
}

export interface DockerDesktopRecoveryControllerOptions {
  readonly original: DockerDesktopCoordinatorOptions;
  readonly helper: DockerDesktopRecoveryHelper;
  readonly desktop: Readonly<{
    profile: typeof DESKTOP_RECOVERY_PROFILE;
    applicationPath: '/Applications/Docker.app';
  }>;
}

export type DockerDesktopRecoveryFailure =
  | Readonly<{ kind: 'busy' }>
  | Readonly<{ kind: 'invalid_input' }>
  | Readonly<{ kind: 'invalid_state' }>
  | Readonly<{ kind: 'preparation_invalid' }>
  | Readonly<{ kind: 'unsupported'; reason: 'profile' | 'original_format' | 'no_id_noncontainer' }>
  | Readonly<{ kind: 'identity_conflict'; scope: 'engine' | 'endpoint' | 'configuration' | 'generation' | 'authority_handle' | 'store' | 'evidence' }>
  | Readonly<{ kind: 'journal_invalid'; reason: 'missing' | 'corrupt' | 'substituted' | 'unpublished_temp' }>
  | Readonly<{ kind: 'capacity_exhausted'; resource: 'journal' | 'evidence' | 'observation' | 'sequence' }>
  | Readonly<{ kind: 'observation_incomplete'; reason: 'producer' | 'stopped_interval' | 'fresh_boot' | 'restoration' | 'composition' | 'expired' }>
  | Readonly<{ kind: 'interrupted'; by: 'signal' | 'deadline'; effect: 'not_entered' | 'owned' }>
  | Readonly<{ kind: 'persistence_failed'; boundary: 'conversion' | 'attempt' | 'evidence' | 'member' | 'transition' | 'settlement' | 'terminal' | 'clean' | 'release' }>
  | Readonly<{ kind: 'authority_lost'; source: 'native_holder' | 'host' | 'socket' | 'engine' | 'vm' | 'store' }>
  | Readonly<{ kind: 'retained_ownership'; members: readonly string[]; pendingOperation: boolean }>;

export type DockerDesktopRecoveryState =
  | Readonly<{ kind: 'inert' }>
  | Readonly<{ kind: 'opening'; expectedGeneration: string }>
  | Readonly<{ kind: 'blocked'; failure: DockerDesktopRecoveryFailure }>
  | Readonly<{ kind: 'ready'; generation: string; barrier: 'required' | 'accepted' }>
  | Readonly<{ kind: 'observing'; generation: string; attempt: number; phase: 'arming' | 'armed' | 'stopped' | 'finishing' }>
  | Readonly<{ kind: 'terminal_ready'; generation: string }>
  | Readonly<{ kind: 'fenced'; generation: string; failure: DockerDesktopRecoveryFailure }>
  | Readonly<{ kind: 'released'; generation: string; result: 'retained' }>
  | Readonly<{ kind: 'closed'; generation: string; result: 'clean' }>;

export interface DockerDesktopRecoveryController {
  readonly state: DockerDesktopRecoveryState;
  readonly members: readonly SandboxRecoveryRecord[];
  open(input: Readonly<{ expectedGeneration: string;
    replaceHelper?: Readonly<{ expected: DockerDesktopRecoveryHelper }> }>, options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
  beginObservation(options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
  observeStopped(options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
  finishObservation(options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
  reconcile(input: Readonly<{
    configuration: DockerDesktopCoordinatorMemberConfiguration;
    record: SandboxRecoveryRecord;
  }>, options?: OperationOptions): Promise<SandboxReconciliation>;
  settle(options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
  close(options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
  release(options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
}

export class DockerDesktopRecoveryError extends Error {
  constructor(
    readonly failure: DockerDesktopRecoveryFailure,
    readonly owner: DockerDesktopRecoveryController,
    options?: ErrorOptions,
  ) {
    super(`Docker Desktop recovery ${failure.kind.replaceAll('_', ' ')}.`, options);
    this.name = 'DockerDesktopRecoveryError';
    this.failure = failure.kind === 'retained_ownership'
      ? Object.freeze({ ...failure, members: Object.freeze([...failure.members]) }) : Object.freeze({ ...failure });
  }
}
