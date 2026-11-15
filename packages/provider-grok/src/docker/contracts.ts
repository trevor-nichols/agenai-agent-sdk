import type { AgentProviderDriver } from '@agen-ai/agent-runtime';
import type {
  SandboxPolicyInput, SandboxRecoveryPolicy, SandboxRecoveryRecord, SandboxTransferOptions,
  SandboxTransferSummary, SandboxTransferQuotas, SandboxTreeSelection,
} from '@agen-ai/sandbox';
import type { SandboxDirectoryExportResult, SandboxDirectoryImportOptions, SandboxCredentialBootstrapPreparation } from '@agen-ai/sandbox/node';
import type { DockerSandboxBackendOptions, DockerSandboxEgressOptions } from '@agen-ai/sandbox-docker';
import type { GrokDockerApprovalIdentity } from '../types.js';
import type { GrokDockerProfile } from './profile.js';

/** Identity of the caller-compiled, unmodified SDK credential-bootstrap sources. */
export interface GrokDockerCredentialBootstrap { readonly sha256: string }

export interface GrokDockerApprovalProfile extends GrokDockerApprovalIdentity {
  readonly credentialBootstrap: GrokDockerCredentialBootstrap;
  /** Immutable native Bash deny patterns: prefix-or-glob matching, never an allow or remembered grant. */
  readonly deniedBashPatterns?: readonly string[];
}

export interface GrokDockerApprovalProfilePreparationOptions {
  readonly directory: string;
  readonly profile: GrokDockerApprovalProfile;
  readonly dockerProfile: GrokDockerProfile;
  readonly baseImageDigest: string;
}

export interface GrokDockerApprovalProfilePreparation {
  readonly directory: string;
  readonly mapping: 'grok-build-1.0.77-controlled-shell-v1';
  readonly profile: GrokDockerApprovalProfile;
  readonly dockerProfile: GrokDockerProfile;
  readonly baseImageDigest: string;
  readonly native: Readonly<{ sha256: string; size: number }>;
  readonly credentialBootstrapSources: SandboxCredentialBootstrapPreparation;
  readonly files: readonly Readonly<{ path: string; sha256: string }>[];
}

export type GrokDockerBackendOptions = Pick<DockerSandboxBackendOptions,
  'endpoint' | 'imageDigest' | 'namespace' | 'user' | 'spillDirectory'> & Readonly<{
  profile: GrokDockerProfile;
  egress: DockerSandboxEgressOptions;
}>;

export type GrokDockerWorkloadPolicy = Pick<SandboxPolicyInput,
  'resources' | 'temporaryStorage' | 'execution' | 'deadlines' | 'transfers' | 'streams'>;

export interface GrokDockerProviderOptions {
  readonly profile: GrokDockerApprovalProfile;
  readonly backend: GrokDockerBackendOptions;
  readonly workload: GrokDockerWorkloadPolicy;
  readonly credential: Readonly<{ kind: 'auth_json'; bytes: Uint8Array }>;
  readonly recovery: SandboxRecoveryPolicy;
}

export type GrokDockerTransferOptions = Omit<SandboxTransferOptions, 'deadlineAt' | 'quotas'> & Readonly<{
  deadlineAt: string;
  quotas: Required<Pick<SandboxTransferQuotas, 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes' | 'maxArchiveBytes' | 'maxPaths'>>
    & Pick<SandboxTransferQuotas, 'maxSymlinks'>;
}>;
export type GrokDockerImportOptions = GrokDockerTransferOptions & Pick<SandboxDirectoryImportOptions, 'chunkBytes'>;

export interface GrokDockerProvider {
  readonly driver: AgentProviderDriver;
  readonly workspace: Readonly<{
    importDirectory(directory: string, options: GrokDockerImportOptions): Promise<SandboxTransferSummary>;
    exportDirectory(selection: SandboxTreeSelection, directory: string, options: GrokDockerTransferOptions): Promise<SandboxDirectoryExportResult>;
  }>;
  readonly recoveryRecord: SandboxRecoveryRecord;
  /** Retry this same owner after failure; never reconstruct or replay a native session. */
  dispose(): Promise<void>;
}
