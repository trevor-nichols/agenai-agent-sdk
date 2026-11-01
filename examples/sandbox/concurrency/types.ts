import type {
  SandboxBackend, SandboxProcessExit, SandboxRecoveryPolicy, SandboxRecoveryRecord,
  SandboxRequestInput, SandboxReservation, SandboxTransferOptions, SandboxTransferSummary,
} from '@agen-ai/sandbox';
import type { DockerDesktopCoordinator, DockerDesktopCoordinatorState } from '@agen-ai/sandbox-docker';

export type ConcurrentMemberLabel = 'a' | 'b' | 'c';
export type ConcurrentRemovalOrder = readonly ['a', 'b'] | readonly ['b', 'a'];

export interface ConcurrentHttpsFixture {
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
  readonly status: number;
  readonly bodyBytes: number;
  readonly bodySha256: string;
}

export interface ConcurrentMemberInput {
  /** A distinct backend explicitly bound to the same original coordinator authority. */
  readonly backend: SandboxBackend;
  readonly request: SandboxRequestInput;
  readonly recovery: SandboxRecoveryPolicy;
  readonly positive: ConcurrentHttpsFixture;
  /** Explicit caller-owned reachable controls; the caller independently verifies listener counters. */
  readonly forbidden: readonly ConcurrentForbiddenFixture[];
  /** Fresh destination under a caller-owned physical host directory. */
  readonly destination: string;
}

export interface ConcurrentForbiddenFixture {
  readonly hostname: string;
  readonly address: string;
  readonly port: number;
  readonly probe: string;
  readonly marker: string;
  readonly transport: 'tcp' | 'udp';
}

export interface ConcurrentForbiddenObservation {
  readonly fixture: ConcurrentForbiddenFixture;
  readonly direct: Readonly<{ kind: 'tcp'; connected: false; code: string | null; message: string }>
    | Readonly<{ kind: 'udp'; received: false; code: string | null; message: string }>;
  readonly proxyStatus: 403;
}

export type ConcurrentWorkflowPhase = 'reserve_before' | 'reserved' | 'prepare_before' | 'prepared'
  | 'dispatch_before' | 'dispatched' | 'continuity_before' | 'continuity' | 'mutation_before' | 'mutated'
  | 'cancel_before' | 'cancelled' | 'stop_before' | 'stopped' | 'export_before' | 'exported'
  | 'destroy_before' | 'destroyed' | 'replacement_before' | 'replacement_ready' | 'completed'
  | 'cleanup_continuity_before' | 'cleanup_continuity';

export interface ConcurrentProcessIdentity {
  readonly label: ConcurrentMemberLabel;
  readonly session: string;
  readonly pid: number;
  readonly platform: string;
  readonly architecture: string;
  readonly node: string;
  readonly cwd: string;
  readonly networkNamespace: string | null;
}

export interface ConcurrentTlsObservation {
  readonly connection: string;
  readonly sequence: number;
  readonly status: number;
  readonly authorized: true;
  readonly certificateFingerprint256: string;
}

export interface ConcurrentContinuity {
  readonly identity: ConcurrentProcessIdentity;
  readonly counter: number;
  readonly held: ConcurrentTlsObservation;
  readonly fresh: Readonly<{ status: number; bodyBytes: number; bodySha256: string; authorized: true; certificateFingerprint256: string }>;
  readonly denied: Readonly<{ hostname: string; port: number; proxyStatus: 403 }>;
  readonly forbidden: readonly ConcurrentForbiddenObservation[];
  readonly sourceSha256: string;
  readonly instructionsSha256: string;
  readonly project: string;
  readonly nativeState: string;
  readonly git: Readonly<{ head: string; detached: true; configSha256: string; indexSha256: string }>;
}

export interface ConcurrentWorkflowObservation {
  readonly sequence: number;
  readonly phase: ConcurrentWorkflowPhase;
  readonly member: ConcurrentMemberLabel | null;
  readonly sandboxId: string | null;
  readonly processId: string | null;
  readonly readerId: string | null;
  readonly coordinator: DockerDesktopCoordinatorState;
  readonly recoveryRecord: SandboxRecoveryRecord | null;
  readonly continuity?: ConcurrentContinuity;
  readonly checkpoint?: string;
}

export interface ConcurrentWorkflowOptions {
  /** Already activated by the caller. The workflow never closes shared authority. */
  readonly coordinator: DockerDesktopCoordinator;
  readonly members: readonly [ConcurrentMemberInput, ConcurrentMemberInput];
  readonly replacement: ConcurrentMemberInput;
  readonly startMode: 'prepare_both' | 'staged_addition';
  readonly removalOrder: ConcurrentRemovalOrder;
  /** Bounds individual protocol operations; the primary has no implicit execution timer. */
  readonly operationTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly transferOptions?: (member: ConcurrentMemberLabel, operation: 'import' | 'export') => SandboxTransferOptions;
  /** Awaited delivery; throwing preserves the original failure and begins owned cleanup. */
  readonly onObservation?: (observation: ConcurrentWorkflowObservation) => Promise<void>;
  /** Original output bytes, delivered by the sole reader before parsing. */
  readonly onOutput?: (output: Readonly<{
    member: ConcurrentMemberLabel; readerId: string; stream: 'stdout' | 'stderr'; bytes: Uint8Array;
  }>) => Promise<void>;
}

export interface ConcurrentMemberResult {
  readonly label: ConcurrentMemberLabel;
  readonly sandboxId: string;
  readonly processId: string;
  readonly readerId: string;
  readonly identity: ConcurrentProcessIdentity;
  readonly imported: SandboxTransferSummary;
  readonly exported: SandboxTransferSummary;
  readonly directory: string;
  readonly processExit: SandboxProcessExit;
  readonly recoveryRecord: SandboxRecoveryRecord;
}

export interface ConcurrentWorkflowResult {
  readonly startMode: ConcurrentWorkflowOptions['startMode'];
  readonly removalOrder: ConcurrentRemovalOrder;
  readonly generation: string;
  readonly members: readonly ConcurrentMemberResult[];
  readonly observations: number;
}

export interface ConcurrentCleanupFailure {
  readonly member: ConcurrentMemberLabel;
  readonly operation: 'destroy' | 'readers' | 'reader_settlement' | 'export_directory'
    | 'entered_operation' | 'entered_operation_settlement' | 'continuity';
  readonly enteredOperation?: string;
  readonly error: unknown;
}

export interface ConcurrentOwnedMember {
  readonly label: ConcurrentMemberLabel;
  readonly owner: SandboxReservation;
}
