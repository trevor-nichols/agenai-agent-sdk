// ------------------------------------------------------------------------------------------------
//                adapterValidation.ts - Adapter capability and open-operation enforcement - Dependencies: protocol, runtime validators
// ------------------------------------------------------------------------------------------------

import path from "node:path";

import {
  parseAgentCapabilities,
  parseAgentIsoDateTime,
  parseAgentSessionOpenInput,
  type AgentCapabilities,
} from "@agen-ai/agent-protocol";

import {
  assertAgentSessionConfigurationSupported,
} from "./configurationValidation.js";
import { throwAgentProviderContractError } from "./contractErrors.js";
import {
  parseAgentProviderTechnicalId,
  throwIfAgentOperationAborted,
} from "./foundation.js";
import { containsAgentControlCharacter } from "./internal/controlCharacters.js";
import {
  validateAgentProviderOperationResult,
  validateAgentProviderOutputForContext,
} from "./outputValidation.js";
import {
  closeRejectedAgentProviderSession,
  openIdentityCreatingAgentProviderSession,
  validateAgentProviderSession,
} from "./sessionValidation.js";
import type {
  AgentProviderAdapter,
  AgentProviderBranchSessionInput,
  AgentProviderCreateSessionInput,
  AgentProviderResumeSessionInput,
} from "./sessions.js";

//                Adapter Validation
// ------------------------------------------------------------------------------------------------

function parseWorkingDirectory(value: string): string {
  if (
    value.length < 1 ||
    value.length > 4_096 ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    containsAgentControlCharacter(value)
  ) {
    throw new TypeError(
      "Provider workingDirectory must be a canonical absolute path.",
    );
  }
  return value;
}

function assertAuthenticationOutputKind(
  providerKey: AgentCapabilities["providerKey"],
  output: ReturnType<typeof validateAgentProviderOutputForContext>,
): void {
  if (["authentication", "lifecycle", "evidence"].includes(output.kind)) {
    return;
  }
  throwAgentProviderContractError(
    providerKey,
    "output_capability_mismatch",
    "Authentication may emit only authentication, lifecycle, or evidence output.",
  );
}

