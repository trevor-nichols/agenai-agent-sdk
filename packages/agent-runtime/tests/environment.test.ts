// ------------------------------------------------------------------------------------------------
//                environment.test.ts - Runtime environment port qualification
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentConfigurationRevisionId,
  parseAgentEnvironmentId,
  parseAgentEnvironmentSnapshot,
  parseAgentProviderKey,
  type AgentEnvironmentId,
  type AgentEnvironmentInvalidation,
  type AgentEnvironmentSnapshot,
  type AgentSessionConfiguration,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  validateAgentEnvironmentDiscoveryPort,
  validateAgentEnvironmentObservationPort,
} from "../src/index.js";
import type {
  AgentEnvironmentDiscoveryInput,
  AgentEnvironmentDiscoveryPort,
  AgentEnvironmentObservationPort,
  AgentEnvironmentObservationWatchInput,
} from "../src/environment/types.js";

const providerKey = parseAgentProviderKey("environment-test");
const environmentId = parseAgentEnvironmentId("environment:test");
const otherEnvironmentId = parseAgentEnvironmentId("environment:other");
const configuration: AgentSessionConfiguration = {
  kind: "managed",
  revision: parseAgentConfigurationRevisionId("configuration:1"),
};

function snapshot(id: AgentEnvironmentId): AgentEnvironmentSnapshot {
  return parseAgentEnvironmentSnapshot({
    schemaVersion: 1,
    environmentId: id,
    revision: 1,
    content: { kind: "unavailable", reasons: ["transient_failure"] },
    commands: { kind: "unavailable", reasons: ["transient_failure"] },
    extensions: { kind: "unavailable", reasons: ["transient_failure"] },
    integrations: { kind: "unavailable", reasons: ["transient_failure"] },
  });
}

function snapshotWithAvailableCommands(id: AgentEnvironmentId): AgentEnvironmentSnapshot {
  return parseAgentEnvironmentSnapshot({
    schemaVersion: 1,
    environmentId: id,
    revision: 1,
    content: { kind: "unavailable", reasons: ["transient_failure"] },
    commands: {
      kind: "available",
      catalog: {
        revision: 1,
        observedAt: "2026-01-01T00:00:00.000Z",
        commands: [],
      },
      extent: "session",
      completeness: "complete",
      reasons: [],
    },
    extensions: { kind: "unavailable", reasons: ["transient_failure"] },
    integrations: { kind: "unavailable", reasons: ["transient_failure"] },
  });
}

function contractError(code: string) {
  return (error: unknown): boolean =>
    error instanceof AgentProviderContractError && error.code === code;
}

test("read validation invokes the runtime receipt and strips it from the provider input", async () => {
  let executionStarted = 0;
  let received: AgentEnvironmentDiscoveryInput | undefined;
  let receivedThis: unknown;
  const rawPort: AgentEnvironmentDiscoveryPort = {
    kind: "read",
    domains: ["content"],
    async readEnvironment(this: unknown, input) {
      receivedThis = this;
      received = input;
      return snapshot(input.environmentId);
    },
  };
  const validated = validateAgentEnvironmentDiscoveryPort({
    providerKey,
    capability: { kind: "read", domains: ["content"] },
    port: rawPort,
    signal: new AbortController().signal,
  });
  assert.equal(validated.kind, "read");
  if (validated.kind !== "read") return;

  const result = await validated.readEnvironment({
    signal: new AbortController().signal,
    environmentId,
    workingDirectory: "/workspace/environment-test",
    configuration,
    onProviderExecutionStarted: () => {
      executionStarted += 1;
    },
  });

  assert.equal(result.environmentId, environmentId);
  assert.equal(executionStarted, 1);
  assert.equal(receivedThis, rawPort);
  assert.deepEqual(Object.keys(received ?? {}).sort(), [
    "configuration",
    "environmentId",
    "signal",
    "workingDirectory",
  ]);
  assert.equal(received?.environmentId, environmentId);
});

