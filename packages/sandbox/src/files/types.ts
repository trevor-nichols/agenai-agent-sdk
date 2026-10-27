// ------------------------------------------------------------------------------------------------
//                types.ts - Streaming trees, caller quotas and canonical guest paths
// ------------------------------------------------------------------------------------------------

declare const relativePathBrand: unique symbol;
declare const guestPathBrand: unique symbol;
declare const symlinkTargetBrand: unique symbol;

export type SandboxRelativePath = string & { readonly [relativePathBrand]: true };
export type SandboxGuestPath = string & { readonly [guestPathBrand]: true };
export type SandboxSymlinkTarget = string & { readonly [symlinkTargetBrand]: true };
export type SandboxSymlinkPolicy = 'reject' | 'preserve_internal';
export type SandboxTransferSymlinkSupport = false | Readonly<{ kind: 'preserve_internal'; import: 'empty_workspace' }>;

export type SandboxByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
export type SandboxTreeEntry =
  | Readonly<{ kind: 'directory'; path: string }>
  | Readonly<{ kind: 'symlink'; path: string; target: string }>
  | Readonly<{ kind: 'file'; path: string; byteLength: number; executable: boolean;
      open(input: Readonly<{ signal: AbortSignal }>): SandboxByteSource }>;

export type SandboxTreeSource = AsyncIterable<SandboxTreeEntry> | Iterable<SandboxTreeEntry>;
export type SandboxInputTreeEntry =
  | Readonly<{ kind: 'directory'; path: SandboxRelativePath }>
  | Readonly<{ kind: 'symlink'; path: SandboxRelativePath; target: SandboxSymlinkTarget }>
  | Readonly<{ kind: 'file'; path: SandboxRelativePath; byteLength: number; executable: boolean;
      open(input: Readonly<{ signal: AbortSignal }>): SandboxByteSource }>;

export type SandboxExportEntry =
  | Readonly<{ kind: 'directory'; path: string }>
  | Readonly<{ kind: 'symlink'; path: string; target: string }>
  | Readonly<{ kind: 'file'; path: string; byteLength: number; executable: boolean;
      bytes: AsyncIterable<Uint8Array> }>;

export type SandboxExportConsumer = (entry: SandboxExportEntry, input: Readonly<{ signal: AbortSignal }>) => Promise<void>;

export type SandboxTreeSelection =
  | Readonly<{ kind: 'workspace' }>
  | Readonly<{ kind: 'files'; paths: AsyncIterable<string> | Iterable<string> }>
  | Readonly<{ kind: 'subtree'; path: string }>;

export type SandboxInputTreeSelection =
  | Readonly<{ kind: 'workspace' }>
  | Readonly<{ kind: 'files'; paths: AsyncIterable<SandboxRelativePath> }>
  | Readonly<{ kind: 'subtree'; path: SandboxRelativePath }>;

export type SandboxCapturedTreeSelection =
  | Readonly<{ kind: 'workspace' }>
  | Readonly<{ kind: 'files'; paths: AsyncIterable<string> | Iterable<string> }>
  | Readonly<{ kind: 'subtree'; path: SandboxRelativePath }>;

export type SandboxTransferQuotaName = 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes' | 'maxArchiveBytes' | 'maxPaths' | 'maxSymlinks';
export type SandboxTransferQuotas = Readonly<Partial<Record<SandboxTransferQuotaName, number | bigint>>>;
export type SandboxTransferBudget = Readonly<Partial<Record<SandboxTransferQuotaName, bigint>>>;

export interface SandboxTransferOptions {
  /** Omission rejects links. Preserving imports require an actually empty backend workspace. */
  readonly symlinks?: SandboxSymlinkPolicy;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: string;
  readonly quotas?: SandboxTransferQuotas;
}

export interface SandboxTransferSummary {
  readonly files: bigint;
  readonly directories: bigint;
  readonly symlinks: bigint;
  readonly payloadBytes: bigint;
  readonly archiveBytes: bigint;
}
