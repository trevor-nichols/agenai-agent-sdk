// ------------------------------------------------------------------------------------------------
//                validation.ts - Environment port shape, scope, and lifecycle enforcement
// ------------------------------------------------------------------------------------------------

import path from "node:path";

import {
  AGENT_ENVIRONMENT_DOMAINS,
  parseAgentEnvironmentId,
  parseAgentEnvironmentInvalidation,
  parseAgentEnvironmentSnapshot,
  parseAgentSessionConfiguration,
  type AgentCapabilities,
  type AgentEnvironmentDomain,
  type AgentEnvironmentEvidenceExtent,
  type AgentEnvironmentId,
  type AgentEnvironmentInvalidation,
  type AgentEnvironmentReadCapability,
  type AgentEnvironmentSnapshot,
  type AgentProviderKey,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import {
  throwIfAgentOperationAborted,
  type MaybePromise,
} from "../foundation.js";
import { containsAgentControlCharacter } from "../internal/controlCharacters.js";
import type {
  AgentEnvironmentDiscoveryInput,
  AgentEnvironmentDiscoveryWatchInput,
  AgentEnvironmentDiscoveryPort,
  AgentEnvironmentObservationInput,
  AgentEnvironmentObservationWatchInput,
  AgentEnvironmentObservationPort,
} from "./types.js";

// ------------------------------------------------------------------------------------------------
//                Bounded Cleanup and Known Domains
// ------------------------------------------------------------------------------------------------

/** Maximum time allowed for a native watch iterator's return method to settle. */
export const AGENT_ENVIRONMENT_ITERATOR_CLEANUP_TIMEOUT_MS = 1_000;

type EnvironmentPortKind = "unsupported" | "read" | "read_and_watch";

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && actual.every((key) => typeof key === "string" && expected.includes(key))
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function exactKeysWithOptional(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  const allowed = [...required, ...optional];
  return actual.length >= required.length
    && actual.length <= allowed.length
    && actual.every((key) => typeof key === "string" && allowed.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function assertSignal(value: unknown, field: string): asserts value is AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw new TypeError(`Environment ${field} must be an AbortSignal.`);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The agent operation was aborted.", "AbortError");
}

function environmentContractError(
  providerKey: AgentProviderKey,
  detail: string,
): never {
  return throwAgentProviderContractError(
    providerKey,
    "capability_port_mismatch",
    `Provider ${providerKey} returned an invalid environment ${detail}.`,
  );
}

function invalidEnvironmentMetadata(
  providerKey: AgentProviderKey,
  detail: string,
): never {
  return throwAgentProviderContractError(
    providerKey,
    "invalid_inventory",
    `Provider ${providerKey} returned invalid environment metadata: ${detail}.`,
  );
}

function sameDomains(
  actual: readonly AgentEnvironmentDomain[],
  expected: readonly AgentEnvironmentDomain[],
): boolean {
  return actual.length === expected.length
    && actual.every((domain, index) => domain === expected[index]);
}

function parsePortDomains(
  providerKey: AgentProviderKey,
  value: unknown,
): readonly AgentEnvironmentDomain[] {
  if (!Array.isArray(value) || value.length < 1) {
    return environmentContractError(providerKey, "port domains");
  }
  const domains: AgentEnvironmentDomain[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "string"
      || !(AGENT_ENVIRONMENT_DOMAINS as readonly string[]).includes(candidate)
      || domains.includes(candidate as AgentEnvironmentDomain)
    ) {
      return environmentContractError(providerKey, "port domains");
    }
    domains.push(candidate as AgentEnvironmentDomain);
  }
  return Object.freeze(domains);
}

function validateDeclaredPort(
  providerKey: AgentProviderKey,
  capability: AgentEnvironmentReadCapability,
  candidate: unknown,
): EnvironmentPortKind {
  if (!isObject(candidate)) return environmentContractError(providerKey, "port");
  const kind = (candidate as { kind?: unknown }).kind;
  if (kind === "unsupported") {
    if (!exactKeys(candidate, ["kind"]) || capability.kind !== "unsupported") {
      return environmentContractError(providerKey, "port");
    }
    return "unsupported";
  }
  if (kind !== "read" && kind !== "read_and_watch") {
    return environmentContractError(providerKey, "port");
  }
  if (capability.kind === "unsupported" || capability.kind !== kind) {
    return environmentContractError(providerKey, "port capability parity");
  }
  const expectedKeys = kind === "read"
    ? ["kind", "domains", "readEnvironment"]
    : ["kind", "domains", "readEnvironment", "watchEnvironment"];
  if (!exactKeys(candidate, expectedKeys)) {
    return environmentContractError(providerKey, "port shape");
  }
  const domains = parsePortDomains(
    providerKey,
    (candidate as { domains?: unknown }).domains,
  );
  if (!sameDomains(domains, capability.domains)) {
    return environmentContractError(providerKey, "port capability domains");
  }
  if (
    typeof (candidate as { readEnvironment?: unknown }).readEnvironment !== "function"
    || (
      kind === "read_and_watch"
      && typeof (candidate as { watchEnvironment?: unknown }).watchEnvironment !== "function"
    )
  ) {
    return environmentContractError(providerKey, "port methods");
  }
  return kind;
}

function parseCanonicalWorkingDirectory(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_096
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || containsAgentControlCharacter(value)
  ) {
    throw new TypeError(
      "Environment workingDirectory must be a canonical absolute path.",
    );
  }
  return value;
}

