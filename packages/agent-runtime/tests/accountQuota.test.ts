// ------------------------------------------------------------------------------------------------
//                accountQuota.test.ts - Account quota port conformance
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import {
  parseAgentIsoDateTime,
  parseAgentProviderKey,
  type AgentAccountQuotaSnapshot,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  validateAgentAccountQuotaPort,
} from "../src/index.js";

const providerKey = parseAgentProviderKey("quota-test-provider");
const observedAt = parseAgentIsoDateTime("2026-09-07T12:00:00.000Z");
const snapshot: AgentAccountQuotaSnapshot = {
  schemaVersion: 1,
  sourceId: "synthetic-source",
  observedAt,
  state: "available",
  completeness: "complete",
  windows: [],
  allowance: {
    included: "unknown",
    extra: "unknown",
    reserve: "unknown",
  },
};

function validationInput(
  port: unknown,
  signal = new AbortController().signal,
) {
  return { providerKey, port, signal };
}

function assertPortMismatch(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof AgentProviderContractError
      && error.code === "capability_port_mismatch",
  );
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("quota port validation requires an exact capability shape", () => {
  const unsupported = validateAgentAccountQuotaPort(
    validationInput({ kind: "unsupported" }),
  );
  assert.deepEqual(unsupported, { kind: "unsupported" });
  assert.equal(Object.isFrozen(unsupported), true);

  const validQuery = {
    kind: "query" as const,
    query: () => snapshot,
  };
  const validObserve = {
    kind: "observe" as const,
    observe: () => ({
      async *[Symbol.asyncIterator]() {
        yield snapshot;
      },
    }),
  };
  const validBoth = {
    kind: "query_and_observe" as const,
    query: () => snapshot,
    observe: validObserve.observe,
  };
  assert.equal(validateAgentAccountQuotaPort(validationInput(validQuery)).kind, "query");
  assert.equal(validateAgentAccountQuotaPort(validationInput(validObserve)).kind, "observe");
  assert.equal(validateAgentAccountQuotaPort(validationInput(validBoth)).kind, "query_and_observe");

  for (const malformed of [
    null,
    { kind: "unsupported", query: () => snapshot },
    { kind: "query" },
    { kind: "query", query: () => snapshot, observe: () => ({}) },
    { kind: "observe", observe: () => ({}), query: () => snapshot },
    { kind: "query_and_observe", query: () => snapshot },
    { kind: "query_and_observe", query: () => snapshot, observe: undefined },
    { kind: "other", query: () => snapshot },
  ]) {
    assertPortMismatch(() => validateAgentAccountQuotaPort(validationInput(malformed)));
  }
});

test("query preserves provider this, parses snapshots, and passes a combined signal", async () => {
  const lifetimeController = new AbortController();
  const operationController = new AbortController();
  let calls = 0;
  let receivedSignal: AbortSignal | undefined;
  const port: {
    kind: "query";
    query(this: unknown, input: { signal: AbortSignal }): AgentAccountQuotaSnapshot;
  } = {
    kind: "query",
    query(this: unknown, input: { signal: AbortSignal }) {
      assert.equal(this, port);
      calls += 1;
      receivedSignal = input.signal;
      return snapshot;
    },
  };
  const validated = validateAgentAccountQuotaPort({
    providerKey,
    port,
    signal: lifetimeController.signal,
  });
  assert.equal(validated.kind, "query");
  if (validated.kind !== "query") throw new Error("Expected query port.");
  assert.deepEqual(
    await validated.query({ signal: operationController.signal }),
    snapshot,
  );
  assert.equal(calls, 1);
  assert.notEqual(receivedSignal, lifetimeController.signal);
  assert.notEqual(receivedSignal, operationController.signal);
  assert.equal(receivedSignal?.aborted, false);
});

test("query never delegates after pre-abort and settles a cancellation despite a provider that ignores it", async () => {
  const lifetimeController = new AbortController();
  let calls = 0;
  const port = {
    kind: "query" as const,
    query: () => {
      calls += 1;
      return new Promise<AgentAccountQuotaSnapshot>(() => undefined);
    },
  };
  const validated = validateAgentAccountQuotaPort({
    providerKey,
    port,
    signal: lifetimeController.signal,
  });
  if (validated.kind !== "query") throw new Error("Expected query port.");

  const preAborted = new AbortController();
  const preAbortReason = new Error("pre-aborted");
  preAborted.abort(preAbortReason);
  await assert.rejects(
    Promise.resolve(validated.query({ signal: preAborted.signal })),
    (error: unknown) => error === preAbortReason,
  );
  assert.equal(calls, 0);

  const operation = new AbortController();
  const pending = Promise.resolve(validated.query({ signal: operation.signal }));
  assert.equal(calls, 1);
  const reason = new Error("quota read canceled");
  operation.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});

