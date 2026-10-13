// ------------------------------------------------------------------------------------------------
//                binding.ts - Shared idempotent host ownership for runtime and resource cleanup
// ------------------------------------------------------------------------------------------------

import type { AgentSessionHostBinding } from "@agen-ai/agent-runtime";

export function ownedBinding(events: string[] = []) {
  let releases = 0;
  const binding: AgentSessionHostBinding = {
    bindingId: "execution-binding",
    tools: [{ name: "Inspect", description: "Inspect authorized task state.", inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {}, additionalProperties: false,
    } }],
    invoke() { return { kind: "success", value: {} }; },
    release() {
      if (releases > 0) return;
      releases += 1;
      events.push("binding_released");
    },
  };
  return { binding, releases: () => releases };
}

export const bindingSupport = {
  kind: "supported" as const, toolTransport: "callback" as const, instructionPlacements: ["developer" as const],
};
