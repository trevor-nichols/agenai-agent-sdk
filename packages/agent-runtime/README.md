# `@agen-ai/agent-runtime`

`@agen-ai/agent-runtime` is the process-local service-provider interface for coding-agent
implementations. It preserves a small ownership chain: a driver parses host configuration and
materializes an instance; the instance owns one opaque ID, technical capabilities, an adapter,
account-quota and environment discovery ports, readiness, and disposal; the adapter opens provider-native
sessions; each returned session owns its binding and conversation-local operations.

The runtime depends only on `@agen-ai/agent-protocol`. It has no concept of tenants, SaaS
workspaces, assigned users, database rows, persistence sequence, visibility, billing, host boots,
distributed leases, or storage policy. A host must authorize and select an instance before calling this SPI.
This package implements Agent Protocol V12 at coordinated SDK version `0.4.3`,
including tagged decision responses and exact turn request unavailability. Published `0.4.1`
retains V11 and its qualification evidence; the earlier `0.4.0` release retains V10.
The runtime also provides neutral session forms, plan reviews, staged native continuations and
explicit human-wait policies. Provider mappings require their own support and qualification.
Keep all installed SDK packages at the same version; the [0.4.2 migration
guide](../../MIGRATING-TO-0.4.2.md) covers tagged responses, continuous request output and store
contract changes. Generic contract proof and exact native qualification are separate boundaries.
The SDK contract version is independent of private transport and product persistence versions. This
is intentionally one coordinated tuple rather than a deployable mixed-version graph.

## Entrypoints

- `@agen-ai/agent-runtime` exports the public driver, instance, adapter, session, output,
  readiness, account-quota port validation, bounded-evidence, artifact-candidate,
  capability-bound interaction validation, session-lifetime interaction and cleanup APIs, and registry APIs.
- `@agen-ai/agent-runtime/environment` exports the instance discovery and session observation ports.
- `@agen-ai/agent-runtime/testing` exports the deterministic fake provider and reusable
  conformance runner.

## Lifecycle and ownership

1. Define an `AgentProviderDriver` with `defineAgentProviderDriver`.
2. Give caller-owned instance definitions to `createAgentProviderRegistry`.
3. Select a materialized instance by opaque `instanceId`.
4. Create, resume, or branch a provider session through its adapter. If supported and needed,
   supply the session-interaction handler on that opening input before calling the adapter.
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
a live item or exact proposed-plan artifact. A scoped consequence must fit an exact advertised
persistence/scope mode; a provider-managed remembrance consequence requires
`providerManagedRemembrance: true` and retains explicit unknown duration and applicability.
A delivered answer does not prove that a provider wrote a remembered rule. Exact offered IDs,
once-only response entry, and uncertain-delivery fencing remain unchanged.
Present every offered option's decision and consequence, then return the exact option chosen by
the caller; options with the same immediate decision can have different consequences. A human
handler should run independently while the original `execution.outputs` reader keeps consuming
progress. Resolve on that same execution, inspect its receipt, and retain its output and cleanup
owners through terminal settlement. A remembered answer creates no SDK rule or future automatic
answer; later requests still need their own offered choice. An uncertain answer must not be replayed.

Item identities are monotonic throughout a turn, including every request
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

`runtime.retrying` reports a retry already owned by the provider on the active turn or operation. It preserves
turn ownership, pending requests, and per-output backpressure; it neither starts another execution
nor completes the turn. It is rejected before `turn.started`, after `turn.completed`, after a
`final_diff` terminal materialization on a turn. Current source also admits it through an owned
session operation's awaited `onOutput`, with the exact `observationTurnId` and no `turn.started`. The event's neutral
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

Current source reserves the shared execution slot for `idle_session`/`immediate` operations after
descriptor validation, through native settlement and awaited output acceptance. Caller turns and
native continuations cannot overlap that reservation. Exact cached idempotent results are returned
before reserving another execution. Close stops admission and initiates native quiescence before
joining entered operation work; failed cleanup retains its stopped owner for retry. This lifecycle
correction and operation retry observations are included in `0.4.3`, using the existing
Agent Protocol V12 and operation SPI.

Discover the operation through `session.operations` and its offered descriptor, using an exact
application-configured ID. Pass the descriptor revision as `expectedRevision`, its exact fields,
a fresh invocation ID and an independent observation correlation; the catalog revision is a
different value. Confirmation is host-owned. A completed result proves command completion, while
an accepted completed `context_compaction` item proves an observed compaction effect. Do not infer
effects from English output text, manufacture token savings, or replay an uncertain operation.
The exported repository's `examples/operations.ts` demonstrates these cases against public APIs
and is compiled and executed in the isolated packed-consumer gate.

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

## Session-lifetime interactions

An adapter can offer a decision, form or plan review outside a model turn through
`sessionInteractions`. Support is separate from portable turn capabilities: absence means
`{ kind: 'unsupported' }`. Supported adapters declare exact
`{ openingOperation, requestKind }` mappings, `producerOwnership: 'exclusive'` and supported
`humanWait` modes. Create support does not imply resume or branch support. Supplying a handler
or policy for an unsupported mapping rejects before candidate opening.

