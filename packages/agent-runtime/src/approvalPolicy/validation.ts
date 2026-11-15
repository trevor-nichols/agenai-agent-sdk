import type { AgentProviderKey } from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";
import type {
  AgentApprovalPolicy,
  AgentApprovalPolicyDescriptor,
  AgentApprovalPolicyKind,
  AgentApprovalPolicyOperation,
  AgentApprovalPolicySupport,
  AgentSessionApprovalPolicy,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("Expected an approval-policy object.");
  }
  return value;
}

function policyKind(value: unknown): AgentApprovalPolicyKind {
  if (value === "host" || value === "provider_accept_edits" || value === "provider_auto_review" || value === "provider_bypass") return value;
  throw new TypeError("Unknown approval policy.");
}

function operation(value: unknown): AgentApprovalPolicyOperation {
  if (value === "create" || value === "resume" || value === "branch") return value;
  throw new TypeError("Unknown approval-policy opening operation.");
}

function nonemptyUnique<Value>(value: unknown, maximum: number, parse: (entry: unknown) => Value): readonly [Value, ...Value[]] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new TypeError("Approval-policy declarations require a nonempty bounded list.");
  }
  const [first, ...rest] = value;
  const entries: [Value, ...Value[]] = [parse(first), ...rest.map(parse)];
  if (new Set(entries).size !== entries.length) throw new TypeError("Duplicate approval-policy declaration.");
  return Object.freeze(entries);
}

function parsePolicy(value: unknown): AgentApprovalPolicy {
  const input = record(value);
  if (!hasExactOwnKeys(input, ["kind"])) throw new TypeError("Invalid approval policy.");
  return Object.freeze({ kind: policyKind(input.kind) });
}

export function validateAgentApprovalPolicySupport(
  value: unknown,
  availableOperations: readonly AgentApprovalPolicyOperation[],
): AgentApprovalPolicySupport | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (input.kind === "unsupported" && hasExactOwnKeys(input, ["kind"])) {
    return Object.freeze({ kind: "unsupported" });
  }
  if (input.kind !== "supported" || !hasExactOwnKeys(input, ["kind", "policies"])) {
    throw new TypeError("Invalid approval-policy support.");
  }
  const policies = nonemptyUnique(input.policies, 4, (value): AgentApprovalPolicyDescriptor => {
    const descriptor = record(value);
    if (!hasExactOwnKeys(descriptor, ["policy", "operations"])) {
      throw new TypeError("Invalid approval-policy descriptor.");
    }
    const operations = nonemptyUnique(descriptor.operations, 3, operation);
    if (operations.some((entry) => !availableOperations.includes(entry))) {
      throw new TypeError("Approval-policy support requires an available opening operation.");
    }
    return Object.freeze({ policy: policyKind(descriptor.policy), operations });
  });
  if (new Set(policies.map((entry) => entry.policy)).size !== policies.length) {
    throw new TypeError("Duplicate approval policy.");
  }
  return Object.freeze({ kind: "supported", policies });
}

export function parseAgentApprovalPolicySelection(
  providerKey: AgentProviderKey,
  selection: unknown,
): AgentApprovalPolicy | undefined {
  if (selection === undefined) return undefined;
  try {
    return parsePolicy(selection);
  } catch {
    return throwAgentProviderContractError(providerKey, "approval_policy_invalid",
      "The requested approval policy is invalid.");
  }
}

export function admitAgentApprovalPolicy(input: Readonly<{
  providerKey: AgentProviderKey;
  selection: unknown;
  support: AgentApprovalPolicySupport | undefined;
  operation: AgentApprovalPolicyOperation;
}>): AgentApprovalPolicy | undefined {
  const policy = parseAgentApprovalPolicySelection(input.providerKey, input.selection);
  if (policy === undefined) return undefined;
  if (input.support?.kind !== "supported" || !input.support.policies.some(
    (entry) => entry.policy === policy.kind && entry.operations.includes(input.operation),
  )) {
    return throwAgentProviderContractError(input.providerKey, "approval_policy_unsupported",
      "The requested approval policy is unsupported for this session opening operation.");
  }
  return policy;
}

export function validateAgentSessionApprovalPolicy(input: Readonly<{
  providerKey: AgentProviderKey;
  requested: AgentApprovalPolicy | undefined;
  session: object;
}>): AgentSessionApprovalPolicy | undefined {
  let result: AgentSessionApprovalPolicy;
  try {
    if (input.requested === undefined && !Reflect.has(input.session, "approvalPolicy")) return undefined;
    const session = record(input.session);
    if (input.requested === undefined || !Object.hasOwn(session, "approvalPolicy")) {
      throw new TypeError("Unconfirmed approval policy.");
    }
    const candidate = record(session.approvalPolicy);
    const verification = candidate.verification;
    if (!hasExactOwnKeys(candidate, ["policy", "verification"])
      || (verification !== "native_observation" && verification !== "controlled_configuration")) {
      throw new TypeError("Unconfirmed approval policy.");
    }
    result = Object.freeze({ policy: parsePolicy(candidate.policy), verification });
  } catch {
    return throwAgentProviderContractError(input.providerKey, "approval_policy_unconfirmed",
      "Provider did not establish a valid effective approval policy for the explicit selection.");
  }
  if (result.policy.kind !== input.requested?.kind) {
    return throwAgentProviderContractError(input.providerKey, "approval_policy_mismatch",
      "Provider established a different approval policy than requested.");
  }
  return result;
}