test("query observes a late native rejection when the provider aborts synchronously", async () => {
  const operation = new AbortController();
  const cancellation = new Error("operation canceled");
  const nativeError = new Error("late provider failure");
  const port = {
    kind: "query" as const,
    query: () => {
      operation.abort(cancellation);
      return Promise.reject(nativeError);
    },
  };
  const validated = validateAgentAccountQuotaPort(validationInput(port));
  if (validated.kind !== "query") throw new Error("Expected query port.");
  await assert.rejects(
    Promise.resolve(validated.query({ signal: operation.signal })),
    (error: unknown) => error === cancellation,
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));
});

test("query preserves native provider rejection identity and rejects malformed snapshots", async () => {
  const nativeError = new Error("provider quota failure");
  let mode: "error" | "invalid" = "error";
  const port = {
    kind: "query" as const,
    query: () => mode === "error"
      ? Promise.reject(nativeError)
      : Promise.resolve({ schemaVersion: 1, sourceId: "bad", state: "available" }),
  };
  const validated = validateAgentAccountQuotaPort(validationInput(port));
  if (validated.kind !== "query") throw new Error("Expected query port.");
  await assert.rejects(
    Promise.resolve(validated.query({ signal: new AbortController().signal })),
    (error: unknown) => error === nativeError,
  );
  mode = "invalid";
  await assert.rejects(
    Promise.resolve(validated.query({ signal: new AbortController().signal })),
    (error: unknown) => error instanceof Error && error.name === "AgentProtocolValidationError",
  );
});

test("observe is lazy, validates each yielded snapshot, and cleans up on return", async () => {
  const lifetimeController = new AbortController();
  const operationController = new AbortController();
  let observeCalls = 0;
  let nextCalls = 0;
  let returnCalls = 0;
  let observedSignal: AbortSignal | undefined;
  const port = {
    kind: "observe" as const,
    observe(input: { signal: AbortSignal }) {
      observeCalls += 1;
      observedSignal = input.signal;
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalls += 1;
              return Promise.resolve({ value: snapshot });
            },
            return() {
              returnCalls += 1;
              return Promise.resolve({ done: true as const, value: undefined });
            },
          };
        },
      };
    },
  };
  const validated = validateAgentAccountQuotaPort({
    providerKey,
    port,
    signal: lifetimeController.signal,
  });
  if (validated.kind !== "observe") throw new Error("Expected observe port.");
  const iterable = validated.observe({ signal: operationController.signal });
  assert.equal(observeCalls, 0);
  const iterator = iterable[Symbol.asyncIterator]();
  assert.equal(observeCalls, 0);
  assert.deepEqual(await iterator.next(), { done: false, value: snapshot });
  assert.equal(observeCalls, 1);
  assert.equal(nextCalls, 1);
  assert.notEqual(observedSignal, operationController.signal);
  await iterator.return?.();
  assert.equal(returnCalls, 1);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("explicit observe return preserves a native cleanup failure", async () => {
  const cleanupError = new Error("quota iterator cleanup failed");
  const port = {
    kind: "observe" as const,
    observe: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false as const, value: snapshot }),
          return: () => Promise.reject(cleanupError),
        };
      },
    }),
  };
  const validated = validateAgentAccountQuotaPort(validationInput(port));
  if (validated.kind !== "observe") throw new Error("Expected observe port.");
  const iterator = validated.observe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
  await iterator.next();
  await assert.rejects(iterator.return!(), (error: unknown) => error === cleanupError);
});

test("pending observe next is canceled by iterator return even when native next ignores cancellation", async () => {
  const lifetimeController = new AbortController();
  const nextDeferred = deferred<IteratorResult<unknown>>();
  let returnCalls = 0;
  let observedSignal: AbortSignal | undefined;
  const port = {
    kind: "observe" as const,
    observe(input: { signal: AbortSignal }) {
      observedSignal = input.signal;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => nextDeferred.promise,
            return: () => {
              returnCalls += 1;
              return new Promise<IteratorResult<unknown>>(() => undefined);
            },
          };
        },
      };
    },
  };
  const validated = validateAgentAccountQuotaPort({
    providerKey,
    port,
    signal: lifetimeController.signal,
  });
  if (validated.kind !== "observe") throw new Error("Expected observe port.");
  const iterator = validated.observe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await assert.rejects(iterator.next(), /Concurrent account quota observation next calls/);
  const canceled = assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  await assert.rejects(
    iterator.return!(),
    (error: unknown) => error instanceof Error && /cleanup exceeded/.test(error.message),
  );
  assert.equal(returnCalls, 1);
  assert.equal(observedSignal?.aborted, true);
  await canceled;
  nextDeferred.resolve({ done: true, value: undefined });
});

