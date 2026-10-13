import type { AcpBinaryArchiveFormat } from './binary.js';
import type { AcpRegistryDistribution, AcpRegistryDistributionKind, AcpRegistrySource, AcpRegistryTarget } from '../catalog/contracts.js';

export interface AcpInstallPolicy {
  readonly network: 'offline' | 'allow';
  readonly allowedOrigins: readonly string[];
  readonly allowInsecureHttp: boolean;
  readonly packageScripts: 'deny' | 'allow';
  readonly integrity: 'require-expected-sha256' | 'allow-missing-expected-sha256';
  readonly reproducibility: 'best-effort' | 'require-complete';
  /** Catalog environment is launch-only. Installer environment is never inherited from it. */
  readonly allowedEnvironmentKeys: readonly string[];
}

export interface AcpToolchainIdentity {
  readonly kind: 'node' | 'npm' | 'python' | 'uv';
  readonly version: string;
  /** Measured separately by the caller; no machine-specific executable path enters the plan. */
  readonly sha256: string;
}

export interface AcpPackageResolutionEvidence {
  readonly kind: 'registry-metadata' | 'artifact-inspection';
  readonly digest: string;
}

export interface AcpDependencyLock {
  readonly format: 'npm-package-lock-v3' | 'python-requirements-hashes';
  readonly content: string;
  readonly digest: string;
  /** Complete dependency metadata supplied by the resolver, checked again after installation. */
  readonly packages: readonly AcpLockedPackage[];
}

export interface AcpLockedPackage {
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
  readonly dependencies: readonly string[];
}

export interface AcpPackageResolution {
  readonly kind: 'npx' | 'uvx';
  readonly name: string;
  readonly version: string;
  /** Exact package-owned bin/console-script name, never a command line or filesystem path. */
  readonly command: string;
  readonly evidence?: AcpPackageResolutionEvidence;
  readonly artifact?: { readonly url: string; readonly sha256: string };
  readonly dependencyLock?: AcpDependencyLock;
}

export interface CreateAcpInstallPlanInput {
  readonly entryIdentity: string;
  readonly expectedSnapshotDigest: string;
  readonly expectedEntryDigest: string;
  readonly target: AcpRegistryTarget;
  readonly distributionPreference: readonly AcpRegistryDistributionKind[];
  readonly binaryFormat?: AcpBinaryArchiveFormat;
  readonly policy: AcpInstallPolicy;
  readonly packageResolution?: AcpPackageResolution;
  readonly toolchains?: readonly AcpToolchainIdentity[];
  /** Additional caller-expected binary bytes; disagreement with catalog integrity is rejected. */
  readonly binaryIntegrity?: { readonly sha256: string; readonly evidence: AcpPackageResolutionEvidence };
}

export interface AcpInstallLaunch {
  readonly kind: 'binary' | 'package-bin';
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
}

export interface AcpInstallPlan {
  readonly format: 'acp-registry-install-plan-v1';
  readonly mappingProfile: 'acp-registry-install-v1';
  readonly digest: string;
  readonly source: AcpRegistrySource;
  readonly sourceIdentity: string;
  readonly snapshotDigest: string;
  readonly rawSnapshotDigest: string;
  readonly entry: { readonly identity: string; readonly digest: string; readonly id: string; readonly version: string };
  readonly target: AcpRegistryTarget;
  readonly distributionPreference: readonly AcpRegistryDistributionKind[];
  readonly binaryFormat?: AcpBinaryArchiveFormat;
  readonly distribution: AcpRegistryDistribution;
  readonly launch: AcpInstallLaunch;
  readonly policy: AcpInstallPolicy;
  readonly toolchains: readonly AcpToolchainIdentity[];
  readonly packageResolution?: AcpPackageResolution;
  readonly expectedIntegrity: {
    readonly source: 'catalog' | 'caller' | 'package-resolution' | 'none';
    readonly sha256?: string;
    readonly evidence?: AcpPackageResolutionEvidence;
  };
  readonly verificationObligations: readonly ('payload-integrity' | 'toolchain-identity' | 'package-command' | 'dependency-closure' | 'lock-artifact-integrity')[];
  readonly reproducibility: {
    readonly classification: 'pinned-binary' | 'locked-package-inputs' | 'incomplete';
    readonly gaps: readonly ('expected-sha256-missing' | 'dependency-closure-missing' | 'package-scripts-enabled')[];
    /** Inputs describe requirements. Only an installer can verify installed payload and dependencies. */
    readonly verified: false;
  };
}
