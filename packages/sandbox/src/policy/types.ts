// ------------------------------------------------------------------------------------------------
//                types.ts - Sandbox identity, requested policy and effective enforcement facts
// ------------------------------------------------------------------------------------------------

import type { SandboxFileAccess, SandboxFileSupport } from '../live/types.js';
import type { SandboxTransferSymlinkSupport } from '../files/types.js';

declare const namespaceBrand: unique symbol;
declare const sandboxIdBrand: unique symbol;
declare const processIdBrand: unique symbol;

export type SandboxNamespace = string & { readonly [namespaceBrand]: true };
export type SandboxId = string & { readonly [sandboxIdBrand]: true };
export type SandboxProcessId = string & { readonly [processIdBrand]: true };

export interface SandboxResources {
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly pids: number;
}

export interface SandboxTemporaryStorage {
  readonly homeBytes: number;
  readonly tempBytes: number;
}

export interface SandboxHttpsDestination {
  /** Canonical lowercase ASCII DNS name; IP literals, IDN and search names are unsupported. */
  readonly hostname: string;
  readonly port: number;
}

export type SandboxNetworkPolicy =
  | Readonly<{ kind: 'isolated' }>
  | Readonly<{ kind: 'outbound' }>
  | Readonly<{ kind: 'restricted_https'; destinations: readonly SandboxHttpsDestination[] }>;

export type SandboxNetworkAllowlistSupport = false | Readonly<{ kind: 'https_connect'; maxDestinations: 128 }>;

export type SandboxWorkspaceDiskQuota =
  | Readonly<{ kind: 'not_requested' }>
  /** Allocated filesystem blocks; this does not request inode or logical-file-size enforcement. */
  | Readonly<{ kind: 'required'; bytes: number; accounting: 'allocated_blocks' }>;

export type SandboxExecutionPolicy =
  | Readonly<{ kind: 'until_stopped' }>
  /** Starts at process launch entry; withSandbox also bounds its callback by this duration. */
  | Readonly<{ kind: 'deadline'; timeoutMs: number }>;

export interface SandboxDeadlines {
  readonly startupMs: number;
  readonly cleanupMs: number;
}

export interface SandboxPolicy {
  readonly resources: SandboxResources;
  readonly temporaryStorage: SandboxTemporaryStorage;
  readonly network: SandboxNetworkPolicy;
  readonly files: SandboxFileAccess;
  readonly workspaceDiskQuota: SandboxWorkspaceDiskQuota;
  readonly execution: SandboxExecutionPolicy;
  readonly deadlines: SandboxDeadlines;
  readonly transfers: SandboxTransferBuffers;
  readonly streams: SandboxStreamLimits;
}

export type SandboxPolicyInput = Omit<SandboxPolicy, 'execution' | 'workspaceDiskQuota' | 'files'> & {
  /** Omission grants no live filesystem access. */
  readonly files?: SandboxFileAccess;
  /** Omission normalizes to until_stopped, with no execution timer. */
  readonly execution?: SandboxExecutionPolicy;
  /** Omission requests no hard workspace disk quota. Backend storage limits remain independent. */
  readonly workspaceDiskQuota?: SandboxWorkspaceDiskQuota;
};

export interface SandboxRequestInput {
  readonly policy: SandboxPolicyInput;
}

export interface SandboxRequest {
  readonly policy: SandboxPolicy;
}

export interface SandboxTransferBuffers {
  readonly chunkBytes: number;
  readonly metadataBatchBytes: number;
  readonly metadataMergeFanIn: number;
}

export interface SandboxStreamLimits {
  readonly maxStdinBytes?: number;
  readonly maxOutputBytes?: number;
  /** Public stdin staging, including writes made without respecting backpressure. */
  readonly maxBufferedInputBytes: number;
  /** Combined public stdout/stderr staging; backend transport buffers are bounded separately. */
  readonly maxBufferedOutputBytes: number;
  readonly highWaterMarkBytes: number;
}

export interface SandboxSupport {
  readonly backendId: string;
  readonly backendRevision: string;
  readonly networkModes: readonly SandboxNetworkPolicy['kind'][];
  readonly workspaceDiskQuota: false;
  readonly networkAllowlist: SandboxNetworkAllowlistSupport;
  readonly independentProcessTermination: false;
  /** Omission is unsupported and normalizes to false. */
  readonly files?: SandboxFileSupport;
  readonly transferSymlinks?: SandboxTransferSymlinkSupport;
}

export interface SandboxEffectivePolicy {
  readonly backendIdentity: string;
  readonly isolation: 'container' | 'virtual_machine';
  readonly resources: SandboxResources;
  readonly temporaryStorage: SandboxTemporaryStorage;
  readonly network: SandboxNetworkPolicy;
  /** Omission normalizes to disabled for existing backend drivers. */
  readonly files?: SandboxFileAccess;
  readonly nonRoot: true;
  readonly readOnlyRoot: true;
  readonly workspaceDiskQuota: Readonly<{ kind: 'not_requested' }>;
}
