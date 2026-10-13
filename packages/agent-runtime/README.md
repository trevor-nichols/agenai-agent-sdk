# `@agen-ai/agent-runtime`

`@agen-ai/agent-runtime` is the process-local service-provider interface for coding-agent
implementations. It preserves a small ownership chain: a driver parses host configuration and
materializes an instance; the instance owns one opaque ID, technical capabilities, an adapter,
account-quota and environment discovery ports, readiness, and disposal; the adapter opens provider-native
sessions; each returned session owns its binding and conversation-local operations.

The runtime depends only on `@agen-ai/agent-protocol`. It has no concept of tenants, SaaS
workspaces, assigned users, database rows, persistence sequence, visibility, billing, host boots,
distributed leases, or storage policy. A host must authorize and select an instance before calling this SPI.
This source package implements Agent Protocol V10 as part of the coordinated SDK
`0.4.0` contract.
Upgrade consumers from `0.3.1` using the coordinated release and its migration guide.
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
5. Call `startTurn` and consume its single `outputs` stream incrementally. Submit human answers with
   the same execution's `resolveRequest`, which returns an independent delivery receipt. Neutral `AgentEvent`
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

A session reserves one turn execution synchronously at `startTurn`. Native execution stays lazy until
its first output pull; an unused handle has no provider effects. Separate sessions run concurrently.
The execution's `outputs` has exactly one consumer and one outstanding pull. Its ownership continues
across human requests until native terminal output, entered response/control settlement, and cleanup.

Materialization-scoped context usage remains monotonic only within one native provider process. A
provider that replaces that process emits a `process.started` lifecycle output as the explicit
boundary before reporting usage from the replacement. Validation then clears only the
`materialization` occupancy, cumulative counters, and compaction allowance; logical `session`
measurements remain continuous.
`startTurn(input)` returns `{ turnId, outputs, resolveRequest }`. `outputs` preserves per-output
backpressure and stays open during `waiting_for_request`; the consumer can call
`execution.resolveRequest({ resolution })` as soon as it receives `request.opened`, before its next
pull. A later queued waiting observation cannot revive an already answered request. No response
creates or acquires another output stream.

`resolveRequest` returns one of these delivery receipts:

- `{ status: "delivered" }`: the provider-owned handler accepted the exact canonical answer or step.
  This includes a mapped form-intent step whose later field answer is still pending. It does not
  establish a universal transport write, model consumption, effect completion, or turn success.
- `{ status: "rejected", requestState: "pending" | "unavailable", error }`: the provider definitively
  refused this answer. Only `pending` preserves that exact callback's answerability; `unavailable`
  retires it. Neither value terminalizes the original output owner.
- `{ status: "delivery_uncertain", error }`: native delivery started without definitive acceptance
  or refusal. Further mutation and replay are forbidden; the original output/cleanup owner remains.

Local parsing, request correlation, expiry, and pre-abort failures reject with their precise original
errors before candidate entry. Validation atomically claims an answer before invoking the optional
synchronous `onProviderExecutionStarted` observer and then the candidate. The runtime strips this
observer from candidate input. A throwing observer prevents native entry and preserves the request
only while it remains answerable. An unexpected candidate response exception carries
`AgentProviderDelegatedOperationError` with `operation: "resolve_request"` and started-execution evidence;
it also forbids further mutation. Concurrent duplicate answers cannot enter the provider twice.

The turn input has the same synchronous start observer at its lazy candidate-entry boundary, after
prechecks pass. Abort or iterator return before the first pull releases the reservation without
poisoning the session. An aborted old handle rejects on a later pull. Abandoning an entered output
consumer stops admission and closes its native owner; an incomplete stream makes the session unusable.
Interruption remains a session control: dispatch acceptance leaves the original stream open to
observe actual native cancellation completion. Its `AgentProviderTurnInterruptionResult` carries only
status and optional error; interruption cannot return turn output. A reserved turn rejects interruption
with `active_turn_mismatch`, including after iterator acquisition; the first pull must enter the provider.
Abort or return cancels a reservation locally. Admitted interruption suspends exact request admission;
definitive failed interruptions restore only the unchanged live callback after every overlapping
interruption fails. A concurrent response refusal with `requestState: "pending"` retains that callback
through suspension; an accepted interruption withdraws it regardless of response completion order.

Close first stops admission, signals cancellation, and initiates native quiescence; it then joins
entered output/response work and drains host callbacks before releasing resources. Native close is
initiated before joining acknowledgments that depend on it. A failed close keeps the stopped owner
and host binding retained while close remains retryable. Successful close and disposal are idempotent.