function parseDiscoveryInput(
  input: unknown,
): AgentEnvironmentDiscoveryInput {
  if (!isObject(input) || !exactKeysWithOptional(input, [
    "signal",
    "environmentId",
    "workingDirectory",
    "configuration",
  ], ["onProviderExecutionStarted"])) {
    throw new TypeError(
      "Environment discovery input must contain signal, environmentId, workingDirectory, and configuration.",
    );
  }
  const candidate = input as Readonly<{
    signal?: unknown;
    environmentId?: unknown;
    workingDirectory?: unknown;
    configuration?: unknown;
    onProviderExecutionStarted?: unknown;
  }>;
  assertSignal(candidate.signal, "discovery signal");
  if (
    candidate.onProviderExecutionStarted !== undefined
    && typeof candidate.onProviderExecutionStarted !== "function"
  ) {
    throw new TypeError(
      "Environment discovery onProviderExecutionStarted must be callable.",
    );
  }
  return {
    signal: candidate.signal,
    environmentId: parseAgentEnvironmentId(candidate.environmentId),
    workingDirectory: parseCanonicalWorkingDirectory(candidate.workingDirectory),
    configuration: parseAgentSessionConfiguration(candidate.configuration),
    ...(candidate.onProviderExecutionStarted === undefined
      ? {}
      : {
          onProviderExecutionStarted:
            candidate.onProviderExecutionStarted as () => void,
        }),
  };
}

function parseDiscoveryWatchInput(
  input: unknown,
): AgentEnvironmentDiscoveryWatchInput {
  if (!isObject(input) || !exactKeys(input, [
    "signal",
    "environmentId",
    "workingDirectory",
    "configuration",
  ])) {
    throw new TypeError(
      "Environment discovery watch input must contain signal, environmentId, workingDirectory, and configuration.",
    );
  }
  const candidate = input as Readonly<{
    signal?: unknown;
    environmentId?: unknown;
    workingDirectory?: unknown;
    configuration?: unknown;
  }>;
  assertSignal(candidate.signal, "discovery watch signal");
  return {
    signal: candidate.signal,
    environmentId: parseAgentEnvironmentId(candidate.environmentId),
    workingDirectory: parseCanonicalWorkingDirectory(candidate.workingDirectory),
    configuration: parseAgentSessionConfiguration(candidate.configuration),
  };
}

