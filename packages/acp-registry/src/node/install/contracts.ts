import type { AcpInstallPlan, AcpToolchainIdentity } from '../../planning/contracts.js';
import type { AcpRegistryTarget } from '../../catalog/contracts.js';

export interface AcpInstallationLimits {
  readonly maxArtifactBytes: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxPayloadBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxEntries: number;
  readonly maxPathDepth: number;
  readonly maxPathBytes: number;
  readonly maxDownloadRedirects: number;
  readonly artifactTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly maxToolOutputBytes: number;
  readonly maxReceiptBytes: number;
  readonly maxReferences: number;
}

export interface AcpLocalArtifact {
  readonly path: string;
  readonly url?: string;
  readonly sha256?: string;
}

export interface AcpPackageArtifact {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly filename: string;
  readonly sha256: string;
}

export interface AcpToolchainLocation {
  readonly kind: AcpToolchainIdentity['kind'];
  readonly path: string;
}

export interface AcpInspectedToolchain extends AcpToolchainIdentity {
  readonly path: string;
}

export interface AcpInstalledArtifact {
  readonly sourceUrl?: string;
  readonly finalUrl?: string;
  readonly origin: 'local' | 'network';
  readonly measuredSha256: string;
  readonly expectedSha256?: string;
  readonly sizeBytes: number;
}

export type AcpInstalledArgument =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'payload-path'; readonly path: string };

export interface AcpInstalledLaunch {
  readonly command: { readonly kind: 'payload'; readonly path: string }
    | { readonly kind: 'toolchain'; readonly toolchain: 'node' | 'python' };
  readonly args: readonly AcpInstalledArgument[];
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
}

export interface AcpInstalledPackage {
  readonly name: string;
  readonly version: string;
  readonly dependencies: readonly string[];
}

export interface AcpPreparedInstallation {
  readonly launch: AcpInstalledLaunch;
  readonly artifacts: readonly AcpInstalledArtifact[];
  readonly toolchains: readonly AcpInspectedToolchain[];
  readonly packages: readonly AcpInstalledPackage[];
  readonly resolvedLock?: { readonly format: 'npm-package-lock-v3' | 'python-requirements-hashes'; readonly content: string; readonly digest: string };
  readonly verification: {
    readonly expectedArtifactIntegrity: 'verified' | 'not-provided';
    readonly dependencyClosure: 'verified' | 'not-applicable';
    readonly packageCommand: 'verified' | 'not-applicable';
    readonly toolchains: 'verified' | 'not-applicable';
    readonly reproducibility: 'pinned-binary' | 'locked-package-inputs' | 'incomplete';
    readonly gaps: readonly string[];
  };
}

export type AcpInstalledPayloadEntry =
  | { readonly kind: 'directory'; readonly path: string; readonly mode: number }
  | { readonly kind: 'file'; readonly path: string; readonly mode: number; readonly sizeBytes: number; readonly sha256: string }
  | { readonly kind: 'symlink'; readonly path: string; readonly target: string };

export interface AcpInstallationReceipt {
  readonly format: 'acp-registry-installation-v1';
  readonly installationId: string;
  readonly receiptDigest: string;
  readonly plan: AcpInstallPlan;
  readonly payloadDigest: string;
  readonly payload: readonly AcpInstalledPayloadEntry[];
  readonly prepared: AcpPreparedInstallation;
  readonly installedAt: string;
  readonly publication: 'synced-rename' | 'atomic-rename';
}

export interface AcpInstallationIdentity {
  readonly planDigest: string;
  readonly installationId: string;
}

export interface AcpInstallationReference extends AcpInstallationIdentity {
  readonly referenceId: string;
  readonly ownerId: string;
}

export interface AcpInstallationAttempt {
  readonly planDigest: string;
  readonly attemptToken: string;
  readonly operation: 'install' | 'read' | 'acquire' | 'release' | 'remove' | 'recover';
  readonly createdAt: string;
}

export interface AcpInstalledProcessLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly target: AcpRegistryTarget;
}

export interface InstallAcpAgentInput {
  readonly plan: AcpInstallPlan;
  readonly expectedPlanDigest: string;
  readonly toolchains?: readonly AcpToolchainLocation[];
  readonly localArtifacts?: readonly AcpLocalArtifact[];
  readonly packageArtifacts?: readonly AcpPackageArtifact[];
  readonly signal?: AbortSignal;
}

export interface OpenAcpInstallationStoreInput {
  readonly root: string;
  readonly limits?: Partial<AcpInstallationLimits>;
}

export interface AcpInstallationStore {
  install(input: InstallAcpAgentInput): Promise<AcpInstallationReceipt>;
  read(identity: AcpInstallationIdentity): Promise<AcpInstallationReceipt>;
  acquire(input: AcpInstallationIdentity & { readonly ownerId: string }): Promise<AcpInstallationReference>;
  /** The caller keeps this reference active until every process using the launch has stopped. */
  resolveLaunch(reference: AcpInstallationReference): Promise<AcpInstalledProcessLaunch>;
  release(reference: AcpInstallationReference): Promise<void>;
  remove(identity: AcpInstallationIdentity): Promise<void>;
  inspectAttempt(planDigest: string): Promise<AcpInstallationAttempt | undefined>;
  /** Caller must establish quiescence outside this library; age and PID are not proof. */
  recoverAttempt(input: AcpInstallationAttempt & { readonly ownerQuiesced: true }): Promise<void>;
}
