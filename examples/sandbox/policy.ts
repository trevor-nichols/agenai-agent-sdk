// ------------------------------------------------------------------------------------------------
//                policy.ts - Explicit finite smoke-run policy
// ------------------------------------------------------------------------------------------------

import {
  parseSandboxRequest,
  SANDBOX_DEFAULT_STREAM_LIMITS,
  SANDBOX_DEFAULT_TRANSFER_BUFFERS,
} from "@agen-ai/sandbox";

export function isolatedSandboxRequest() {
  return parseSandboxRequest({ policy: {
    resources: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 256 },
    temporaryStorage: { homeBytes: 16 * 1024 ** 2, tempBytes: 16 * 1024 ** 2 },
    network: { kind: "isolated" },
    execution: { kind: "deadline", timeoutMs: 60_000 },
    deadlines: { startupMs: 60_000, cleanupMs: 30_000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS,
    streams: SANDBOX_DEFAULT_STREAM_LIMITS,
  } });
}
