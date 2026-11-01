import type { DockerDesktopRouteAuthority } from '../../routeAuthority.js';
import type { OperationOptions, SandboxReconciliation, SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerDesktopCoordinatorMemberConfiguration } from '../../../policy/options.js';

export interface DockerDesktopCoordinatorOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface DockerDesktopCoordinatorMemberState {
  readonly sandboxId: string;
  readonly operationId: string;
  readonly kind: 'registered' | 'acquiring' | 'active' | 'draining' | 'retained' | 'cleanup_pending';
}

export interface DockerDesktopCoordinatorGenerationState {
  readonly generation: string;
  readonly members: readonly DockerDesktopCoordinatorMemberState[];
  readonly queuedTransitions: number;
  readonly enteredTransitions: 0 | 1;
}

export type DockerDesktopCoordinatorFailure =
  | Readonly<{ kind: 'busy' }>
  | Readonly<{ kind: 'dirty_generation'; generation: string }>
  | Readonly<{ kind: 'invalid_state' }>
  | Readonly<{ kind: 'invalid_input' }>
  | Readonly<{ kind: 'preparation_invalid' }>
  | Readonly<{ kind: 'identity_conflict'; scope: 'engine' | 'endpoint' | 'configuration' | 'generation' | 'authority_handle' }>
  | Readonly<{ kind: 'journal_invalid'; reason: 'missing' | 'corrupt' | 'substituted' | 'unpublished_temp' }>
  | Readonly<{ kind: 'capacity_exhausted'; resource: 'members' | 'queue' | 'tombstones' | 'journal' | 'observation' }>
  | Readonly<{ kind: 'admission_closed' }>
  | Readonly<{ kind: 'interrupted'; by: 'signal' | 'deadline'; effect: 'not_entered' | 'owned' }>
  | Readonly<{ kind: 'persistence_failed'; boundary: 'generation' | 'member' | 'transition' | 'settlement' | 'clean' }>
  | Readonly<{ kind: 'authority_lost'; source: 'native_holder' | 'host' | 'socket' | 'engine' | 'vm' | 'proxy' | 'observer' | 'control' | 'freshness' }>
  | Readonly<{ kind: 'retained_ownership'; members: readonly string[]; pendingTransition: boolean }>;

export type DockerDesktopCoordinatorState =
  | Readonly<{ kind: 'inert' }>
  | Readonly<{ kind: 'opening'; mode: 'initialize' | 'activate' | 'cleanup' }>
  | Readonly<{ kind: 'blocked'; failure: DockerDesktopCoordinatorFailure }>
  | (DockerDesktopCoordinatorGenerationState & Readonly<{
      kind: 'active'; observation: 'awaiting_member_observer' | 'current' | 'retained';
    }>)
  | (DockerDesktopCoordinatorGenerationState & Readonly<{ kind: 'draining' }>)
  | (DockerDesktopCoordinatorGenerationState & Readonly<{ kind: 'fenced'; failure: DockerDesktopCoordinatorFailure }>)
  | (DockerDesktopCoordinatorGenerationState & Readonly<{ kind: 'recovering' }>)
  | Readonly<{ kind: 'closed'; result: 'never_activated' }>
  | Readonly<{ kind: 'closed'; result: 'clean'; generation: string | null }>;

const authorityBrand = Symbol('DockerDesktopCoordinatorAuthority');
const recoveryBrand = Symbol('DockerDesktopCoordinatorRecovery');

export interface DockerDesktopCoordinatorAuthority {
  readonly [authorityBrand]: true;
  readonly kind: 'desktop_coordinator';
  readonly generation: string;
}

export function createDesktopCoordinatorAuthority(generation: string): DockerDesktopCoordinatorAuthority {
  return Object.freeze({ [authorityBrand]: true as const, kind: 'desktop_coordinator', generation });
}

export interface DockerDesktopCoordinator {
  readonly state: DockerDesktopCoordinatorState;
  initialize(options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
  activate(options?: DockerDesktopCoordinatorOperationOptions): Promise<DockerDesktopCoordinatorAuthority>;
  reopenCleanup(expected?: Readonly<{ expectedGeneration?: string }>, options?: DockerDesktopCoordinatorOperationOptions): Promise<DockerDesktopCoordinatorCleanupOpen>;
  closeAdmission(): void;
  settle(options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
  close(options?: DockerDesktopCoordinatorOperationOptions): Promise<void>;
}

export interface DockerDesktopCoordinatorRecovery {
  readonly [recoveryBrand]: true;
  readonly kind: 'desktop_coordinator_cleanup';
  readonly generation: string;
  readonly members: readonly SandboxRecoveryRecord[];
  reconcile(input: Readonly<{ configuration: DockerDesktopCoordinatorMemberConfiguration; record: SandboxRecoveryRecord }>,
    options?: OperationOptions): Promise<SandboxReconciliation>;
}

export type DockerDesktopCoordinatorCleanupOpen = Readonly<{ kind: 'opened'; recovery: DockerDesktopCoordinatorRecovery }>
  | Readonly<{ kind: 'absent' }>;

export function createDesktopCoordinatorRecoveryFacade(generation: string, members: () => readonly SandboxRecoveryRecord[],
  reconcile: DockerDesktopCoordinatorRecovery['reconcile']): DockerDesktopCoordinatorRecovery {
  const recovery: DockerDesktopCoordinatorRecovery = Object.freeze({ [recoveryBrand]: true as const,
    kind: 'desktop_coordinator_cleanup', generation, get members() { return members(); },
    reconcile(input: Parameters<DockerDesktopCoordinatorRecovery['reconcile']>[0], options?: OperationOptions) {
      if (this !== recovery) throw new TypeError('Cleanup reconciliation requires its original recovery capability.');
      return reconcile(input, options);
    } });
  return recovery;
}

export interface DockerDesktopCoordinatorOptions {
  readonly routeAuthority: DockerDesktopRouteAuthority;
  readonly helper: Readonly<{
    protocol: 'agenai.desktop-coordinator.v1';
    executable: Readonly<{ path: string; sha256: string }>;
    sourceDigest: string;
  }>;
}

export class DockerDesktopCoordinatorError extends Error {
  constructor(
    readonly failure: DockerDesktopCoordinatorFailure,
    readonly owner: DockerDesktopCoordinator,
    options?: ErrorOptions,
  ) {
    super(`Docker Desktop coordinator ${failure.kind.replaceAll('_', ' ')}.`, options);
    this.name = 'DockerDesktopCoordinatorError';
  }
}