export function validateAgentProviderAdapter(
  capabilityInput: AgentCapabilities,
  adapter: AgentProviderAdapter,
): AgentProviderAdapter {
  const capabilities = parseAgentCapabilities(capabilityInput);
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    typeof adapter.createSession !== "function" ||
    adapter.resumption === null ||
    typeof adapter.resumption !== "object" ||
    !["supported", "unsupported"].includes(adapter.resumption.kind) ||
    (adapter.resumption.kind === "supported" &&
      typeof adapter.resumption.resumeSession !== "function") ||
    adapter.branching === null ||
    typeof adapter.branching !== "object" ||
    !["through_turn", "unsupported"].includes(adapter.branching.kind) ||
    (adapter.branching.kind === "through_turn" &&
      typeof adapter.branching.branchSession !== "function") ||
    adapter.authentication === null ||
    typeof adapter.authentication !== "object" ||
    !["supported", "unsupported"].includes(adapter.authentication.kind) ||
    (adapter.authentication.kind === "supported" &&
      (typeof adapter.authentication.start !== "function" ||
        typeof adapter.authentication.cancel !== "function"))
  ) {
    throwAgentProviderContractError(
      capabilities.providerKey,
      "invalid_adapter",
      `Provider ${capabilities.providerKey} returned an incomplete adapter.`,
    );
  }
  if (
    (adapter.resumption.kind === "supported") !==
      capabilities.sessions.resume ||
    adapter.branching.kind !== capabilities.sessions.branch.kind ||
    adapter.authentication.kind !== capabilities.authentication.kind
  ) {
    throwAgentProviderContractError(
      capabilities.providerKey,
      "capability_port_mismatch",
      `Provider ${capabilities.providerKey} adapter ports do not match its capabilities.`,
    );
  }

  const declaredResumption = adapter.resumption;
  const resumption =
    declaredResumption.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          resumeSession: async (
            resumeInput: AgentProviderResumeSessionInput,
          ) => {
            throwIfAgentOperationAborted(resumeInput.signal);
            const parsed = parseAgentSessionOpenInput({
              operation: "resume",
              sessionId: resumeInput.sessionId,
              binding: resumeInput.binding,
              configuration: resumeInput.configuration,
            });
            if (parsed.operation !== "resume") {
              throw new TypeError("Expected a resume session input.");
            }
            assertAgentSessionConfigurationSupported(
              capabilities,
              parsed.configuration,
            );
            const workingDirectory = parseWorkingDirectory(
              resumeInput.workingDirectory,
            );
            const binding = parsed.binding;
            const candidate = await declaredResumption.resumeSession({
              sessionId: parsed.sessionId,
              workingDirectory,
              binding,
              configuration: parsed.configuration,
              ...(resumeInput.signal === undefined
                ? {}
                : { signal: resumeInput.signal }),
            });
            try {
              return validateAgentProviderSession({
                capabilities,
                sessionId: parsed.sessionId,
                candidate,
                expectedBinding: binding,
              });
            } catch (error) {
              return closeRejectedAgentProviderSession(candidate, error);
            }
          },
        });

  const declaredBranching = adapter.branching;
  const branching =
    declaredBranching.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "through_turn" as const,
          branchSession: async (
            branchInput: AgentProviderBranchSessionInput,
          ) => {
            throwIfAgentOperationAborted(branchInput.signal);
            const parsed = parseAgentSessionOpenInput({
              operation: "branch",
              sessionId: branchInput.sessionId,
              source: branchInput.source,
              configuration: branchInput.configuration,
            });
            if (parsed.operation !== "branch") {
              throw new TypeError("Expected a branch session input.");
            }
            assertAgentSessionConfigurationSupported(
              capabilities,
              parsed.configuration,
            );
            const workingDirectory = parseWorkingDirectory(
              branchInput.workingDirectory,
            );
            const sourceBinding = parsed.source.binding;
            return openIdentityCreatingAgentProviderSession({
              capabilities,
              sessionId: parsed.sessionId,
              observer: branchInput.onBindingCreated,
              sourceBinding,
              open: (observer) =>
                declaredBranching.branchSession({
                  sessionId: parsed.sessionId,
                  workingDirectory,
                  source: parsed.source,
                  configuration: parsed.configuration,
                  onBindingCreated: observer,
                  ...(branchInput.signal === undefined
                    ? {}
                    : { signal: branchInput.signal }),
                }),
            });
          },
        });

  const declaredAuthentication = adapter.authentication;
  const authenticationFlows = capabilities.authentication.kind === "supported"
    ? capabilities.authentication.flows
    : [];
  const authentication =
    declaredAuthentication.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          start: async function* (
            authInput: Parameters<typeof declaredAuthentication.start>[0],
          ) {
            throwIfAgentOperationAborted(authInput.signal);
            const attemptId = parseAgentProviderTechnicalId(
              authInput.attemptId,
              "authentication attemptId",
            );
            if (
              !authenticationFlows.includes(authInput.flow)
            ) {
              throwAgentProviderContractError(
                capabilities.providerKey,
                "input_capability_mismatch",
                "Agent authentication flow is not declared by provider capabilities.",
              );
            }
            const deadlineAt =
              authInput.deadlineAt === undefined
                ? undefined
                : parseAgentIsoDateTime(authInput.deadlineAt);
            for await (const candidate of declaredAuthentication.start({
              attemptId,
              flow: authInput.flow,
              ...(deadlineAt === undefined ? {} : { deadlineAt }),
              ...(authInput.signal === undefined
                ? {}
                : { signal: authInput.signal }),
            })) {
              const output = validateAgentProviderOutputForContext(candidate, {
                capabilities,
                providerKey: capabilities.providerKey,
                authenticationAttemptId: attemptId,
              });
              assertAuthenticationOutputKind(capabilities.providerKey, output);
              yield output;
            }
          },
          cancel: async (
            authInput: Parameters<typeof declaredAuthentication.cancel>[0],
          ) => {
            throwIfAgentOperationAborted(authInput.signal);
            const attemptId = parseAgentProviderTechnicalId(
              authInput.attemptId,
              "authentication attemptId",
            );
            const providerLoginId =
              authInput.providerLoginId === undefined
                ? undefined
                : parseAgentProviderTechnicalId(
                    authInput.providerLoginId,
                    "providerLoginId",
                  );
            if (
              authInput.reason !== undefined &&
              !["user_requested", "timeout", "shutdown", "other"].includes(
                authInput.reason,
              )
            ) {
              throw new TypeError(
                "Agent authentication cancel reason is unsupported.",
              );
            }
            const result = validateAgentProviderOperationResult(
              await declaredAuthentication.cancel({
                attemptId,
                ...(providerLoginId === undefined ? {} : { providerLoginId }),
                ...(authInput.reason === undefined
                  ? {}
                  : { reason: authInput.reason }),
                ...(authInput.signal === undefined
                  ? {}
                  : { signal: authInput.signal }),
              }),
              {
                capabilities,
                providerKey: capabilities.providerKey,
                authenticationAttemptId: attemptId,
              },
            );
            for (const output of result.outputs ?? []) {
              assertAuthenticationOutputKind(capabilities.providerKey, output);
            }
            return result;
          },
        });

  return Object.freeze({
    createSession: async (createInput: AgentProviderCreateSessionInput) => {
      throwIfAgentOperationAborted(createInput.signal);
      const parsed = parseAgentSessionOpenInput({
        operation: "create",
        sessionId: createInput.sessionId,
        configuration: createInput.configuration,
      });
      assertAgentSessionConfigurationSupported(
        capabilities,
        parsed.configuration,
      );
      const workingDirectory = parseWorkingDirectory(
        createInput.workingDirectory,
      );
      return openIdentityCreatingAgentProviderSession({
        capabilities,
        sessionId: parsed.sessionId,
        observer: createInput.onBindingCreated,
        open: (observer) =>
          adapter.createSession({
            sessionId: parsed.sessionId,
            workingDirectory,
            configuration: parsed.configuration,
            onBindingCreated: observer,
            ...(createInput.signal === undefined
              ? {}
              : { signal: createInput.signal }),
          }),
      });
    },
    resumption,
    branching,
    authentication,
  });
}
