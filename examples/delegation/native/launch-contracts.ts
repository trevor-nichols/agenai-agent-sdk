// ------------------------------------------------------------------------------------------------
//                launch-contracts.ts - Owned native qualification launch inputs and leases
// ------------------------------------------------------------------------------------------------

import type { NodeAcpLaunchOptions } from '@agen-ai/provider-acp/node';

export interface NativeFileIdentity {
  readonly bytes: number;
  readonly sha256: string;
}

export interface NativeLaunchCandidate {
  readonly native: NativeFileIdentity & {
    readonly version: string;
    readonly target: 'linux-x86_64';
    readonly installedCommandPath: string;
    readonly inspectedExecutablePath: string;
  };
  readonly launch: { readonly args: readonly string[] };
  readonly upstreamArtifact: NativeFileIdentity & {
    readonly url: string;
    readonly decoded: NativeFileIdentity & { readonly magicHex: string };
  };
  readonly transformation: {
    readonly recipe: 'gzip-single-member-stream-v1';
    readonly decoderExecutable: string;
    readonly decoderExecutableSha256: string;
    readonly pythonVersion: string;
    readonly zlibCompileVersion: string;
    readonly zlibRuntimeVersion: string;
    readonly inputChunkBytes: number;
    readonly outputChunkBytes: number;
    readonly maxInputBytes: number;
    readonly maxOutputBytes: number;
    readonly plannedTimeoutMs: number;
  };
}

export type NativeRole = 'discovery' | 'parent' | 'child' | 'comparison';

export interface NativeExecutableEvidence {
  readonly mode: 'direct' | 'registry';
  readonly identity: NativeFileIdentity;
  readonly allocationId: string;
  readonly registry?: {
    readonly snapshotDigest: string;
    readonly planDigest: string;
    readonly installationId: string;
    readonly receiptDigest: string;
    readonly referenceId: string;
    readonly ownerId: string;
    readonly reopenedFromFreshProcess: true;
  };
}

export interface NativeExecutableLease {
  readonly mode: 'direct' | 'registry';
  readonly executable: string;
  readonly identity: NativeFileIdentity;
  readonly evidence: NativeExecutableEvidence;
  assertUnchanged(): Promise<void>;
  /** The host calls this only after every process using this executable has quiesced. */
  release(): Promise<void>;
}

export interface NativeConfigurationFileRecord {
  readonly location: string;
  readonly kind: 'absent' | 'file' | 'directory';
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface NativeProcessAllocation {
  readonly allocationId: string;
  readonly role: NativeRole;
  readonly workingDirectory: string;
  /** Contains secret values. Never serialize or include this object in evidence. */
  readonly launch: NodeAcpLaunchOptions;
  readonly environmentKeys: readonly string[];
  configurationFilesSnapshot(): Promise<readonly NativeConfigurationFileRecord[]>;
  /** The host calls this only after every process using this allocation has quiesced. */
  release(): Promise<void>;
}

export interface NativePreparationInput {
  readonly candidate: NativeLaunchCandidate;
  readonly root: string;
  readonly signal?: AbortSignal;
}

export interface NativeAllocationInput {
  readonly root: string;
  readonly role: NativeRole;
  readonly executable: NativeExecutableLease;
  readonly credential: (signal?: AbortSignal) => string | undefined | Promise<string | undefined>;
  readonly signal?: AbortSignal;
}

export interface RegistryInstallationDescriptor {
  readonly format: 'native-local-raw-installation-v1';
  readonly storeRoot: string;
  readonly installerProcessId: number;
  readonly allocationId: string;
  readonly snapshotDigest: string;
  readonly planDigest: string;
  readonly installationId: string;
  readonly receiptDigest: string;
  readonly native: NativeFileIdentity;
  readonly transformation: NativeFileIdentity & {
    readonly decoded: NativeFileIdentity;
    readonly decoderExecutableSha256: string;
    readonly pythonVersion: string;
    readonly zlibCompileVersion: string;
    readonly zlibRuntimeVersion: string;
  };
}