function parseObservationInput(
  input: unknown,
): AgentEnvironmentObservationInput {
  if (!isObject(input) || !exactKeysWithOptional(
    input,
    ["signal", "environmentId"],
    ["onProviderExecutionStarted"],
  )) {
    throw new TypeError(
      "Environment observation input must contain signal and environmentId.",
    );
  }
  const candidate = input as Readonly<{
    signal?: unknown;
    environmentId?: unknown;
    onProviderExecutionStarted?: unknown;
  }>;
  assertSignal(candidate.signal, "observation signal");
  if (
    candidate.onProviderExecutionStarted !== undefined
    && typeof candidate.onProviderExecutionStarted !== "function"
  ) {
    throw new TypeError(
      "Environment observation onProviderExecutionStarted must be callable.",
    );
  }
  return {
    signal: candidate.signal,
    environmentId: parseAgentEnvironmentId(candidate.environmentId),
    ...(candidate.onProviderExecutionStarted === undefined
      ? {}
      : {
          onProviderExecutionStarted:
            candidate.onProviderExecutionStarted as () => void,
        }),
  };
}

function parseObservationWatchInput(
  input: unknown,
): AgentEnvironmentObservationWatchInput {
  if (!isObject(input) || !exactKeys(input, ["signal", "environmentId"])) {
    throw new TypeError(
      "Environment observation watch input must contain signal and environmentId.",
    );
  }
  const candidate = input as Readonly<{ signal?: unknown; environmentId?: unknown }>;
  assertSignal(candidate.signal, "observation watch signal");
  return {
    signal: candidate.signal,
    environmentId: parseAgentEnvironmentId(candidate.environmentId),
  };
}

function validateSnapshotDomains(
  providerKey: AgentProviderKey,
  snapshot: AgentEnvironmentSnapshot,
  declaredDomains: readonly AgentEnvironmentDomain[],
  maximumExtent: AgentEnvironmentEvidenceExtent,
): AgentEnvironmentSnapshot {
  for (const domain of AGENT_ENVIRONMENT_DOMAINS) {
    const result = snapshot[domain];
    if (maximumExtent === "workspace_discovery" && result.kind === "available"
      && result.extent === "session") {
      return invalidEnvironmentMetadata(providerKey,
        `instance discovery cannot claim session evidence for domain ${domain}`);
    }
    if (
      !declaredDomains.includes(domain)
      && result.kind === "available"
    ) {
      return invalidEnvironmentMetadata(
        providerKey,
        `domain ${domain} was marked available by an undeclared port domain`,
      );
    }
  }
  return snapshot;
}

function validateSnapshot(
  providerKey: AgentProviderKey,
  candidate: unknown,
  expectedEnvironmentId: AgentEnvironmentId,
  declaredDomains: readonly AgentEnvironmentDomain[],
  maximumExtent: AgentEnvironmentEvidenceExtent,
): AgentEnvironmentSnapshot {
  let snapshot: AgentEnvironmentSnapshot;
  try {
    snapshot = parseAgentEnvironmentSnapshot(candidate);
  } catch {
    return invalidEnvironmentMetadata(providerKey, "snapshot");
  }
  if (snapshot.environmentId !== expectedEnvironmentId) {
    return invalidEnvironmentMetadata(providerKey, "snapshot environmentId does not echo the request");
  }
  return validateSnapshotDomains(providerKey, snapshot, declaredDomains, maximumExtent);
}

function validateInvalidation(
  providerKey: AgentProviderKey,
  candidate: unknown,
  expectedEnvironmentId: AgentEnvironmentId,
  declaredDomains: readonly AgentEnvironmentDomain[],
): AgentEnvironmentInvalidation {
  let invalidation: AgentEnvironmentInvalidation;
  try {
    invalidation = parseAgentEnvironmentInvalidation(candidate);
  } catch {
    return invalidEnvironmentMetadata(providerKey, "invalidation");
  }
  if (invalidation.environmentId !== expectedEnvironmentId) {
    return invalidEnvironmentMetadata(providerKey, "invalidation environmentId does not echo the request");
  }
  if (invalidation.domains.some((domain) => !declaredDomains.includes(domain))) {
    return invalidEnvironmentMetadata(providerKey, "invalidation names an undeclared domain");
  }
  return invalidation;
}

