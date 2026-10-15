import type { NodeAcpExecutionBoundary } from '@agen-ai/provider-acp/node';

interface LinuxExecutionHostMounts {
  /** Physical canonical sources, mounted at the same absolute path inside the target. */
  readonly mounts: readonly Readonly<{ path: string; writable: boolean }>[];
}

/** Host mode shares the host network/abstract Unix socket namespace and requires explicit inputs. */
export type LinuxExecutionHostOptions = LinuxExecutionHostMounts & (
  | Readonly<{ network?: 'isolated'; networkInputs?: never }>
  | Readonly<{ network: 'host'; networkInputs: Readonly<{ resolver: string; hosts: string; certificates: string }> }>
);

export interface LinuxExecutionLimits {
  readonly tasksMax: 64;
  readonly memoryMaxBytes: 536870912;
  readonly runtimeMaxSec: 180;
}

export interface LinuxExecutionObservation {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly epoch: string;
  readonly reservationId: string;
  readonly limits: LinuxExecutionLimits;
  readonly network: 'isolated' | 'host';
}

export interface LinuxExecutionHost {
  /** Starts the trusted external supervisor. Retain this owner if startup rejects. */
  start(): Promise<void>;
  /** Retires retained empty boundaries and joins the trusted supervisor. Retry on failure. */
  dispose(): Promise<void>;
  readonly executionBoundary: NodeAcpExecutionBoundary;
  /** Read-only identity for an independent observer; contains no cleanup capability. */
  observation(): Promise<LinuxExecutionObservation>;
  hostIdentity(): Readonly<{
    unit: string;
    epoch: string;
    operationRoot: string | null;
    network: 'isolated' | 'host';
    limits: LinuxExecutionLimits;
    externalIntervention: 'host_cleanup_recovery' | null;
    networkInputs: readonly Readonly<{ destination: string; sha256: string | null }>[];
  }>;
}

/** Construction and executionBoundary.reserve are synchronous and inert. */
export function createLinuxExecutionHost(options: LinuxExecutionHostOptions): LinuxExecutionHost;