test("instance discovery cannot promote workspace evidence to session evidence", async () => {
  const sessionSnapshot = snapshotWithAvailableCommands(environmentId);
  const discovery = validateAgentEnvironmentDiscoveryPort({
    providerKey,
    capability: { kind: "read", domains: ["commands"] },
    signal: new AbortController().signal,
    port: { kind: "read", domains: ["commands"], readEnvironment: async () => sessionSnapshot },
  });
  assert.equal(discovery.kind, "read");
  if (discovery.kind !== "read") throw new Error("Expected discovery reader");
  await assert.rejects(discovery.readEnvironment({
    environmentId, signal: new AbortController().signal,
    workingDirectory: "/workspace/environment-test", configuration,
  }), contractError("invalid_inventory"));

  const observation = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: { kind: "read", domains: ["commands"] },
    signal: new AbortController().signal,
    port: { kind: "read", domains: ["commands"], readEnvironment: async () => sessionSnapshot },
  });
  assert.equal(observation.kind, "read");
  if (observation.kind !== "read") throw new Error("Expected session reader");
  assert.deepEqual(await observation.readEnvironment({
    environmentId, signal: new AbortController().signal,
  }), sessionSnapshot);
});

test("read validation rejects pre-aborted work and cancels a pending provider read", async () => {
  let calls = 0;
  let resolvePending: ((value: AgentEnvironmentSnapshot) => void) | undefined;
  const pending = new Promise<AgentEnvironmentSnapshot>((resolve) => {
    resolvePending = resolve;
  });
  const rawPort: AgentEnvironmentObservationPort = {
    kind: "read",
    domains: ["content"],
    readEnvironment: async () => {
      calls += 1;
      return pending;
    },
  };
  const lifetime = new AbortController();
  const validated = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: { kind: "read", domains: ["content"] },
    port: rawPort,
    signal: lifetime.signal,
  });
  assert.equal(validated.kind, "read");
  if (validated.kind !== "read") return;

  const preAborted = new AbortController();
  const preAbortReason = new Error("pre-aborted environment read");
  preAborted.abort(preAbortReason);
  await assert.rejects(
    validated.readEnvironment({ signal: preAborted.signal, environmentId }),
    (error: unknown) => error === preAbortReason,
  );
  assert.equal(calls, 0);

  const pendingRead = validated.readEnvironment({
    signal: new AbortController().signal,
    environmentId,
  });
  const lifetimeReason = new Error("session environment closed");
  lifetime.abort(lifetimeReason);
  await assert.rejects(
    pendingRead,
    (error: unknown) => error === lifetimeReason,
  );
  assert.equal(calls, 1);
  resolvePending?.(snapshot(environmentId));
});

test("metadata failure is reported as inventory data and does not poison the next read", async () => {
  let returnWrongIdentity = true;
  let providerFailure: Error | undefined;
  const rawPort: AgentEnvironmentObservationPort = {
    kind: "read",
    domains: ["content"],
    readEnvironment: async () => {
      if (providerFailure !== undefined) throw providerFailure;
      return snapshot(returnWrongIdentity ? otherEnvironmentId : environmentId);
    },
  };
  const validated = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: { kind: "read", domains: ["content"] },
    port: rawPort,
    signal: new AbortController().signal,
  });
  assert.equal(validated.kind, "read");
  if (validated.kind !== "read") return;

  await assert.rejects(
    validated.readEnvironment({
      signal: new AbortController().signal,
      environmentId,
    }),
    contractError("invalid_inventory"),
  );
  returnWrongIdentity = false;
  const recovered = await validated.readEnvironment({
    signal: new AbortController().signal,
    environmentId,
  });
  assert.equal(recovered.environmentId, environmentId);

  providerFailure = new Error("native environment read failed");
  await assert.rejects(
    validated.readEnvironment({
      signal: new AbortController().signal,
      environmentId,
    }),
    (error: unknown) => error === providerFailure,
  );
  providerFailure = undefined;
  const healthyAgain = await validated.readEnvironment({
    signal: new AbortController().signal,
    environmentId,
  });
  assert.equal(healthyAgain.environmentId, environmentId);
});