Ordinary answers past a request's `expiresAt` fail locally. A canonical `canceled` resolution still
checks the live handler's availability; expiry alone cannot establish delivery. Terminal observation
fences new answers even while an entered response is settling, and waiting observations cannot
reopen an older request. A host must cancel human decisions when their execution ends and join
those tasks during cleanup. Keep the session or exact opening-cleanup receipt if cleanup fails;
disposing its registry or host resources before quiescence would lose the retained owner.

`runtime.retrying` reports a retry already owned by the provider on the active turn. It preserves
turn ownership, pending requests, and per-output backpressure; it neither starts another execution
nor completes the turn. It is rejected before `turn.started`, after `turn.completed`, after a
`final_diff` terminal materialization, and from session-operation observations. The event's neutral
failure category and recovery hint describe the observed condition. A recovery hint never authorizes
replaying work or changes an uncertain execution outcome. Contract failures, delegated-operation
started evidence, and retained cleanup responsibilities remain separate from those failure values.

When context usage is advertised, the validated session enforces the declared measurement scopes
and cumulative fields across turns. Identical consecutive samples and decreasing cumulative
counters are rejected. Occupancy may decrease only after a completed advertised compaction item;
the next accepted sample consumes that allowance. Context output remains subject to the same
per-output backpressure and terminal ordering as every other provider event.

When `capabilities.turns.steer.kind` is `supported`, the session exposes `steering.steerTurn`. Steering accepts
the existing turn ID plus the same canonical `parts` and optional `summary` used to start a turn.
It requires provider entry on the first output pull; a reserved or merely acquired execution rejects
steering with `active_turn_mismatch` without calling the provider.
It does not create or own an output stream: model output continues on the original execution's
`outputs` iterator. The receipt is exactly `delivered`, `rejected` with a bounded neutral error, or
`delivery_uncertain` with a bounded neutral error. A provider must use uncertainty when delivery
may have started but its authoritative acknowledgement was lost; callers cannot safely replay that
result. A returned `delivery_uncertain` makes the validated session unusable for further mutation.
Keep its original output reader owned while it drains toward terminality; a pending request does not
end that stream or restore mutation authority. Close the unusable session to quiesce work that cannot
finish without another response, then rematerialize before further work. The validated runtime preserves pre-delegation
validation and abort errors unchanged, while
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

## Session-local host tools and instructions

A host can pass an optional `AgentSessionHostBinding` when creating, resuming or branching a
session. The binding contains tool definitions, an invocation callback, optional instructions and
an idempotent `release` callback. Its callbacks close over host authorization; model arguments do
not supply that authority. This is an additive runtime SPI. It does not enable managed delegation
or change native collaboration by itself.

The optional `@agen-ai/agent-orchestration` package sits above this SPI. It owns managed target policy,
scoped tools and generated delegation guidance; the runtime has no dependency on that package or
its explicit MCP transport. A parent's end-turn boundary leaves its session binding alive and does
not cancel independently owned children. AgenAI Workspaces preferences and Hostd production
integration remain separate product work.

An adapter declares `hostBinding` support, its `callback` or `mcp` transport, and the instruction
placements it can materialize. Missing support means unsupported. `system` and `developer`
placements require the corresponding trusted native channels; `tool_context` means tool/server
guidance. The runtime rejects unsupported requests before native session creation. Adapter authors
must reject collisions with their native tools and actually install the requested binding.

Tools use a bounded, closed JSON Schema 2020-12 subset: objects with declared properties and no
additional properties, bounded arrays and strings, finite numbers, safe integers, booleans and
null. Root schemas declare the dialect. References, remote loading, regular expressions, coercion
and executable validation are unsupported. A binding allows up to 32 tools, 64 KiB of definition
data, 32 KiB argument/result envelopes and 16 concurrent callbacks. Runtime validation precedes
callback entry and validates returned results; callback exceptions become sanitized tool errors.

Every opening needs a fresh binding object, including resume and branch. The validated opening
claims a minimally valid binding before other opening checks. After that claim, opening failures
own cleanup; malformed minimal bindings remain caller-owned and a duplicate claim cannot release
the original session's binding. `validateAgentSessionHostBinding` validates metadata without claiming it. Explicit transport
adapters can reuse `validateAgentHostToolInvocation({ binding, invocation })` against that validated
metadata and `validateAgentHostToolResult(value)` without duplicating the bounded schema interpreter.
These pure validators do not invoke callbacks, claim leases or provide lifecycle ownership.