function awaitCancellable(candidate: unknown, signal: AbortSignal): Promise<unknown> {
  const providerResult = Promise.resolve(candidate);
  return new Promise((resolve, reject) => {
    let settled = false;
    const remove = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      remove();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    providerResult.then(
      (value) => {
        if (settled) return;
        settled = true;
        remove();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        remove();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

interface ProviderIterator {
  readonly iterator: object;
  readonly next: (...args: never[]) => unknown;
  readonly returnMethod?: (...args: never[]) => unknown;
}

function providerIterator(
  providerKey: AgentProviderKey,
  iterable: unknown,
): ProviderIterator {
  if (!isObject(iterable)) return environmentContractError(providerKey, "watch result");
  const factory = (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  if (typeof factory !== "function") {
    return environmentContractError(providerKey, "watch iterator");
  }
  const iterator = factory.call(iterable);
  if (!isObject(iterator)) return environmentContractError(providerKey, "watch iterator");
  const next = (iterator as { next?: unknown }).next;
  if (typeof next !== "function") {
    return environmentContractError(providerKey, "watch iterator");
  }
  const returnMethod = (iterator as { return?: unknown }).return;
  if (returnMethod !== undefined && typeof returnMethod !== "function") {
    return environmentContractError(providerKey, "watch iterator");
  }
  return {
    iterator,
    next: next as (...args: never[]) => unknown,
    returnMethod: returnMethod as ((...args: never[]) => unknown) | undefined,
  };
}

function iteratorResult(value: unknown): value is IteratorResult<unknown> {
  if (!isObject(value)) return false;
  const done = (value as { done?: unknown }).done;
  return done === undefined || typeof done === "boolean";
}

function boundedCleanup(
  result: unknown,
  providerKey: AgentProviderKey,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `Provider ${providerKey} environment watch cleanup exceeded `
      + `${AGENT_ENVIRONMENT_ITERATOR_CLEANUP_TIMEOUT_MS}ms.`,
    )), AGENT_ENVIRONMENT_ITERATOR_CLEANUP_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve(result), timeout])
    .then(() => undefined)
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
}

interface IteratorState<Input extends {
  readonly signal: AbortSignal;
  readonly environmentId: AgentEnvironmentId;
}> {
  readonly providerKey: AgentProviderKey;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly declaredWatch: (input: Input) => AsyncIterable<AgentEnvironmentInvalidation>;
  readonly receiver: object;
  readonly watchInput: Input;
  readonly declaredDomains: readonly AgentEnvironmentDomain[];
  source?: ProviderIterator;
  cleanupPromise?: Promise<void>;
  closed: boolean;
  closedNormally: boolean;
  pendingNext: boolean;
}

function beginCleanup<Input extends {
  readonly signal: AbortSignal;
  readonly environmentId: AgentEnvironmentId;
}>(state: IteratorState<Input>): Promise<void> {
  if (state.cleanupPromise !== undefined) return state.cleanupPromise;
  const source = state.source;
  // A provider can synchronously abort while constructing its iterator. Defer caching cleanup
  // until that iterator has been captured so its return method still runs.
  if (source === undefined) return Promise.resolve();
  if (source.returnMethod === undefined) {
    state.cleanupPromise = Promise.resolve();
  } else {
    try {
      state.cleanupPromise = boundedCleanup(
        source.returnMethod.call(source.iterator),
        state.providerKey,
      );
    } catch (error) {
      state.cleanupPromise = Promise.reject(error);
    }
  }
  state.cleanupPromise.catch(() => undefined);
  return state.cleanupPromise;
}

function closeState<Input extends {
  readonly signal: AbortSignal;
  readonly environmentId: AgentEnvironmentId;
}>(state: IteratorState<Input>): void {
  if (state.closed) {
    void beginCleanup(state);
    return;
  }
  state.closed = true;
  state.signal.removeEventListener("abort", state.onAbort);
  if (!state.controller.signal.aborted) state.controller.abort();
  void beginCleanup(state);
}

function createWatchIterator<Input extends {
  readonly signal: AbortSignal;
  readonly environmentId: AgentEnvironmentId;
}>(
  providerKey: AgentProviderKey,
  declaredWatch: (input: Input) => AsyncIterable<AgentEnvironmentInvalidation>,
  receiver: object,
  lifetimeSignal: AbortSignal,
  watchInput: Input,
  declaredDomains: readonly AgentEnvironmentDomain[],
): AsyncIterator<AgentEnvironmentInvalidation> {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    lifetimeSignal,
    watchInput.signal,
    controller.signal,
  ]);
  const state: IteratorState<Input> = {
    providerKey,
    controller,
    signal,
    onAbort: () => closeState(state),
    declaredWatch,
    receiver,
    watchInput,
    declaredDomains,
    closed: false,
    closedNormally: false,
    pendingNext: false,
  };
  if (signal.aborted) closeState(state);
  else signal.addEventListener("abort", state.onAbort, { once: true });

  const source = (): ProviderIterator => {
    if (state.source !== undefined) return state.source;
    throwIfAgentOperationAborted(signal);
    const iterable = state.declaredWatch.call(state.receiver, {
      ...state.watchInput,
      signal,
    });
    state.source = providerIterator(providerKey, iterable);
    if (signal.aborted) closeState(state);
    return state.source;
  };

  const next = async (): Promise<IteratorResult<AgentEnvironmentInvalidation>> => {
    if (state.pendingNext) {
      throw new TypeError("Concurrent environment watch next calls are not supported.");
    }
    if (state.closed) {
      if (state.closedNormally || !signal.aborted) {
        return { done: true, value: undefined };
      }
      throwIfAgentOperationAborted(signal);
    }
    throwIfAgentOperationAborted(signal);
    state.pendingNext = true;
    try {
      const iterator = source();
      throwIfAgentOperationAborted(signal);
      const result = await awaitCancellable(
        iterator.next.call(iterator.iterator),
        signal,
      );
      throwIfAgentOperationAborted(signal);
      if (!iteratorResult(result)) {
        return environmentContractError(providerKey, "watch iterator result");
      }
      if (result.done === true) {
        state.closedNormally = true;
        closeState(state);
        await beginCleanup(state);
        return { done: true, value: undefined };
      }
      return {
        done: false,
        value: validateInvalidation(
          providerKey,
          result.value,
          state.watchInput.environmentId,
          state.declaredDomains,
        ),
      };
    } catch (error) {
      closeState(state);
      throw error;
    } finally {
      state.pendingNext = false;
    }
  };

  const returnIterator = async (
    value?: unknown,
  ): Promise<IteratorResult<AgentEnvironmentInvalidation>> => {
    state.closedNormally = true;
    state.controller.abort();
    closeState(state);
    await beginCleanup(state);
    return { done: true, value: value as AgentEnvironmentInvalidation };
  };

  return { next, return: returnIterator };
}