test("a read cannot publish an available undeclared domain", async () => {
  const rawPort: AgentEnvironmentObservationPort = {
    kind: "read",
    domains: ["content"],
    readEnvironment: async () => snapshotWithAvailableCommands(environmentId),
  };
  const validated = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: { kind: "read", domains: ["content"] },
    port: rawPort,
    signal: new AbortController().signal,
  });
  assert.equal(validated.kind, "read");
  if (validated.kind !== "read") return;
  await assert.rejects(
    validated.readEnvironment({
      signal: new AbortController().signal,
      environmentId,
    }),
    contractError("invalid_inventory"),
  );
});

test("watch validation rejects concurrent pulls and returns its source exactly once", async () => {
  let received: AgentEnvironmentObservationWatchInput | undefined;
  let resolveNext: ((value: IteratorResult<AgentEnvironmentInvalidation>) => void) | undefined;
  let returnCount = 0;
  const source = {
    next: () => new Promise<IteratorResult<AgentEnvironmentInvalidation>>((resolve) => {
      resolveNext = resolve;
    }),
    return: async (): Promise<IteratorResult<AgentEnvironmentInvalidation>> => {
      returnCount += 1;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const rawPort: AgentEnvironmentObservationPort = {
    kind: "read_and_watch",
    domains: ["content"],
    readEnvironment: async (input) => snapshot(input.environmentId),
    watchEnvironment: (input) => {
      received = input;
      return source;
    },
  };
  const validated = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: { kind: "read_and_watch", domains: ["content"] },
    port: rawPort,
    signal: new AbortController().signal,
  });
  assert.equal(validated.kind, "read_and_watch");
  if (validated.kind !== "read_and_watch") return;

  const iterator = validated.watchEnvironment({
    signal: new AbortController().signal,
    environmentId,
  })[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    iterator.next(),
    /Concurrent environment watch next calls are not supported/,
  );
  resolveNext?.({
    done: false,
    value: { environmentId, domains: ["content"] },
  });
  const observed = await first;
  assert.equal(observed.done, false);
  assert.equal(observed.value.environmentId, environmentId);
  assert.deepEqual(Object.keys(received ?? {}).sort(), [
    "environmentId",
    "signal",
  ]);
  await iterator.return?.();
  assert.equal(returnCount, 1);
});

test("port kind and domain declarations must match the advertised capability", () => {
  const rawPort: AgentEnvironmentObservationPort = {
    kind: "read",
    domains: ["content"],
    readEnvironment: async (input) => snapshot(input.environmentId),
  };
  assert.throws(
    () => validateAgentEnvironmentObservationPort({
      providerKey,
      capability: { kind: "unsupported" },
      port: rawPort,
      signal: new AbortController().signal,
    }),
    contractError("capability_port_mismatch"),
  );
  assert.throws(
    () => validateAgentEnvironmentObservationPort({
      providerKey,
      capability: { kind: "read", domains: ["commands"] },
      port: rawPort,
      signal: new AbortController().signal,
    }),
    contractError("capability_port_mismatch"),
  );
  assert.throws(
    () => validateAgentEnvironmentDiscoveryPort({
      providerKey,
      capability: { kind: "unsupported" },
      port: { kind: "unsupported", extra: true },
      signal: new AbortController().signal,
    }),
    contractError("capability_port_mismatch"),
  );
});

