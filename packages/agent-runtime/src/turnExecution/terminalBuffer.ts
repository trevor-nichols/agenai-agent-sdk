import type { AgentProviderKey } from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import type { AgentProviderOutput } from "../outputs.js";

const MAX_TRAILING_OUTPUTS = 32;
const MAX_RETAINED_BYTES = 16 * 1_024 * 1_024;

function retainedOutputBytes(output: AgentProviderOutput): number {
  if (output.kind === "artifact" && output.candidate.source.kind === "bytes") {
    const metadata = { ...output, candidate: { ...output.candidate, source: { kind: "bytes" } } };
    return output.candidate.source.bytes.byteLength + Buffer.byteLength(JSON.stringify(metadata), "utf8");
  }
  return Buffer.byteLength(JSON.stringify(output), "utf8");
}

/** Holds validated observations in native order until the terminal and its input ownership can publish. */
export function createAgentTurnTerminalBuffer(providerKey: AgentProviderKey, terminal: AgentProviderOutput) {
  const trailing: AgentProviderOutput[] = [];
  let retainedBytes = retainedOutputBytes(terminal);
  return {
    append(output: AgentProviderOutput): void {
      const bytes = retainedOutputBytes(output);
      if (trailing.length >= MAX_TRAILING_OUTPUTS || retainedBytes + bytes > MAX_RETAINED_BYTES) {
        throwAgentProviderContractError(providerKey, "invalid_operation_result",
          "Provider exceeded bounded terminal output capacity.");
      }
      trailing.push(output);
      retainedBytes += bytes;
    },
    take(): AgentProviderOutput | undefined { return trailing.shift(); },
    clear(): void { trailing.length = 0; retainedBytes = 0; },
  };
}