test("instance disposal aborts active observation and subsequent query calls", async () => {
  const lifetimeController = new AbortController();
  const pendingQuery = deferred<AgentAccountQuotaSnapshot>();
  const pendingObservation = deferred<IteratorResult<AgentAccountQuotaSnapshot>>();
  let returned = 0;
  const port = {
    kind: "query_and_observe" as const,
    query: ({ signal }: { signal: AbortSignal }) => {
      assert.equal(signal.aborted, false);
      return pendingQuery.promise;
    },
    observe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => pendingObservation.promise,
        return: async () => {
          returned += 1;
          return { done: true as const, value: undefined };
        },
      }),
    }),
  };
  const validated = validateAgentAccountQuotaPort({
    providerKey,
    port,
    signal: lifetimeController.signal,
  });
  if (validated.kind !== "query_and_observe") throw new Error("Expected combined port.");
  const pending = Promise.resolve(validated.query({ signal: new AbortController().signal }));
  const iterator = validated.observe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
  const next = iterator.next();
  const reason = new Error("instance disposed");
  const canceledNext = assert.rejects(next, (error) => error === reason);
  lifetimeController.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  await canceledNext;
  await iterator.return?.();
  assert.equal(returned, 1);
  await assert.rejects(
    Promise.resolve(validated.query({ signal: new AbortController().signal })),
    (error: unknown) => error === reason,
  );
});

test("observation cancellation during source creation still closes the returned native iterator", async () => {
  const operation = new AbortController();
  const reason = new Error("Canceled during observation setup");
  let returns = 0;
  let pulls = 0;
  const validated = validateAgentAccountQuotaPort(validationInput({
    kind: "observe",
    observe: () => {
      operation.abort(reason);
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => { pulls += 1; return { value: snapshot }; },
          return: async () => { returns += 1; return { done: true, value: undefined }; },
        }),
      };
    },
  }));
  if (validated.kind !== "observe") throw new Error("Expected observe port.");
  const iterator = validated.observe({ signal: operation.signal })[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), (error) => error === reason);
  await iterator.return?.();
  assert.equal(pulls, 0);
  assert.equal(returns, 1);
});

test("completed observations release producers and listeners and remain complete", async () => {
  let signal: AbortSignal | undefined;
  let returns = 0;
  const validated = validateAgentAccountQuotaPort(validationInput({
    kind: "observe",
    observe: (input: { signal: AbortSignal }) => {
      signal = input.signal;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
          return: async () => { returns += 1; return { done: true, value: undefined }; },
        }),
      };
    },
  }));
  if (validated.kind !== "observe") throw new Error("Expected observe port.");
  const iterator = validated.observe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  await iterator.return?.();
  assert.equal(returns, 1);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(getEventListeners(signal!, "abort"), []);
});

test("malformed observation output aborts its producer and preserves validation failure", async () => {
  let signal: AbortSignal | undefined;
  let returns = 0;
  const validated = validateAgentAccountQuotaPort(validationInput({
    kind: "observe",
    observe: (input: { signal: AbortSignal }) => {
      signal = input.signal;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: { ...snapshot, sourceId: "" } }),
          return: async () => { returns += 1; return { done: true, value: undefined }; },
        }),
      };
    },
  }));
  if (validated.kind !== "observe") throw new Error("Expected observe port.");
  const iterator = validated.observe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), { name: "AgentProtocolValidationError" });
  await iterator.return?.();
  assert.equal(returns, 1);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(getEventListeners(signal!, "abort"), []);
});

test("observe rejects a missing per-call signal before invoking the provider", () => {
  let calls = 0;
  const port = {
    kind: "observe" as const,
    observe: () => {
      calls += 1;
      return { [Symbol.asyncIterator]: async function* () { yield snapshot; } };
    },
  };
  const validated = validateAgentAccountQuotaPort(validationInput(port));
  if (validated.kind !== "observe") throw new Error("Expected observe port.");
  assert.throws(
    () => validated.observe({ signal: undefined as unknown as AbortSignal }),
    /AbortSignal/,
  );
  assert.equal(calls, 0);
});