test("watch rejects wrong-scope invalidations and ignores a late result after disposal", async () => {
  let wrongReturnCount = 0;
  const wrongSource = {
    async next(): Promise<IteratorResult<AgentEnvironmentInvalidation>> {
      return {
        done: false,
        value: { environmentId: otherEnvironmentId, domains: ["content"] },
      };
    },
    async return(): Promise<IteratorResult<AgentEnvironmentInvalidation>> {
      wrongReturnCount += 1;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const wrongPort: AgentEnvironmentObservationPort = {
    kind: "read_and_watch",
    domains: ["content"],
    readEnvironment: async (input) => snapshot(input.environmentId),
    watchEnvironment: () => wrongSource,
  };
  const wrongValidated = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: { kind: "read_and_watch", domains: ["content"] },
    port: wrongPort,
    signal: new AbortController().signal,
  });
  assert.equal(wrongValidated.kind, "read_and_watch");
  if (wrongValidated.kind !== "read_and_watch") return;
  const wrongIterator = wrongValidated.watchEnvironment({
    signal: new AbortController().signal,
    environmentId,
  })[Symbol.asyncIterator]();
  await assert.rejects(
    wrongIterator.next(),
    contractError("invalid_inventory"),
  );
  assert.equal(wrongReturnCount, 1);

  let resolveLate: ((value: IteratorResult<AgentEnvironmentInvalidation>) => void) | undefined;
  let lateReturnCount = 0;
  const lateSource = {
    next: () => new Promise<IteratorResult<AgentEnvironmentInvalidation>>((resolve) => {
      resolveLate = resolve;
    }),
    async return(): Promise<IteratorResult<AgentEnvironmentInvalidation>> {
      lateReturnCount += 1;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const latePort: AgentEnvironmentObservationPort = {
    kind: "read_and_watch",
    domains: ["content"],
    readEnvironment: async (input) => snapshot(input.environmentId),
    watchEnvironment: () => lateSource,
  };
  const lifetime = new AbortController();
  const lateValidated = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: { kind: "read_and_watch", domains: ["content"] },
    port: latePort,
    signal: lifetime.signal,
  });
  assert.equal(lateValidated.kind, "read_and_watch");
  if (lateValidated.kind !== "read_and_watch") return;
  const lateIterator = lateValidated.watchEnvironment({
    signal: new AbortController().signal,
    environmentId,
  })[Symbol.asyncIterator]();
  const lateNext = lateIterator.next();
  const disposalReason = new Error("environment lifetime ended");
  lifetime.abort(disposalReason);
  await assert.rejects(lateNext, (error: unknown) => error === disposalReason);
  resolveLate?.({
    done: false,
    value: { environmentId, domains: ["content"] },
  });
  await lateIterator.return?.();
  assert.equal(lateReturnCount, 1);
});

test("synchronous cancellation during iterator construction still returns the captured source", async () => {
  const lifetime = new AbortController();
  let returns = 0;
  let pulls = 0;
  const port: AgentEnvironmentObservationPort = {
    kind: "read_and_watch",
    domains: ["content"],
    readEnvironment: async ({ environmentId: id }) => snapshot(id),
    watchEnvironment: () => {
      lifetime.abort();
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              pulls += 1;
              return { done: true as const, value: undefined };
            },
            async return() {
              returns += 1;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    },
  };
  const validated = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: { kind: "read_and_watch", domains: ["content"] },
    port,
    signal: lifetime.signal,
  });
  assert.equal(validated.kind, "read_and_watch");
  if (validated.kind !== "read_and_watch") throw new Error("Expected watch port.");
  const iterator = validated.watchEnvironment({ environmentId, signal: new AbortController().signal })[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), { name: "AbortError" });
  await iterator.return?.();
  assert.equal(pulls, 0);
  assert.equal(returns, 1);
});

test("a stalled native return is bounded and never allows another provider pull", async () => {
  let pulls = 0;
  let returns = 0;
  const validated = validateAgentEnvironmentObservationPort({
    providerKey,
    capability: { kind: "read_and_watch", domains: ["content"] },
    signal: new AbortController().signal,
    port: {
      kind: "read_and_watch",
      domains: ["content"],
      readEnvironment: async () => snapshot(environmentId),
      watchEnvironment: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              pulls += 1;
              return { done: false, value: { environmentId, domains: ["content"] } };
            },
            return() {
              returns += 1;
              return new Promise(() => undefined);
            },
          };
        },
      }),
    },
  });
  if (validated.kind !== "read_and_watch") throw new Error("Expected watch port.");
  const iterator = validated.watchEnvironment({ environmentId, signal: new AbortController().signal })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  await assert.rejects(async () => iterator.return?.(), /cleanup exceeded 1000ms/);
  assert.equal((await iterator.next()).done, true);
  assert.equal(pulls, 1);
  assert.equal(returns, 1);
});
