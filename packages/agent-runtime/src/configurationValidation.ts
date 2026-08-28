// ------------------------------------------------------------------------------------------------
//                configurationValidation.ts - Capability-bound session configuration validation - Dependencies: protocol, contract errors
// ------------------------------------------------------------------------------------------------

import type {
  AgentCapabilities,
  AgentSessionConfiguration,
} from "@agenai/agent-protocol";

import { throwAgentProviderContractError } from "./contractErrors.js";

// ------------------------------------------------------------------------------------------------
//                Selectable Configuration Admission
// ------------------------------------------------------------------------------------------------

export function assertAgentSessionConfigurationSupported(
  capabilities: AgentCapabilities,
  configuration: AgentSessionConfiguration,
): void {
  const entries = Object.entries(configuration.values);
  if (capabilities.configuration.kind === "managed") {
    if (entries.length === 0) return;
    throwAgentProviderContractError(
      capabilities.providerKey,
      "configuration_key_unsupported",
      "Managed provider configuration values must be empty.",
    );
  }

  const fields = new Map(
    capabilities.configuration.fields.map((field) => [field.key, field]),
  );
  for (const [key, value] of entries) {
    const field = fields.get(key);
    if (!field) {
      throwAgentProviderContractError(
        capabilities.providerKey,
        "configuration_key_unsupported",
        "Provider configuration contains a key not declared by its capabilities.",
      );
    }
    if (typeof value !== "string" || !field.optionIds.includes(value)) {
      throwAgentProviderContractError(
        capabilities.providerKey,
        "configuration_value_unsupported",
        "Provider configuration contains an option not declared by its capabilities.",
      );
    }
  }
}
