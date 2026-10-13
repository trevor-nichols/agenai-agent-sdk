import type { AcpInstallPlan } from '../../planning/contracts.js';
import type { AcpInstallationLimits, AcpInspectedToolchain, AcpLocalArtifact, AcpPackageArtifact } from './contracts.js';

export interface RunAcpInstallToolInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface AcpInstallToolResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface AcpArtifactBudget {
  bytes: number;
  count: number;
}

export interface AcpInstallPreparationContext {
  readonly plan: AcpInstallPlan;
  readonly payloadRoot: string;
  readonly workRoot: string;
  readonly limits: AcpInstallationLimits;
  readonly signal?: AbortSignal;
  readonly localArtifacts: readonly AcpLocalArtifact[];
  readonly packageArtifacts: readonly AcpPackageArtifact[];
  readonly toolchains: readonly AcpInspectedToolchain[];
  readonly artifactBudget: AcpArtifactBudget;
  readonly runTool: (input: RunAcpInstallToolInput) => Promise<AcpInstallToolResult>;
}
