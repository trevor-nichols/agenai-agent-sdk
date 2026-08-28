// ------------------------------------------------------------------------------------------------
//                evidence.ts - Bounded redacted provider data - Dependencies: agent protocol
// ------------------------------------------------------------------------------------------------

import { isDeepStrictEqual } from "node:util";

import {
  AGENT_PROTOCOL_JSON_BYTES_LIMIT,
  AGENT_PROTOCOL_JSON_KEY_MAX_LENGTH,
  agentProtocolSerializedJsonBytes,
  parseAgentJsonValue,
  type AgentJsonValue,
} from "@agen-ai/agent-protocol";

import { parseAgentBoundedText } from "./foundation.js";
import { containsAgentControlCharacter } from "./internal/controlCharacters.js";
import { serializedAgentJsonValueBytes } from "./internal/serializedJsonBytes.js";

// ------------------------------------------------------------------------------------------------
//                Bounds and Contracts
// ------------------------------------------------------------------------------------------------

export const AGENT_PROVIDER_EVIDENCE_BYTES_LIMIT = 24_576;
export const AGENT_PROVIDER_REQUEST_CONTEXT_BYTES_LIMIT = 16_384;
export const AGENT_PROVIDER_DATA_BYTES_LIMIT_MAX =
  AGENT_PROTOCOL_JSON_BYTES_LIMIT;

const AGENT_PROVIDER_DATA_DEPTH_LIMIT = 8;
const AGENT_PROVIDER_DATA_COLLECTION_LIMIT = 100;
const AGENT_PROVIDER_DATA_REDACTION_REPLACEMENT = "[REDACTED]";
const AGENT_PROVIDER_DATA_PROTOTYPE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|private[_-]?key|credential|authorization|api[_-]?key/iu;

export type AgentProviderDataTruncationReason =
  | "byte_limit_exceeded"
  | "structural_limit_exceeded"
  | "byte_and_structural_limits_exceeded";

interface BoundedAgentProviderDataBase {
  readonly data: AgentJsonValue;
  readonly dataBytes: number;
  readonly redacted: true;
}

interface AgentProviderDataNormalizationState {
  structurallyTruncated: boolean;
}

interface NormalizedAgentProviderData {
  readonly data: AgentJsonValue;
  readonly structurallyTruncated: boolean;
}

export type BoundedAgentProviderData = BoundedAgentProviderDataBase &
  Readonly<
    | {
        originalDataBytes: number;
        truncated: false;
        truncationReason: null;
      }
    | {
        originalDataBytes: number;
        truncated: true;
        truncationReason: "byte_limit_exceeded";
      }
    | {
        originalDataBytes: null;
        truncated: true;
        truncationReason:
          | "structural_limit_exceeded"
          | "byte_and_structural_limits_exceeded";
      }
  >;

export type AgentProviderEvidenceCategory =
  | "provider_event"
  | "provider_request"
  | "diagnostic";

export type AgentProviderEvidence = BoundedAgentProviderData & Readonly<{
  readonly category: AgentProviderEvidenceCategory;
  readonly source: string;
}>;

export type AgentProviderRequestContext = BoundedAgentProviderData & Readonly<{
  readonly truncated: false;
  readonly truncationReason: null;
  readonly originalDataBytes: number;
}>;

export interface CreateAgentProviderEvidenceInput<
  Category extends AgentProviderEvidenceCategory = AgentProviderEvidenceCategory,
> {
  readonly category: Category;
  readonly source: string;
  readonly data: unknown;
  readonly bytesLimit?: number;
}

// ------------------------------------------------------------------------------------------------
//                Redaction and JSON Normalization
// ------------------------------------------------------------------------------------------------

function isPortableAgentProviderDataKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= AGENT_PROTOCOL_JSON_KEY_MAX_LENGTH &&
    !AGENT_PROVIDER_DATA_PROTOTYPE_KEYS.has(key)
  );
}