Driver authors implement `AgentProviderAdapter` with candidate opening inputs
`AgentProviderCreateSessionInput`, `AgentProviderResumeSessionInput` and
`AgentProviderBranchSessionInput`. The runtime installs their producer facade before entering
that opening. Registry consumers receive `AgentValidatedProviderAdapter` in a
`ValidatedMaterializedAgentProviderInstance`; they use `AgentCreateSessionInput`,
`AgentResumeSessionInput` and `AgentBranchSessionInput`. These types separate provider offers
from application handlers. Revalidating an adapter retains its original candidate ownership.

Install `interactions.onRequest` before opening. The application callback receives a bound
`AgentSessionInteraction` containing its immutable portable request, observed deadline,
eligibility signal, terminal promise and `respond` capability. Narrow `request.kind` before
reading workspace targets, form fields or the exact plan snapshot. Responses are tagged by
kind and validate the offered choice and action; forms validate field answers, and plan
responses validate plan ID and revision. Only revision accepts required nonblank feedback.

For an already selected validated `adapter`, host-owned `openingInput` and UI-owned map:

```ts
import type { AgentCreateSessionInput, AgentSessionInteraction } from '@agen-ai/agent-runtime';

const pending = new Map<string, AgentSessionInteraction>();
const input: AgentCreateSessionInput = {
  ...openingInput,
  interactions: {
    onRequest(interaction) {
      pending.set(interaction.request.requestId, interaction);
    },
  },
};
const session = await adapter.createSession(input);
// Narrow request.kind and present the actual offered choices before answering.
// A workspace decision uses respond({ kind: 'decision', choiceId }).
// Retire the UI entry when interaction.signal aborts; keep entered receipt ownership.
```

A handler can return after handing the capability to an owned UI, or return a promise whose
actual work remains tracked. Opening may return while a request remains pending. Session
requests do not become `AgentEvent` request outputs or execution `resolveRequest` calls.
The complete public [lifecycle example](../../examples/lifecycle-interactions.ts) opens with a
pending decision, selects a synthetic decline and joins cleanup without a model turn. It needs
only the core protocol/runtime dependency closure. An ordinary noninteractive opening omits
`interactions`; no automatic answer policy is installed. A provider requiring a handler must
reject that opening. Authentication retains its separate bounded owner.

`respond` allows one unsettled response attempt per request:

| Receipt | Meaning |
| --- | --- |
| `delivered` | The provider-owned handler accepted the exact response. This does not prove model consumption, continuation start, successful effects or persistence. |
| `rejected` with `requestState: 'pending'` | Definitive refusal permits a later attempt only if the request remains live. A concurrent response also receives pending refusal without entering overlapping delivery. |
| `rejected` with `requestState: 'unavailable'` | The request cannot be answered again. |
| `delivery_uncertain` | Entered delivery did not establish acceptance or refusal. Mutation is fenced; retain cleanup and do not replay the response. |

Terminals are `answered`, `rejected`, `delivery_uncertain`, `withdrawn`, `expired`,
`session_closed` and `failed`. `answered.response` retains accepted kind, choice and action,
plus plan ID/revision where applicable; it does not duplicate form values or revision feedback.
`expired.source` distinguishes provider expiry from host policy. A terminal ends answer
eligibility, independently of an entered attempt's receipt. A delivered or rejected/pending
receipt racing withdrawal remains unchanged and cannot restore the retired request.

Local parse and pre-abort errors remain precise before provider entry. Entered response
exceptions or observation timeout return uncertainty. Successful cleanup cannot establish
whether an uncertain answer was accepted or authorize replay. Eligibility abortion, terminal
settlement and promise observation are not proof that producers or callbacks have joined.

### Human waiting and retention

Omitting `humanWait`, or selecting `{ kind: 'bounded' }`, retains the finite default.
The only numeric human timeout is `limits.requestTimeoutMs`. An explicitly supported
`humanWait: { kind: 'until_withdrawn_or_closed' }` installs no SDK human timer. Supplying a
`requestTimeoutMs` property in that mode rejects before opening, even when it equals the
default. The producer facade omits that property in unbounded mode.

The descriptor's optional `expiresAt` means actual provider expiry. At validated offer time,
the runtime fixes `interaction.deadline` to the earlier provider expiry or bounded host policy;
provider expiry wins a tie. No provider expiry and no host timer yields `{ kind: 'no_deadline' }`.
Presentation delay and queue residence do not restart this deadline. Expiry never fabricates an
answer. Without independently qualified provider-local survival semantics, expiry initiates
owned shutdown. Exact withdrawal remains distinct from expiry or general transport failure.

| Limit | Default | Allowed override |
| --- | --- | --- |
| `maxRetainedRequests` | 8 | 1 to 32 |
| `maxRetainedBytes` | 524,288 bytes | 65,536 to 2,097,152 bytes |
| `requestTimeoutMs` in bounded mode | 300,000 ms | 1,000 to 1,800,000 ms |
| `responseTimeoutMs` | 30,000 ms | 1,000 to 120,000 ms |
| `cleanupTimeoutMs` | 30,000 ms | 1,000 to 120,000 ms |

