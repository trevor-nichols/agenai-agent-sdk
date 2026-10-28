import type { SandboxProcessReservation } from '@agen-ai/sandbox';
import type { SandboxApiKeyCredential } from '../credentials/index.js';

export type SandboxCodexCredential = SandboxApiKeyCredential | Readonly<{
  kind: 'auth_json';
  path: string;
  /** The caller has stopped every other consumer of this copied rotating lineage. */
  lineage: 'caller_quiescent';
  bootstrapExecutable: string;
  preparationTimeoutMs: number;
}>;

export interface SandboxCodexRequest {
  readonly guestExecutable: string;
  readonly credential: SandboxCodexCredential;
  /**
   * Cancels before reservation. An abort before the call rejects with its reason; one during the bounded host read
   * surfaces as the reader's content-free source error. Native cancellation belongs to `runSandboxCli`.
   */
  readonly signal?: AbortSignal;
}

export interface SandboxCodexPreflight {
  readonly provider: 'codex';
  readonly version: '0.163.0';
  readonly transport: 'native_cli_exec';
  readonly credentialRoute: 'api_key' | 'auth_json';
  readonly sourceKind: 'explicit_api_key' | 'explicit_native_auth_file';
  readonly nativeDestination: 'CODEX_API_KEY' | '/home/sandbox/.agenai-credentials/auth.json';
  readonly model: 'gpt-6-luna';
  readonly reasoning: 'low';
  readonly httpsDestinations: readonly string[];
  readonly endpointEvidence: 'observed_in_ms005_native_campaign';
  readonly nativeQualification: 'recorded_linux_x64_and_desktop_native_arm64';
  readonly preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration';
}

export interface SandboxCodexLaunch {
  readonly reservation: SandboxProcessReservation;
  readonly preflight: SandboxCodexPreflight;
}
