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
import { withAgentSessionHostBinding } from "./hostBindings/lifetime.js";
import { invokeAgentSessionOpening } from "./hostBindings/opening.js";
import { validateAgentSessionHostBindingSupport } from "./hostBindings/validation.js";
import { validateAgentExecutionInputSupport } from "./executionInput/validation.js";
import { createSessionInteractionOwner } from "./sessionInteractions/lifetime.js";
import { validateSessionInteractionSupport, validateNativeContinuationSupport } from "./sessionInteractions/validation.js";
import { admitAgentStructuredOutputOpening } from "./structuredOutput/admission.js";
import {
  validateAgentProviderOperationResult,
  validateAgentProviderOutputForContext,
} from "./outputValidation.js";
import {
  closeRejectedAgentProviderSession,
  openIdentityCreatingAgentProviderSession,
  validateAgentProviderSession,
  createAgentSessionValidationOwner,
} from "./sessionValidation.js";
import type {
  AgentProviderAdapter,
  AgentBranchSessionInput,
  AgentCreateSessionInput,
  AgentResumeSessionInput,
  AgentValidatedProviderAdapter,
} from "./sessions.js";

//                Adapter Validation
// ------------------------------------------------------------------------------------------------

const validatedAdapters = new WeakMap<object, AgentProviderAdapter>();
function isCandidateAdapter(adapter: AgentProviderAdapter | AgentValidatedProviderAdapter): adapter is AgentProviderAdapter {
  return !validatedAdapters.has(adapter);
}

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