Retained descriptor bytes include each immutable plan snapshot once. Separately bounded
response material remains charged to its single unsettled attempt. Terminal requests stay
retained until actual native terminal, response and presentation callback work drain.
Unknown fields, fractional values and out-of-range overrides reject. Human-wait policy does
not remove response, preparation, cleanup, authentication, transport or capacity bounds.
All turn and session request IDs share the fixed session-generation census of 4,096 IDs and
1 MiB of UTF-8 identity bytes; tombstones are not evicted to grant reuse.

### Native continuations

A response that can start native work uses a provider `prepared` interaction. Effect-free
`prepareResponse` receives the exact parsed response and runtime-owned attempt identity.
It returns either `no_continuation` or `native_continuation`, with once-only `dispatch` and
idempotent predispatch `cancel` operations. Direct interactions may only deliver responses
that cannot start execution. A known no-work action does not reserve an execution.

The application installs `nativeContinuations.onExecution` before opening. Exact support
includes the opening operation, request kind and timing; it does not imply other combinations.
When preparation selects a continuation, the runtime synchronously reserves the same slot
used by caller `startTurn`, allocates a turn identity and adopts the candidate through ordinary
output validation. It never creates a synthetic caller prompt or calls candidate `startTurn`.

The host must actually call `next()` on the supplied execution's sole output iterator. Merely
retaining the handle or acquiring an iterator is insufficient. The parked wrapper pull proves
reader readiness without touching the candidate iterator before dispatch. A handler may await
that first output: dispatch does not wait for callback fulfillment. After readiness, runtime
rechecks exact request, attempt, opening, deadline and slot ownership before entering dispatch.
Output produced during dispatch stays on that original reader.

One fixed 30-second window covers preparation and reader readiness from response claim.
Predispatch failure cancels and joins allocated source/callback ownership before releasing the
slot. Failed cleanup retains the stopped owner and its retry handle. A started execution uses
normal session quiescence and output cleanup. The independent continuation `outcome` reports
`started` or `not_started`; a delivery receipt proves neither. Missing outcome cannot free a
slot or rewrite a delivered receipt. One dispatch-anchored response deadline observes both
receipt and outcome; uncertainty fences mutation without dropping either owner.

Opening timing is explicit: `after_open_return`, `before_open_return`, or `before_binding`.
The opening owner exists before candidate entry and transfers atomically after exact binding
validation. Exceptional data awaiting binding is limited to 16 envelopes, 1 MiB and 30 seconds.
It cannot invent a binding or route output by working directory. Core timing support does not
qualify a native provider mapping; select only that provider's explicitly supported tuple.

### Close and retained cleanup

Close fences opening/session admission and starts native quiescence before joining preparation,
responses, output and callbacks. A callback ignoring abort remains owned. Host binding and
installation resources are released only after actual native cleanup and joins succeed.
The opening signal applies until adoption; later cancellation belongs to the returned session
or response owner.

If opening fails with incomplete cleanup, call
`isAgentProviderSessionCleanupErrorFor(error, openingInput)` with the exact original object.
Retain the matching `AgentProviderSessionCleanupError` and its bound `retryCleanup()`; keep
registry, instance, host resources and installation references until it succeeds. A returned
session with failed close likewise retains cleanup through that session and its cleanup error.
An observation timeout cannot detach actual work. Retry joins the same owner without opening
another session or resending a response. Serialized errors and request IDs cannot restore
callable cleanup or response authority. Adapter authors preserve failed opening ownership with
`createAgentProviderSessionCleanupError({ openingInput, providerKey, errors, retryCleanup })`.

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

`resolutionFor(request, { signal })` accepts the existing synchronous resolution callback,
an asynchronous callback, or `undefined` to deliberately leave a request unanswered. Its
request-scoped signal aborts when the original output stream reports that exact request
unavailable, when the turn completes, or when conformance cleanup begins. Honor the signal
to dismiss pending human input; do not fabricate a denial or retry an answer after retirement.
The runner continuously reads the same execution while callbacks and delivery receipts are
pending. A returned answer is checked against the exact offered request before delivery.
`request_resolution` appears in the report only after a delivered receipt;
`request_unavailability` records consumption of a native retirement event. Opening a request
alone proves neither. The runner checks session controls before its main turn and inspects
turn-produced resources after terminal output while the session remains open. It then starts session
close before joining its reader and actual callback tasks; failure also starts close before joins. Original
failures and cleanup failures remain observable. A callback that ignores cancellation
remains owned until its actual promise settles.

The coordinated SDK release is `0.4.3` and implements Agent Protocol V12.
The earlier `0.4.1` release retains V11.
The earlier `0.4.0` release retains V10.
The earlier public `0.3.0` and `0.3.1` releases implemented V9 and remain historical.
Keep installed packages in the seven-package SDK release family on the coordinated version; the
orchestration and ACP packages remain optional. Every materialized instance requires `environment` and
`accountQuota`; every session requires `environment`. The former standalone `integrations`
observation port is removed. The public runtime implements Agent Protocol V12 with one current
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