function wrapRead<
  Input extends AgentEnvironmentDiscoveryInput | AgentEnvironmentObservationInput,
>(input: {
  readonly providerKey: AgentProviderKey;
  readonly declaredRead: (
    value: Input,
  ) => MaybePromise<AgentEnvironmentSnapshot>;
  readonly receiver: object;
  readonly lifetimeSignal: AbortSignal;
  readonly parseInput: (value: unknown) => Input;
  readonly declaredDomains: readonly AgentEnvironmentDomain[];
  readonly maximumExtent: AgentEnvironmentEvidenceExtent;
}): (value: Input) => Promise<AgentEnvironmentSnapshot> {
  return async (rawInput: Input): Promise<AgentEnvironmentSnapshot> => {
    const parsedInput = input.parseInput(rawInput);
    const signal = AbortSignal.any([
      input.lifetimeSignal,
      parsedInput.signal,
    ]);
    throwIfAgentOperationAborted(signal);
    const {
      onProviderExecutionStarted,
      ...providerInput
    } = parsedInput;
    onProviderExecutionStarted?.();
    const candidate = input.declaredRead.call(input.receiver, {
      ...providerInput,
      signal,
    } as Input);
    const result = await awaitCancellable(candidate, signal);
    throwIfAgentOperationAborted(signal);
    return validateSnapshot(
      input.providerKey,
      result,
      parsedInput.environmentId,
      input.declaredDomains,
      input.maximumExtent,
    );
  };
}

