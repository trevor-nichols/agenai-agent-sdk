export type AcpRegistryTarget = 'darwin-aarch64' | 'darwin-x86_64' | 'linux-aarch64' | 'linux-x86_64' | 'windows-aarch64' | 'windows-x86_64';
export type AcpRegistryDistributionKind = 'binary' | 'npx' | 'uvx';

export interface AcpRegistrySource {
  readonly namespace: string;
  readonly kind: 'remote' | 'local';
  readonly channel: 'stable' | 'preview';
  readonly location: string;
  readonly profile: 'published-v1';
}

interface AcpRegistryLaunchArguments {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface AcpRegistryBinaryDistribution extends AcpRegistryLaunchArguments {
  readonly kind: 'binary';
  readonly target: AcpRegistryTarget;
  readonly archive: string;
  readonly sha256?: string;
  /** A contained POSIX-relative payload path, independent of the host platform. */
  readonly executable: string;
}

export interface AcpRegistryPackageDistribution extends AcpRegistryLaunchArguments {
  readonly kind: 'npx' | 'uvx';
  /** Literal catalog metadata; an unversioned specifier has no immutable resolution. */
  readonly package: string;
}

export type AcpRegistryDistribution = AcpRegistryBinaryDistribution | AcpRegistryPackageDistribution;

export interface AcpRegistryEntry {
  readonly identity: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly repository?: string;
  readonly website?: string;
  readonly authors: readonly string[];
  readonly license?: string;
  readonly licenseUrl?: string;
  readonly icon?: string;
  /** Presentation metadata only; it grants no installation or execution authority. */
  readonly bundled?: boolean;
  readonly distributions: readonly AcpRegistryDistribution[];
  readonly digest: string;
}

export interface AcpRegistrySnapshot {
  readonly format: 'acp-registry-published-v1';
  readonly source: AcpRegistrySource;
  readonly sourceIdentity: string;
  /** SHA-256 of the exact accepted UTF-8 input bytes. */
  readonly rawDigest: string;
  /** Canonical digest binding the normalized snapshot and its raw-byte provenance. */
  readonly digest: string;
  readonly entries: readonly AcpRegistryEntry[];
}

export interface AcpRegistryLimits {
  readonly maxSnapshotBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxValues: number;
  readonly maxStringBytes: number;
  readonly maxArgs: number;
  readonly maxEnvEntries: number;
}

export interface ParseAcpRegistrySnapshotInput {
  readonly source: AcpRegistrySource;
  readonly content: string | Uint8Array;
  readonly limits?: Partial<AcpRegistryLimits>;
}
