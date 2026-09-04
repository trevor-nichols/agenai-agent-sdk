# `@agen-ai/agent-runtime`

`@agen-ai/agent-runtime` is the process-local service-provider interface for coding-agent
implementations. It preserves a small ownership chain: a driver parses host configuration and
materializes an instance; the instance owns one opaque ID, technical capabilities, an adapter,
readiness, and disposal; the adapter opens provider-native sessions; each returned session owns
its binding and conversation-local operations.

The runtime depends only on `@agen-ai/agent-protocol`. It has no concept of tenants, SaaS
workspaces, assigned users, database rows, persistence sequence, visibility, billing, host boots,
leases, or storage policy. A host must authorize and select an instance before calling this SPI.
This source package implements Agent Protocol V8. Agent Protocol V8, private host V16/catalog V10, and Workspaces event V10.
This is intentionally one coordinated tuple rather than a deployable mixed-version graph.

## Entrypoints

- `@agen-ai/agent-runtime` exports the public driver, instance, adapter, session, output,
  readiness, bounded-evidence, artifact-candidate, capability-bound interaction validation,
  and registry APIs.
- `@agen-ai/agent-runtime/testing` exports the deterministic fake provider and reusable
  conformance runner.

## Lifecycle and ownership

1. Define an `AgentProviderDriver` with `defineAgentProviderDriver`.
2. Give caller-owned instance definitions to `createAgentProviderRegistry`.
3. Select a materialized instance by opaque `instanceId`.
4. Create, resume, or branch a provider session through its adapter.
5. Consume each `runTurn` or `resolveRequest` output stream incrementally. Neutral `AgentEvent`
   output carries bounded provider source evidence atomically. A `request.opened` output may also
   carry separately bounded, non-truncated provider request context for continuation; lifecycle,
   authentication, artifact, and standalone diagnostic evidence remain separate output variants.
   Evidence reports an exact truncation reason. `originalDataBytes` is `null` when a structural
   collection, depth, object-key, cycle, accessor, unsupported-value, or inspectability constraint
   prevents honest measurement of the original provider payload.
6. Close sessions idempotently, then dispose the instance or registry.

Instance IDs never repeat in session calls. `workingDirectory` is resolved by the host and is not
an authorization credential. Create and branch implementations must invoke `onBindingCreated`
exactly once before returning the matching session. Capability-dependent operations use explicit
`supported`/`unsupported` discriminants, and the runtime rejects handlers that disagree with the
instance capability declaration.

V8 replaces interaction-extension booleans with cohesive capability-matched session ports:
configuration inventory and selection, typed operation inventory and invocation, managed-content
inventory, integration observation, collaboration spawn/control, and generated-resource access.
An unsupported declaration exposes exactly `{ kind: "unsupported" }`; a supported declaration must
expose exactly its typed handlers. Catalogs and results are parsed again at the runtime boundary,
bounded by the declaration, and correlated to the offered revision and caller-owned identity.

Approval continuations are refusal-first. Before delegating to the candidate adapter, the
validated session proves that the request is still pending and unexpired and that a selected
`optionId` was offered by that exact request. Provider-emitted approval requests must correlate to
a live item or exact proposed-plan artifact, and every option must fit an advertised
persistence/scope mode. Item identities are monotonic throughout a turn, including every request
continuation: an adapter cannot restart an observed identity, change its kind, erase prior progress
through an unknown-status update, regress it from in-progress to pending, or revive it after a
terminal event or status. An `item.completed` event must carry `completed`, `failed`, or `canceled`
status. Completion-only snapshots remain valid when no earlier lifecycle event was observed.

The host should serialize mutating operations for a given session. Separate session objects may
run concurrently, so provider implementations must isolate their conversation-local state.

Materialization-scoped context usage remains monotonic only within one native provider process. A
provider that replaces that process emits a `process.started` lifecycle output as the explicit
boundary before reporting usage from the replacement. Validation then clears only the
`materialization` occupancy, cumulative counters, and compaction allowance; logical `session`
measurements remain continuous.
`runTurn` and `resolveRequest` both preserve consumer backpressure: the provider does not resume
until the consumer requests the next output. Each stream must end at a completed turn or exactly
one newly pending request. If a consumer abandons a stream, a provider throws, or either stream
ends before that stable boundary, the validated session becomes unusable and must be closed rather
than retried. The validated `runTurn` input may observe `onProviderExecutionStarted`; validation
invokes it exactly at candidate-port delegation, after runtime prechecks pass, and never forwards it
to the candidate adapter. A delegated mutating operation that throws or returns an invalid result
has the same effect. Pre-aborted operations fail with `AbortError`; close and disposal must be safe
to call repeatedly. An accepted interruption of an already-waiting turn does not prove that the
turn terminalized; unless the result also carries a terminal event, the validated session becomes
unusable and must be closed and rematerialized. A close failure makes the session unusable while
leaving close itself retryable.

