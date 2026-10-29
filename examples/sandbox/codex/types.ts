import type { SandboxProcessReservation } from '@agen-ai/sandbox';
import type { SandboxApiKeyCredential } from '../credentials/index.js';

export type SandboxCodexCredential = SandboxApiKeyCredential | Readonly<{
  kind: 'auth_json';
  path: string;
  /** Quiescent copies own refresh; access-token-only copies use native externally managed auth. */
  lineage: 'caller_quiescent' | 'access_token_only';
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
  readonly refresh: 'not_applicable' | 'native_owned' | 'disabled';
  readonly endpointEvidence: 'observed_in_ms005_native_campaign' | 'pinned_native_source';
  readonly nativeQualification: 'recorded_linux_x64_and_desktop_native_arm64' | 'see_handoff_for_exact_route_and_platform_evidence';
  readonly preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration';
}

export interface SandboxCodexLaunch {
  readonly reservation: SandboxProcessReservation;
  readonly preflight: SandboxCodexPreflight;
}
