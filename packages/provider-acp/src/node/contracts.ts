import type { AcpProviderLimits } from '../limits.js';
import type { CreateAcpProviderDriverOptions } from '../contracts.js';
import type { NodeAcpExecutionBoundary } from './execution/types.js';

export interface NodeAcpLaunchOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  /** Only these variables are supplied. The current process environment is never inherited. */
  readonly env?: Readonly<Record<string, string>>;
  readonly shutdownTimeoutMs?: number;
}

export interface CreateNodeAcpProviderDriverOptions extends Omit<CreateAcpProviderDriverOptions, 'createConnection' | 'limits'> {
  readonly launch: NodeAcpLaunchOptions;
  readonly executionBoundary?: NodeAcpExecutionBoundary;
  /** Requires a direct native executable, exact no-leader arguments and a handler for each selected opening tuple. */
  readonly sessionInteractions?: Readonly<{ readonly mapping: 'grok-folder-trust-v1' | 'grok-build-1.0.60-session-requests-v1' }>;
  readonly limits?: Partial<AcpProviderLimits>;
}
