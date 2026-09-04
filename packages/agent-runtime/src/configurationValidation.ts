// ------------------------------------------------------------------------------------------------
//                configurationValidation.ts - Capability-bound session configuration validation - Dependencies: protocol, contract errors
// ------------------------------------------------------------------------------------------------

import type {
  AgentCapabilities,
  AgentSessionConfiguration,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "./contractErrors.js";

// ------------------------------------------------------------------------------------------------
//                Selectable Configuration Admission
// ------------------------------------------------------------------------------------------------

export function assertAgentSessionConfigurationSupported(
  capabilities: AgentCapabilities,
  configuration: AgentSessionConfiguration,
): void {
  if (capabilities.configuration.kind === "managed") {
    if (configuration.kind === "managed") return;
    throwAgentProviderContractError(
      capabilities.providerKey,
      "configuration_key_unsupported",
      "Managed providers require a managed session configuration.",
    );
  }
  if (
    configuration.kind !== "selected"
    || configuration.selections.length > capabilities.configuration.maxFields
  ) {
    throwAgentProviderContractError(
      capabilities.providerKey,
      "configuration_key_unsupported",
      "Selectable providers require a bounded selected session configuration.",
    );
  }
  for (const selection of configuration.selections) {
    if (!capabilities.configuration.fieldKinds.includes(selection.value.fieldKind)) {
      throwAgentProviderContractError(
        capabilities.providerKey,
        "configuration_value_unsupported",
        "Provider configuration contains a field kind outside its declared capability.",
      );
    }
  }
}