export function validateAgentProviderAdapter(capabilities: AgentCapabilities, candidate: AgentProviderAdapter): AgentValidatedProviderAdapter;
export function validateAgentProviderAdapter(capabilities: AgentCapabilities, candidate: AgentValidatedProviderAdapter): AgentValidatedProviderAdapter;
export function validateAgentProviderAdapter(capabilities: AgentCapabilities, candidate: AgentProviderAdapter | AgentValidatedProviderAdapter): AgentValidatedProviderAdapter;
export function validateAgentProviderAdapter(
  capabilityInput: AgentCapabilities,
  adapterInput: AgentProviderAdapter | AgentValidatedProviderAdapter,
): AgentValidatedProviderAdapter {
  const capabilities = parseAgentCapabilities(capabilityInput);
  if (!isCandidateAdapter(adapterInput)) return validateAgentProviderAdapter(capabilities, validatedAdapters.get(adapterInput)!);
  const adapter = adapterInput;
  type OpeningInvocation = { owner?: import("./sessionInteractions/lifetime.js").SessionInteractionOwner };
  const returnedOpening = (promise: Promise<import("./sessions.js").AgentProviderSession>, opening: OpeningInvocation) => {
    void promise.then(() => { queueMicrotask(() => opening.owner?.markReturned()); }, () => {});
    return promise;
  };
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
  const sessionInteractions = validateSessionInteractionSupport(capabilities, adapter);
  const nativeContinuations = validateNativeContinuationSupport(capabilities, adapter, sessionInteractions);
  let executionInput: ReturnType<typeof validateAgentExecutionInputSupport>;
  try {
    executionInput = validateAgentExecutionInputSupport(adapter.executionInput);
  } catch {
    return throwAgentProviderContractError(capabilities.providerKey, "invalid_adapter",
      "Provider declared invalid execution-input support.");
  }
  let hostBinding: ReturnType<typeof validateAgentSessionHostBindingSupport>;
  try {
    hostBinding = validateAgentSessionHostBindingSupport(adapter.hostBinding);
  } catch {
    return throwAgentProviderContractError(
      capabilities.providerKey,
      "invalid_adapter",
      "Provider declared invalid session host binding support.",
    );
  }
  const resumption =
    declaredResumption.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "supported" as const,
          resumeSession: async (
            resumeInput: AgentResumeSessionInput,
            invocation: OpeningInvocation = {},
          ) => withAgentSessionHostBinding({
            providerKey: capabilities.providerKey,
            binding: resumeInput.hostBinding,
            openingInput: resumeInput,
            support: hostBinding,
            open: async (lease) => {
              throwIfAgentOperationAborted(resumeInput.signal);
              if (Reflect.has(resumeInput, "output")) {
                throwAgentProviderContractError(capabilities.providerKey, "structured_output_unsupported",
                  "Structured-output requests are unsupported when resuming a session.");
              }
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
              const validationOwner = createAgentSessionValidationOwner(capabilities, parsed.sessionId, undefined, executionInput);
              const interactions = createSessionInteractionOwner({ providerKey: capabilities.providerKey,
                sessionId: parsed.sessionId, operation: "resume", support: sessionInteractions, nativeSupport: nativeContinuations, validationOwner,
                ...(resumeInput.nativeContinuations === undefined ? {} : { continuations: resumeInput.nativeContinuations }),
                ...(resumeInput.interactions === undefined ? {} : { context: resumeInput.interactions }),
                ...(resumeInput.signal === undefined ? {} : { signal: resumeInput.signal }) });
              if (interactions) invocation.owner = interactions;
              interactions?.bind();
              const candidate = await invokeAgentSessionOpening({
                providerKey: capabilities.providerKey, openingInput: resumeInput, lease,
                ...(interactions === undefined ? {} : { interactions }),
                open: (context) => declaredResumption.resumeSession(context),
                candidateInput: {
                  sessionId: parsed.sessionId,
                  workingDirectory,
                  binding,
                  configuration: parsed.configuration,
                  ...(lease === undefined ? {} : { hostBinding: lease.binding }),
                  ...(interactions === undefined ? {} : { interactions: interactions.facade }),
                  ...((interactions?.openingSignal ?? resumeInput.signal) === undefined
                    ? {}
                    : { signal: interactions?.openingSignal ?? resumeInput.signal }),
                },
              });
              try {
                const session = validateAgentProviderSession({
                  capabilities,
                  validationOwner,
                  sessionId: parsed.sessionId,
                  candidate,
                  expectedBinding: binding,
                  ...(interactions === undefined ? {} : { sessionInteractionOwner: interactions }),
                  ...(lease === undefined ? {} : { hostBindingLease: lease }),
                });
                interactions?.adopt();
                return session;
              } catch (error) {
                return closeRejectedAgentProviderSession(candidate, error,
                  lease === undefined ? undefined : { providerKey: capabilities.providerKey, lease },
                  { providerKey: capabilities.providerKey, input: resumeInput }, interactions);
              }
            },
          }),
        });

  const declaredBranching = adapter.branching;
  const branching =
    declaredBranching.kind === "unsupported"
      ? Object.freeze({ kind: "unsupported" as const })
      : Object.freeze({
          kind: "through_turn" as const,
          branchSession: async (
            branchInput: AgentBranchSessionInput,
            invocation: OpeningInvocation = {},
          ) => withAgentSessionHostBinding({
            providerKey: capabilities.providerKey,
            binding: branchInput.hostBinding,
            openingInput: branchInput,
            support: hostBinding,
            open: async (lease) => {
              throwIfAgentOperationAborted(branchInput.signal);
              if (Reflect.has(branchInput, "output")) {
                throwAgentProviderContractError(capabilities.providerKey, "structured_output_unsupported",
                  "Structured-output requests are unsupported when branching a session.");
              }
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
              const validationOwner = createAgentSessionValidationOwner(capabilities, parsed.sessionId, undefined, executionInput);
              const interactions = createSessionInteractionOwner({ providerKey: capabilities.providerKey,
                sessionId: parsed.sessionId, operation: "branch", support: sessionInteractions, nativeSupport: nativeContinuations, validationOwner,
                ...(branchInput.nativeContinuations === undefined ? {} : { continuations: branchInput.nativeContinuations }),
                ...(branchInput.interactions === undefined ? {} : { context: branchInput.interactions }),
                ...(branchInput.signal === undefined ? {} : { signal: branchInput.signal }) });
              if (interactions) invocation.owner = interactions;
              return openIdentityCreatingAgentProviderSession({
                capabilities,
                  validationOwner,
                sessionId: parsed.sessionId,
                observer: branchInput.onBindingCreated,
                sourceBinding,
                openingInput: branchInput,
                ...(interactions === undefined ? {} : { sessionInteractionOwner: interactions }),
                ...(lease === undefined ? {} : { hostBindingLease: lease }),
                open: (observer) =>
                  invokeAgentSessionOpening({
                    providerKey: capabilities.providerKey, openingInput: branchInput, lease,
                    ...(interactions === undefined ? {} : { interactions }),
                    open: (context) => declaredBranching.branchSession(context),
                    candidateInput: {
                      sessionId: parsed.sessionId,
                      workingDirectory,
                      source: parsed.source,
                      configuration: parsed.configuration,
                      onBindingCreated: observer,
                      ...(lease === undefined ? {} : { hostBinding: lease.binding }),
                      ...(interactions === undefined ? {} : { interactions: interactions.facade }),
                      ...((interactions?.openingSignal ?? branchInput.signal) === undefined
                        ? {}
                        : { signal: interactions?.openingSignal ?? branchInput.signal }),
                    },
                  }),
              });
            },
          }),
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

  const createSession = async (createInput: AgentCreateSessionInput, invocation: OpeningInvocation = {}) => withAgentSessionHostBinding({
      providerKey: capabilities.providerKey,
      binding: createInput.hostBinding,
      openingInput: createInput,
      support: hostBinding,
      open: async (lease) => {
        throwIfAgentOperationAborted(createInput.signal);
        const parsed = parseAgentSessionOpenInput({
          operation: "create",
          sessionId: createInput.sessionId,
          configuration: createInput.configuration,
          ...(createInput.output === undefined ? {} : { output: createInput.output }),
        });
        assertAgentSessionConfigurationSupported(
          capabilities,
          parsed.configuration,
        );
        const workingDirectory = parseWorkingDirectory(
          createInput.workingDirectory,
        );
        const structuredOutputBinding = admitAgentStructuredOutputOpening({
          capabilities,
          operation: "create",
          output: parsed.operation === "create" ? parsed.output : undefined,
        });
        const validationOwner = createAgentSessionValidationOwner(capabilities, parsed.sessionId, structuredOutputBinding, executionInput);
              const interactions = createSessionInteractionOwner({ providerKey: capabilities.providerKey,
          sessionId: parsed.sessionId, operation: "create", support: sessionInteractions, nativeSupport: nativeContinuations, validationOwner,
                ...(createInput.nativeContinuations === undefined ? {} : { continuations: createInput.nativeContinuations }),
          ...(createInput.interactions === undefined ? {} : { context: createInput.interactions }),
          ...(createInput.signal === undefined ? {} : { signal: createInput.signal }) });
              if (interactions) invocation.owner = interactions;
        return openIdentityCreatingAgentProviderSession({
          capabilities,
                  validationOwner,
          sessionId: parsed.sessionId,
          observer: createInput.onBindingCreated,
          openingInput: createInput,
          ...(interactions === undefined ? {} : { sessionInteractionOwner: interactions }),
          ...(lease === undefined ? {} : { hostBindingLease: lease }),
          open: (observer) =>
            invokeAgentSessionOpening({
              providerKey: capabilities.providerKey, openingInput: createInput, lease,
              ...(interactions === undefined ? {} : { interactions }),
              open: (context) => adapter.createSession(context),
              candidateInput: {
                sessionId: parsed.sessionId,
                workingDirectory,
                configuration: parsed.configuration,
                ...(structuredOutputBinding === undefined ? {} : { output: structuredOutputBinding.request }),
                onBindingCreated: observer,
                ...(lease === undefined ? {} : { hostBinding: lease.binding }),
                ...(interactions === undefined ? {} : { interactions: interactions.facade }),
                ...((interactions?.openingSignal ?? createInput.signal) === undefined
                  ? {}
                  : { signal: interactions?.openingSignal ?? createInput.signal }),
              },
            }),
        });
      },
    });

  const openingAdapter: AgentValidatedProviderAdapter = Object.freeze({
    ...(executionInput === undefined ? {} : { executionInput }),
    hostBinding,
    sessionInteractions,
    nativeContinuations,
    createSession,
    resumption,
    branching,
    authentication,
  });
  const validated: AgentValidatedProviderAdapter = Object.freeze({ ...openingAdapter,
    createSession: (input: AgentCreateSessionInput) => { const invocation: OpeningInvocation = {}; return returnedOpening(createSession(input, invocation), invocation); },
    resumption: resumption.kind === "unsupported" ? resumption : Object.freeze({ kind: "supported", resumeSession: (input: AgentResumeSessionInput) => { const invocation: OpeningInvocation = {}; return returnedOpening(resumption.resumeSession(input, invocation), invocation); } }),
    branching: branching.kind === "unsupported" ? branching : Object.freeze({ kind: "through_turn", branchSession: (input: AgentBranchSessionInput) => { const invocation: OpeningInvocation = {}; return returnedOpening(branching.branchSession(input, invocation), invocation); } }),
  });
  validatedAdapters.set(validated, adapter);
  return validated;
}