If a provider opening fails before returning a session and native resources are still pending,
throw `createAgentProviderSessionCleanupError({ providerKey, openingInput, errors, retryCleanup })`.
`openingInput` must be the exact context object received by the create/resume/branch port. The
validated adapter adopts only that exact identity and provider key, stops new host callbacks, and
retains the original binding. Explicit cleanup retry first quiesces provider resources and then
releases the binding; propagation does not add another native cleanup attempt. Successful native
cleanup is retained when only host release needs retry. A plain or foreign cleanup error cannot
claim the current opening. Callers can use `isAgentProviderSessionCleanupErrorFor(error, input)`
against their original opening object to identify the retained responsibility.

Closing stops new invocations and aborts active callback signals, then joins provider cleanup and
callback settlement before releasing the host binding. Ending a turn does not release it. Providers
must quiesce their output/control producers before their close succeeds and clean up partial native
resources before throwing an opening error without a session. Preserve callback method receivers.
Hosts must close their sessions before disposing the instance or registry. Registry disposal retains
its existing instance ownership and does not inventory or close caller-owned session bindings.

Cleanup failure leaves authority closed and cleanup retryable. An opened session retries through
`session.close`. If opening fails and cleanup also fails, catch
`AgentProviderSessionCleanupError` and check
`isAgentProviderSessionCleanupErrorFor(error, originalOpeningInput)` before assigning its retained
handle to an opening. Use a distinct input object for each opening and preserve the exact object
passed to create, resume or branch; copied inputs
and constructed errors do not match the runtime's private ownership evidence. This also covers
invalid candidates without host tools. `AgentProviderHostBindingCleanupError` remains the compatible
subclass for failures involving a claimed host binding. A provider can propagate another opening's
error, so `instanceof` alone does not establish ownership. Call the matching error's single-flight
`retryCleanup()` to finish retained cleanup. It closes the exact rejected session before releasing
the binding; a completed close is not repeated when only host release failed. Keep this error and
its diagnostic causes on the trusted host boundary. Never serialize its handle or raw diagnostics
into a model tool result.

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

Use `AgentError.category`, `code` and `recovery` to describe an expected operational condition.
They do not replace `AgentProviderContractError`, delegated-operation start evidence, or cleanup
exceptions. A `runtime.error` observation is not a terminal event; `runtime.retrying` keeps the same
turn active. Render a definitive failed turn from its `turn.completed` result instead of counting
each error observation as another failure. A transient classification or a quota reset never proves
that prior tool effects can be repeated.

Cancellation must retain the current stream and resource owners until native settlement and callback
quiescence are established. An accepted interruption acknowledges dispatch; it does not establish
cancellation completion. If the outcome remains unknown, preserve that uncertainty, close the unusable
session and retain any failed cleanup handle for explicit retry. Successful cleanup does not settle
the uncertain operation or authorize resending it.

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

The coordinated SDK version is `0.4.0` and implements Agent Protocol V10.
The earlier public `0.3.0` and `0.3.1` releases implemented V9 and remain historical.
Keep installed packages in the seven-package SDK release family on the coordinated version; the
orchestration and ACP packages remain optional. Every materialized instance requires `environment` and
`accountQuota`; every session requires `environment`. The former standalone `integrations`
observation port is removed. The public runtime implements Agent Protocol V10 with one current
adapter/session surface. Package versions remain independent of private transport and product
persistence versions.

Run the clean packed-consumer proof before any release:

From the public repository root, run `pnpm check`.

It installs tarballs into a temporary project outside the workspace, typechecks every documented
entrypoint, runs the fake provider and parser flow, and removes the temporary directory. It never
publishes or accesses release credentials.

The public repository also contains `examples/delegation`: a shared host composition with direct
and credentialless ACP workflows plus a separately qualified SQLite/inbox CLI. From that root,
`pnpm examples:delegation` exercises real steering, queued resume, cancellation and live approval;
`pnpm examples:delegation:acp` invokes scoped MCP tools and demonstrates a child surviving its
parent's end-turn boundary. The installed-tarball consumer runs the same source. Synthetic evidence
does not certify native agents or authorize replay of an uncertain turn.

For the smallest runnable lifecycle example, use
[`examples/live-request-output.ts`](../../examples/live-request-output.ts) in the public repository
with `pnpm examples:live-request-output`. It observes unrelated output before answering an exact
request, with one reader and joined cleanup. The public
[migration guide](../../MIGRATING-TO-0.4.md#continuous-turn-output-and-independent-answers) shows the
published-`0.3.1` before-example and an independent human-handler pattern for `0.4.0`.