function normalizedObjectKey(
  key: string,
  index: number,
  preservedKeys: ReadonlySet<string>,
  usedKeys: ReadonlySet<string>,
): Readonly<{ key: string; rewritten: boolean }> {
  if (isPortableAgentProviderDataKey(key) && !usedKeys.has(key)) {
    return { key, rewritten: false };
  }

  let collision = 0;
  let candidate: string;
  do {
    candidate = `truncated_key_${index}${collision === 0 ? "" : `_${collision}`}`;
    collision += 1;
  } while (preservedKeys.has(candidate) || usedKeys.has(candidate));

  return { key: candidate, rewritten: true };
}

function normalizedProviderValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
  truncation: AgentProviderDataNormalizationState,
): AgentJsonValue {
  if (depth > AGENT_PROVIDER_DATA_DEPTH_LIMIT) {
    truncation.structurallyTruncated = true;
    return "[MaxDepth]";
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    truncation.structurallyTruncated = true;
    return "[NonFiniteNumber]";
  }
  if (typeof value !== "object") {
    truncation.structurallyTruncated = true;
    return `[Unsupported:${typeof value}]`;
  }
  if (ancestors.has(value)) {
    truncation.structurallyTruncated = true;
    return "[Circular]";
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > AGENT_PROVIDER_DATA_COLLECTION_LIMIT) {
        truncation.structurallyTruncated = true;
      }
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable !== true) continue;
        const index = typeof key === "string" ? Number(key) : Number.NaN;
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          String(index) !== key ||
          index >= value.length
        ) {
          truncation.structurallyTruncated = true;
        }
      }
      const normalized: AgentJsonValue[] = [];
      const length = Math.min(
        value.length,
        AGENT_PROVIDER_DATA_COLLECTION_LIMIT,
      );
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor) {
          normalized.push(null);
        } else if (!("value" in descriptor)) {
          truncation.structurallyTruncated = true;
          normalized.push("[Accessor]");
        } else {
          normalized.push(
            normalizedProviderValue(
              descriptor.value,
              ancestors,
              depth + 1,
              truncation,
            ),
          );
        }
      }
      return normalized;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      truncation.structurallyTruncated = true;
      const constructorDescriptor = Object.getOwnPropertyDescriptor(
        prototype,
        "constructor",
      );
      const constructorName =
        constructorDescriptor &&
        "value" in constructorDescriptor &&
        typeof constructorDescriptor.value === "function"
          ? constructorDescriptor.value.name || "Object"
          : "Object";
      return `[Unsupported:${constructorName}]`;
    }

    const normalized: Record<string, AgentJsonValue> = Object.create(null);
    const keys: string[] = [];
    let enumerablePropertyCount = 0;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) continue;
      enumerablePropertyCount += 1;
      if (typeof key === "string") {
        keys.push(key);
      } else {
        truncation.structurallyTruncated = true;
      }
    }
    if (enumerablePropertyCount > AGENT_PROVIDER_DATA_COLLECTION_LIMIT) {
      truncation.structurallyTruncated = true;
    }
    const selectedKeys = keys.slice(0, AGENT_PROVIDER_DATA_COLLECTION_LIMIT);
    const preservedKeys = new Set(
      selectedKeys.filter(isPortableAgentProviderDataKey),
    );
    const usedKeys = new Set<string>();
    selectedKeys.forEach((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return;
      const normalizedKey = normalizedObjectKey(
        key,
        index,
        preservedKeys,
        usedKeys,
      );
      usedKeys.add(normalizedKey.key);
      if (normalizedKey.rewritten) truncation.structurallyTruncated = true;
      if (!("value" in descriptor)) {
        truncation.structurallyTruncated = true;
        normalized[normalizedKey.key] = "[Accessor]";
        return;
      }
      normalized[normalizedKey.key] = SENSITIVE_KEY_PATTERN.test(key)
        ? AGENT_PROVIDER_DATA_REDACTION_REPLACEMENT
        : normalizedProviderValue(
            descriptor.value,
            ancestors,
            depth + 1,
            truncation,
          );
    });
    return normalized;
  } catch {
    truncation.structurallyTruncated = true;
    return "[Uninspectable]";
  } finally {
    ancestors.delete(value);
  }
}