When context usage is advertised, the validated session enforces the declared measurement scopes
and cumulative fields across turns. Identical consecutive samples and decreasing cumulative
counters are rejected. Occupancy may decrease only after a completed advertised compaction item;
the next accepted sample consumes that allowance. Context output remains subject to the same
per-output backpressure and terminal ordering as every other provider event.

When `capabilities.turns.steer` is true, the session exposes `steering.steerTurn`. Steering accepts
the existing turn ID plus the same canonical `parts` and optional `summary` used to start a turn.
It does not create or own an output stream: model output continues on the original `runTurn`
iterator. The receipt is exactly `delivered`, `rejected` with a bounded neutral error, or
`delivery_uncertain` with a bounded neutral error. A provider must use uncertainty when delivery
may have started but its authoritative acknowledgement was lost; callers cannot safely replay that
result. The validated runtime preserves pre-delegation validation and abort errors unchanged, while
provider-delegated steering failures throw `AgentProviderDelegatedOperationError` with the original
cause and explicit started-execution evidence so a host can retire the unusable session. Platform
scheduling and provider-native queue modes are intentionally outside this SPI.

Configuration selection, operation invocation, and collaboration mutation use the same execution
receipt rule: stale or malformed input fails before provider delegation, while any failure after
the candidate reports execution start is wrapped as `AgentProviderDelegatedOperationError` and
makes the session unusable. The start boundary commits only after the host observer returns
successfully; an observer failure remains a pre-delegation error and leaves the session reusable.
Operation, collaboration, and generated-resource observations also
enforce correlation, immutable identity, declared bounds, and forward-only lifecycle transitions.

## Minimal driver

```ts
import {
  defineAgentProviderDriver,
  type MaterializedAgentProviderInstance,
} from "@agen-ai/agent-runtime";
import {
  parseAgentInstanceId,
  parseAgentProviderKey,
} from "@agen-ai/agent-protocol";

const providerKey = parseAgentProviderKey("third-party-provider");

export const driver = defineAgentProviderDriver({
  providerKey,
  supportsMultipleInstances: true,
  parseConfiguration(input) {
    if (input === null || typeof input !== "object")
      throw new TypeError("Invalid config.");
    return input;
  },
  createInstance({ instanceId }): MaterializedAgentProviderInstance {
    // Construct capabilities, adapter, readiness, and disposal here.
    throw new Error(`Implement ${parseAgentInstanceId(instanceId)}.`);
  },
});
```

Use the `/testing` conformance runner for lifecycle, binding, turn-ordering, live steering and
interruption, interaction results, capability ports, cancellation, close, and disposal checks.
Registry publication and provider package discovery are intentionally outside this package.

## Errors and cancellation

The runtime distinguishes programmer/contract failures from provider failures:

- `AgentProviderContractError` reports a stable `code` when an adapter contradicts its declared
  capabilities, emits invalid output, violates turn/request ordering, or returns a mismatched
  binding.
- `AgentProviderRegistryError` reports stable registry/materialization/disposal codes and retains
  provider/instance correlation when available.
- `AgentProviderConfigurationError` wraps driver configuration rejection without exposing product
  configuration policy.
- malformed primitive input may raise `TypeError` or `RangeError`; an aborted operation preserves
  an `AbortError`-named reason.

Provider-native exceptions should be normalized or safely wrapped at the provider boundary. Do
not attach credentials, raw prompts, product identities, or unbounded output to public errors.

## Conformance and release

Every external driver should run `runAgentProviderConformance` from
`@agen-ai/agent-runtime/testing`. The deterministic suite exercises duplicate-instance rejection,
instance identity, capabilities, readiness, create/resume/branch, binding callbacks, abort,
turn/request ordering, request resolution, steering, interruption, configuration, idempotent
close, and idempotent disposal. Unsupported operations must remain explicit discriminants and
must not expose handlers.

The package is at `0.2.3` while the public SPI is being proven with external adapters. Pre-1.0
releases may include breaking changes during this beta period, and those changes are called out in
the release notes.

The public runtime implements Agent Protocol V8. Its package version remains independent of private
host, catalog, persistence, and member-projection versions. V8 directly replaces V7; there is no
runtime shim or dual-protocol session surface.

Run the clean packed-consumer proof before any release:

From the public repository root, run `pnpm check`.

It installs tarballs into a temporary project outside the workspace, typechecks every documented
entrypoint, runs the fake provider and parser flow, and removes the temporary directory. It never
publishes or accesses release credentials.
