// ------------------------------------------------------------------------------------------------
//                types.ts - Explicit credential source, process and offline preparation contracts
// ------------------------------------------------------------------------------------------------

import type { SandboxProcessInput } from '../../process/types.js';
import type { SANDBOX_CREDENTIAL_DIRECTORY, SANDBOX_CREDENTIAL_EXECUTABLE, SANDBOX_CREDENTIAL_PROTOCOL } from './protocol.js';

export interface SandboxCredentialFileReadOptions {
  readonly path: string;
  readonly signal?: AbortSignal;
}

export interface SandboxCredentialProcessInput {
  readonly bootstrapExecutable: string;
  readonly process: SandboxProcessInput;
  readonly file: Readonly<{ name: string; bytes: Uint8Array }>;
  readonly preparationTimeoutMs: number;
}

export interface SandboxCredentialBootstrapPreparationOptions {
  readonly directory: string;
}

export interface SandboxCredentialBootstrapPreparation {
  readonly protocol: typeof SANDBOX_CREDENTIAL_PROTOCOL;
  readonly guestDirectory: typeof SANDBOX_CREDENTIAL_DIRECTORY;
  readonly executableName: typeof SANDBOX_CREDENTIAL_EXECUTABLE;
  readonly directory: string;
  readonly sourceDigest: string;
  readonly files: readonly Readonly<{ path: string; sha256: string }>[];
}
