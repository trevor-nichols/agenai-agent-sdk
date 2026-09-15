# `@agen-ai/agent-runtime`

`@agen-ai/agent-runtime` is the process-local service-provider interface for coding-agent
implementations. It preserves a small ownership chain: a driver parses host configuration and
materializes an instance; the instance owns one opaque ID, technical capabilities, an adapter,
account-quota and environment discovery ports, readiness, and disposal; the adapter opens provider-native
sessions; each returned session owns its binding and conversation-local operations.

The runtime depends only on `@agen-ai/agent-protocol`. It has no concept of tenants, SaaS
workspaces, assigned users, database rows, persistence sequence, visibility, billing, host boots,
leases, or storage policy. A host must authorize and select an instance before calling this SPI.
This source package implements Agent Protocol V9 as part of the coordinated SDK `0.3.1` contract.
The SDK contract version is independent of private transport and product persistence versions. This
is intentionally one coordinated tuple rather than a deployable mixed-version graph.

## Entrypoints

- `@agen-ai/agent-runtime` exports the public driver, instance, adapter, session, output,
  readiness, account-quota port validation, bounded-evidence, artifact-candidate,
  capability-bound interaction validation, and registry APIs.
- `@agen-ai/agent-runtime/environment` exports the instance discovery and session observation ports.
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

Authentication is adapter-owned. The public runtime does not require an API key or prefer one
credential mechanism over another: an adapter may use an existing subscription login, an
interactive account flow, an API credential, or another provider-supported mechanism. The host
owns authorization to select that adapter and must keep provider-native credentials, account
paths, and login controls outside the public SDK contracts.

Sessions expose cohesive capability-matched ports:
configuration inventory and selection, typed operation inventory and invocation, managed-content
inventory, environment observation, collaboration spawn/control, and generated-resource access.
An unsupported declaration exposes exactly `{ kind: "unsupported" }`; a supported declaration must
expose exactly its typed handlers. Catalogs and results are parsed again at the runtime boundary,
bounded by the declaration, and correlated to the offered revision and caller-owned identity.

Account-quota observation is an instance port beside the session adapter. Its four exact variants
are `unsupported`, `query`, `observe`, and `query_and_observe`; supported variants must expose all
methods named by their kind. Every operation receives an `AbortSignal`. The registry combines that
caller signal with the materialized-instance lifetime, parses every returned snapshot, closes an
observation iterator on cancellation or disposal, and preserves provider errors. Quota reads are
replaceable account state and never become model prompts, conversation events, turn output, or
execution authorization. A malformed or unavailable quota result cannot invalidate an otherwise
usable session.

Explicit iterator return and normal end join native cleanup for at most 1,000 ms; cleanup failure or timeout is observable. Cancellation or an existing provider failure keeps its original error while cleanup is still attempted. Iterator closure aborts its producer and removes listeners, and late native rejections remain observed.

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
Operation invocation also carries a caller-owned `observationTurnId` and an optional `onOutput`
sink. An adapter must await that sink for every operation observation. The validated runtime
admits only operation-scoped progress, context, compaction, operation, resource, warning, error,
and diagnostic events; it enforces the exact session/observation-turn correlation, immutable
identity, declared bounds, forward-only lifecycle transitions, and per-output backpressure before
the operation result may settle. Collaboration and generated-resource observations retain the
same correlation and lifecycle validation at their respective ports.

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
    // Construct capabilities, adapter, accountQuota, readiness, and disposal here.
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

## Scoped environment observation

`MaterializedAgentProviderInstance.environment` discovers a caller-selected workspace and
configuration. `AgentProviderSession.environment` observes the already bound session. Both ports
use exact `unsupported`, `read`, or `read_and_watch` variants and declare their observed domains.
Unsupported domains cannot expose methods or be returned as available observations.

Every read and watch receives an `AbortSignal` and a caller-supplied `environmentId`; snapshots and
invalidations must echo that identity. Discovery also requires a canonical absolute working directory
and validated session configuration. The runtime preserves method receivers and provider exceptions,
combines caller cancellation with instance/session lifetime, rejects operations after disposal, and
closes watch iterators with bounded cleanup. It does not accept late yields or concurrent pulls.
The optional read execution observer runs after prechecks immediately before native delegation.
An environment metadata error alone does not invalidate an otherwise healthy turn session.

Inventory observation never authorizes invocation. The host owns account/workspace scope, freshness,
visibility, immutable content admission, and durable mutation authority. Providers should obtain
registered facts from their native harness and report gaps explicitly; a successful empty inventory
must not stand in for a failed read. No provider is required to start a model turn for discovery.

## Conformance and release

Every external driver should run `runAgentProviderConformance` from
`@agen-ai/agent-runtime/testing`. The deterministic suite exercises duplicate-instance rejection,
instance identity, capabilities, readiness, create/resume/branch, binding callbacks, abort,
turn/request ordering, request resolution, steering, interruption, configuration, idempotent
close, and idempotent disposal. Unsupported operations must remain explicit discriminants and
must not expose handlers.

The coordinated SDK version for this source is `0.3.1`, and the source implements Agent Protocol
V9. The earlier public `0.3.0` release implemented the same protocol and remains historical.
Upgrade all three SDK packages together. Every materialized instance requires `environment` and
`accountQuota`; every session requires `environment`. The former standalone `integrations`
observation port is removed. The public runtime implements Agent Protocol V9 with one current
adapter/session surface. Package versions remain independent of private transport and product
persistence versions.

Run the clean packed-consumer proof before any release:

From the public repository root, run `pnpm check`.

It installs tarballs into a temporary project outside the workspace, typechecks every documented
entrypoint, runs the fake provider and parser flow, and removes the temporary directory. It never
publishes or accesses release credentials.
