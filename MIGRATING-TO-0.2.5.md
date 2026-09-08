# Migrating to 0.2.5

Upgrade `@agen-ai/validation`, `@agen-ai/agent-protocol`, and `@agen-ai/agent-runtime` together.
Version `0.2.5` keeps Agent Protocol V8 and adds account-quota snapshot schema version 1. Every
`MaterializedAgentProviderInstance` must now expose an `accountQuota` port, even when the provider
cannot report account quota. This is a source-level change for driver implementers.

## Declare the instance port

For a provider without quota support, add this field to the instance returned by `materialize`:

```ts
accountQuota: { kind: "unsupported" },
```

Unsupported ports have no `query` or `observe` handler. Supported ports use exactly one of
`query`, `observe`, or `query_and_observe`, with the corresponding handlers. Declare only the
operations that the provider actually implements. A supported provider that temporarily cannot
read quota returns a snapshot with `state: "temporarily_unavailable"`; it does not change its
port to unsupported.

## Parse and query quota

Ordinary entrypoints expose plain types and parsers. This example validates a provider port and
reads a partial observation without a provider session:

```ts
import { parseAgentProviderKey } from "@agen-ai/agent-protocol";
import { parseAgentAccountQuotaSnapshot } from "@agen-ai/agent-protocol/account-quota";
import { validateAgentAccountQuotaPort } from "@agen-ai/agent-runtime";

const lifetime = new AbortController();
const request = new AbortController();
const port = validateAgentAccountQuotaPort({
  providerKey: parseAgentProviderKey("example-provider"),
  signal: lifetime.signal,
  port: {
    kind: "query",
    query: () => parseAgentAccountQuotaSnapshot({
      schemaVersion: 1,
      sourceId: "opaque-account-generation",
      observedAt: new Date().toISOString(),
      state: "available",
      completeness: "partial",
      windows: [],
      allowance: { included: "unknown", extra: "unknown", reserve: "unknown" },
    }),
  },
});

try {
  if (port.kind === "query" || port.kind === "query_and_observe") {
    const snapshot = await port.query({ signal: request.signal });
    console.log(snapshot);
  }
} finally {
  request.abort();
  lifetime.abort();
}
```

The provider supplies an opaque `sourceId` that changes when the quota source changes. Preserve
the original observation timestamp and distinguish unknown allowance from a measured zero.
Snapshots are bounded to 64 windows and 65,536 encoded bytes. Keep credentials, native account
identifiers, endpoints, and raw provider payloads inside the adapter.

## Cancellation and observation

Every query or observation receives a required caller-owned `AbortSignal`. Providers must honor
that signal and release their resources. The validated port combines it with the instance
lifetime; caller cancellation, registry disposal, or instance abort cancels pending work and
prevents late values from reaching the caller. Aborted queries reject with an `AbortError`.

An `observe` handler returns an `AsyncIterable` of snapshots. Consume it sequentially with
`for await`, and stop by aborting the caller signal or closing the iterator. The validated
iterator preserves pull-based backpressure and forwards cleanup to the provider iterator. Do not
use quota to start a session, admit a turn, or make authorization decisions.

## Boundaries and verification

The `/account-quota` entrypoint is validator-neutral. Schema composition remains available only
through the explicit `/zod` entrypoint; JSON Schema remains available through `/json-schema`.
Quota snapshots are separate from `AgentEvent` and do not add a transcript kind. Private Host
Protocol V18, provider catalog V11, and member response V12 belong to the host integration and
are not public SDK transport or authorization contracts.

Run `runAgentProviderConformance` from `@agen-ai/agent-runtime/testing` against each driver. From
the public repository root, `pnpm check` validates generated contracts, builds and tests all three
packages, and verifies a clean consumer of the packed tarballs.