function wrapWatch<Input extends {
  readonly signal: AbortSignal;
  readonly environmentId: AgentEnvironmentId;
}>(
  input: Readonly<{
    providerKey: AgentProviderKey;
    declaredWatch: (value: Input) => AsyncIterable<AgentEnvironmentInvalidation>;
    receiver: object;
    lifetimeSignal: AbortSignal;
    declaredDomains: readonly AgentEnvironmentDomain[];
    parseInput: (value: unknown) => Input;
  }>,
): (value: Input) => AsyncIterable<AgentEnvironmentInvalidation> {
  return (rawInput: Input) => {
    const parsedInput = input.parseInput(rawInput);
    return {
      [Symbol.asyncIterator]() {
        return createWatchIterator(
          input.providerKey,
          input.declaredWatch,
          input.receiver,
          input.lifetimeSignal,
          parsedInput,
          input.declaredDomains,
        );
      },
    };
  };
}

export function validateAgentEnvironmentDiscoveryPort(input: Readonly<{
  readonly providerKey: AgentProviderKey;
  readonly capability: AgentCapabilities["environment"]["instance"];
  readonly port: unknown;
  readonly signal: AbortSignal;
}>): AgentEnvironmentDiscoveryPort {
  assertSignal(input.signal, "instance signal");
  const kind = validateDeclaredPort(input.providerKey, input.capability, input.port);
  if (kind === "unsupported") return Object.freeze({ kind: "unsupported" });
  const declared = input.port as Extract<
    AgentEnvironmentDiscoveryPort,
    { kind: "read" | "read_and_watch" }
  >;
  const domains = Object.freeze([...declared.domains]);
  const readEnvironment = wrapRead({
    providerKey: input.providerKey,
    declaredRead: declared.readEnvironment,
    receiver: declared,
    lifetimeSignal: input.signal,
    parseInput: parseDiscoveryInput,
    declaredDomains: domains,
    maximumExtent: "workspace_discovery",
  });
  if (kind === "read") {
    return Object.freeze({ kind: "read", domains, readEnvironment });
  }
  const watchEnvironment = wrapWatch({
    providerKey: input.providerKey,
    declaredWatch: (
      declared as Extract<
        AgentEnvironmentDiscoveryPort,
        { kind: "read_and_watch" }
      >
    ).watchEnvironment,
    receiver: declared,
    lifetimeSignal: input.signal,
    declaredDomains: domains,
    parseInput: parseDiscoveryWatchInput,
  });
  return Object.freeze({
    kind: "read_and_watch",
    domains,
    readEnvironment,
    watchEnvironment,
  });
}

export function validateAgentEnvironmentObservationPort(input: Readonly<{
  readonly providerKey: AgentProviderKey;
  readonly capability: AgentCapabilities["environment"]["session"];
  readonly port: unknown;
  readonly signal: AbortSignal;
}>): AgentEnvironmentObservationPort {
  assertSignal(input.signal, "session signal");
  const kind = validateDeclaredPort(input.providerKey, input.capability, input.port);
  if (kind === "unsupported") return Object.freeze({ kind: "unsupported" });
  const declared = input.port as Extract<
    AgentEnvironmentObservationPort,
    { kind: "read" | "read_and_watch" }
  >;
  const domains = Object.freeze([...declared.domains]);
  const readEnvironment = wrapRead({
    providerKey: input.providerKey,
    declaredRead: declared.readEnvironment,
    receiver: declared,
    lifetimeSignal: input.signal,
    parseInput: parseObservationInput,
    declaredDomains: domains,
    maximumExtent: "session",
  });
  if (kind === "read") {
    return Object.freeze({ kind: "read", domains, readEnvironment });
  }
  const watchEnvironment = wrapWatch({
    providerKey: input.providerKey,
    declaredWatch: (
      declared as Extract<
        AgentEnvironmentObservationPort,
        { kind: "read_and_watch" }
      >
    ).watchEnvironment,
    receiver: declared,
    lifetimeSignal: input.signal,
    declaredDomains: domains,
    parseInput: parseObservationWatchInput,
  });
  return Object.freeze({
    kind: "read_and_watch",
    domains,
    readEnvironment,
    watchEnvironment,
  });
}