function normalizeAgentProviderData(value: unknown): NormalizedAgentProviderData {
  const truncation: AgentProviderDataNormalizationState = {
    structurallyTruncated: false,
  };
  return {
    data: normalizedProviderValue(
      value,
      new WeakSet<object>(),
      0,
      truncation,
    ),
    structurallyTruncated: truncation.structurallyTruncated,
  };
}

function validatedBytesLimit(limit: number): number {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 256 ||
    limit > AGENT_PROVIDER_DATA_BYTES_LIMIT_MAX
  ) {
    throw new RangeError(
      `Provider data byte limits must be an integer from 256 through ${AGENT_PROVIDER_DATA_BYTES_LIMIT_MAX}.`,
    );
  }
  return limit;
}

export function redactAgentProviderData(value: unknown): AgentJsonValue {
  return parseAgentJsonValue(normalizeAgentProviderData(value).data);
}

export function createBoundedAgentProviderData(
  value: unknown,
  bytesLimit = AGENT_PROVIDER_EVIDENCE_BYTES_LIMIT,
): BoundedAgentProviderData {
  const validatedLimit = validatedBytesLimit(bytesLimit);
  const normalized = normalizeAgentProviderData(value);
  const normalizedDataBytes = serializedAgentJsonValueBytes(normalized.data);
  if (normalizedDataBytes <= validatedLimit) {
    const data = parseAgentJsonValue(normalized.data);
    if (normalized.structurallyTruncated) {
      return Object.freeze({
        data,
        dataBytes: normalizedDataBytes,
        originalDataBytes: null,
        truncated: true,
        truncationReason: "structural_limit_exceeded",
        redacted: true as const,
      });
    }
    return Object.freeze({
      data,
      dataBytes: normalizedDataBytes,
      originalDataBytes: normalizedDataBytes,
      truncated: false,
      truncationReason: null,
      redacted: true as const,
    });
  }

  if (normalized.structurallyTruncated) {
    const truncatedData = parseAgentJsonValue({
      truncated: true,
      reason: "byte_and_structural_limits_exceeded",
      originalDataBytes: null,
    });
    return Object.freeze({
      data: truncatedData,
      dataBytes: agentProtocolSerializedJsonBytes(truncatedData),
      originalDataBytes: null,
      truncated: true,
      truncationReason: "byte_and_structural_limits_exceeded",
      redacted: true as const,
    });
  }
  const truncatedData = parseAgentJsonValue({
    truncated: true,
    reason: "byte_limit_exceeded",
    originalDataBytes: normalizedDataBytes,
  });
  return Object.freeze({
    data: truncatedData,
    dataBytes: agentProtocolSerializedJsonBytes(truncatedData),
    originalDataBytes: normalizedDataBytes,
    truncated: true,
    truncationReason: "byte_limit_exceeded",
    redacted: true as const,
  });
}

export function validateBoundedAgentProviderData(
  input: BoundedAgentProviderData,
): BoundedAgentProviderData {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.dataBytes !== "number" ||
    typeof input.truncated !== "boolean" ||
    input.redacted !== true
  ) {
    throw new TypeError("Bounded provider data is invalid.");
  }
  const data = parseAgentJsonValue(input.data);
  if (!isDeepStrictEqual(data, redactAgentProviderData(data))) {
    throw new TypeError(
      "Bounded provider data must be canonically normalized and redacted.",
    );
  }
  const dataBytes = agentProtocolSerializedJsonBytes(data);
  if (input.dataBytes !== dataBytes) {
    throw new TypeError("Bounded provider data byte accounting is invalid.");
  }
  if (!input.truncated) {
    if (
      input.truncationReason !== null ||
      !Number.isSafeInteger(input.originalDataBytes) ||
      input.originalDataBytes !== dataBytes
    ) {
      throw new TypeError("Bounded provider data byte accounting is invalid.");
    }
    return Object.freeze({
      data,
      dataBytes,
      originalDataBytes: input.originalDataBytes,
      truncated: false,
      truncationReason: null,
      redacted: true as const,
    });
  }
  switch (input.truncationReason) {
    case "byte_limit_exceeded":
      if (
        !Number.isSafeInteger(input.originalDataBytes) ||
        input.originalDataBytes <= dataBytes
      ) {
        throw new TypeError("Bounded provider data byte accounting is invalid.");
      }
      return Object.freeze({
        data,
        dataBytes,
        originalDataBytes: input.originalDataBytes,
        truncated: true,
        truncationReason: input.truncationReason,
        redacted: true as const,
      });
    case "structural_limit_exceeded":
    case "byte_and_structural_limits_exceeded":
      if (input.originalDataBytes !== null) {
        throw new TypeError(
          "Bounded provider data truncation metadata is invalid.",
        );
      }
      return Object.freeze({
        data,
        dataBytes,
        originalDataBytes: null,
        truncated: true,
        truncationReason: input.truncationReason,
        redacted: true as const,
      });
    default:
      throw new TypeError(
        "Bounded provider data truncation metadata is invalid.",
      );
  }
}

export function createAgentProviderRequestContext(
  value: unknown,
): AgentProviderRequestContext {
  const canonical = parseAgentJsonValue(value);
  const bounded = createBoundedAgentProviderData(
    canonical,
    AGENT_PROVIDER_REQUEST_CONTEXT_BYTES_LIMIT,
  );
  if (bounded.truncated) {
    throw new RangeError(
      "Provider request context exceeds its transport byte limit.",
    );
  }
  if (!isDeepStrictEqual(bounded.data, canonical)) {
    throw new TypeError(
      "Provider request context must be JSON-safe and require no redaction or structural truncation.",
    );
  }
  return bounded;
}

export function validateAgentProviderRequestContext(
  input: AgentProviderRequestContext,
): AgentProviderRequestContext {
  const bounded = validateBoundedAgentProviderData(input);
  if (bounded.truncated) {
    throw new TypeError("Provider request context cannot be truncated.");
  }
  return createAgentProviderRequestContext(bounded.data);
}

// ------------------------------------------------------------------------------------------------
//                Evidence Construction
// ------------------------------------------------------------------------------------------------

function parseEvidenceSource(value: unknown): string {
  const source = parseAgentBoundedText(value, "Provider evidence source", 160);
  if (
    source !== source.trim() ||
    containsAgentControlCharacter(source)
  ) {
    throw new TypeError(
      "Provider evidence source must be a canonical bounded string.",
    );
  }
  return source;
}

export function createAgentProviderEvidence<
  Category extends AgentProviderEvidenceCategory,
>(
  input: CreateAgentProviderEvidenceInput<Category>,
): AgentProviderEvidence & Readonly<{ category: Category }> {
  const bounded = createBoundedAgentProviderData(
    input.data,
    input.bytesLimit,
  );
  return Object.freeze({
    category: input.category,
    source: parseEvidenceSource(input.source),
    ...bounded,
  });
}

export function validateAgentProviderEvidence(
  input: AgentProviderEvidence,
): AgentProviderEvidence {
  if (
    input === null ||
    typeof input !== "object" ||
    !["provider_event", "provider_request", "diagnostic"].includes(
      input.category,
    )
  ) {
    throw new TypeError("Provider evidence is invalid.");
  }
  return Object.freeze({
    category: input.category,
    source: parseEvidenceSource(input.source),
    ...validateBoundedAgentProviderData(input),
  });
}
