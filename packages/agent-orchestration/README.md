# @agen-ai/agent-orchestration

Optional managed delegation for applications using the AgenAI coding-agent SDK, at coordinated
source version `0.4.1` (unpublished; the published release is `0.4.0`). This package sits above
`@agen-ai/agent-runtime`. Core runtime consumers do not depend on it. Current source uses Agent
Protocol V11; the published `0.4.0` release uses V10. Managed store contract and SQLite format
remain 3; retained historical requests cannot reconstruct live reply authority.

The current implementation provides bounded target catalogs, a pure developer/user policy resolver,
managed task coordination, a volatile store and host-injected completion delivery. A separately
qualified SQLite reference demonstrates durable storage and parent inbox recovery. Scoped agent tools
and an explicitly started MCP bridge make managed tasks available to a parent session. Installing or importing the package starts no agents, listeners,
processes, network connections or database work. Native harness subagents remain independent.

## Effective choices

A target is one complete configuration certified by the host: an authorized runtime instance,
provider, model, native options, reasoning and execution-mode facts, and exact session
configuration mapping. The SDK does not invent model combinations or infer behavior from labels.

The developer can explicitly exclude a provider, model, reasoning identity, mode or combination.
Exclusions default empty. The end user enables managed delegation and selects among the remaining
targets. The main agent may choose only from those effective choices.

```ts
import {
  parseDelegationPolicySnapshot,
  parseDelegationTargetCatalog,
  resolveDelegationPolicy,
} from "@agen-ai/agent-orchestration";

const catalog = parseDelegationTargetCatalog(hostCertifiedCatalog);
const disabled = parseDelegationPolicySnapshot({ revision: 1 });
const enabled = parseDelegationPolicySnapshot({
  revision: 2,
  user: { enabled: true },
});
const choices = resolveDelegationPolicy({ catalog, policy: enabled });
// Persist user preferences in your application; pass choices.allowedTargets to admission.
```

Omitted user policy means disabled. Enabling without a selection chooses all currently available
certified standard-mode targets, including future additions. It does not select fast mode. There
is no SDK reasoning ceiling: `max`, `xhigh`, `ultra` and future certified identities are eligible.
An explicit empty selection permits nothing and never falls back to another model.

Use `selection: { kind: "all_available", includeFast: true, unknownModeTargets: [] }` to include
certified fast targets, or `selection: { kind: "explicit", targets: [{ catalogId, targetId }] }`
for fixed selections. Unknown execution-mode behavior requires exact opt-in and a visible host
limitation. User opt-in cannot bypass a relevant developer exclusion whose compliance is unknown.

```ts
const restricted = parseDelegationPolicySnapshot({
  revision: 3,
  developer: {
    enabled: true,
    exclusions: [
      { exclusionId: "no-fast", executionMode: "fast" },
      { exclusionId: "no-max", reasoning: "max" },
      { exclusionId: "model-excluded", providerKey: "example", modelId: "example-model" },
    ],
  },
  user: {
    enabled: true,
    selection: { kind: "explicit", targets: [{ catalogId: "example", targetId: "choice" }] },
  },
});
```

Each exclusion combines its criteria with AND; multiple exclusions combine with OR. Model and
native option criteria require a provider key. Exact target exclusions require both catalog and
target IDs. A known mismatch makes an exclusion inapplicable; otherwise unknown relevant
reasoning or speed blocks the target as unverifiable. The resolved result preserves catalog
order and exposes selected state, bounded denial reasons and missing selections for headless UI.

## Host certification and revisions

Catalog and target references bind exact catalog, target and authorized-source revisions. A host
must advance revisions whenever configuration, availability or account/loading authority changes,
including changes that preserve display labels. IDs are opaque correlation values, not authority.
The pure resolver performs no registry, authentication or availability I/O. A host must check live
instance readiness and provider-key agreement and fence execution against current policy/source
authority immediately before dispatch.

The application mapping contains a complete `AgentSessionConfiguration` and an ordered
`beforeFirstTurn` selection list. Extra selections must be session-scoped, mutable and immediately
applicable; they must not mutate the parent or a shared instance. Certified standard mode requires
an explicit setting or immutable host attestation that rules out ambient fast mode.

## Validation and limits

Parsers copy and freeze accepted inert data. Invalid input raises `DelegationValidationError`
with validator-neutral AgenAI issues. Ordinary declarations expose no Zod types.

Catalogs contain at most 1,000 targets and serialize to at most 1 MiB. Individual targets are at
most 32 KiB with at most 100 options and ten limitations. Opaque IDs are canonical strings of at
most 256 characters; reasoning identities are open strings of at most 128 characters. Revisions
are positive safe integers. Duplicate targets, option keys, exclusion IDs, selected identities
and inconsistent source revisions fail validation. Policy collections are bounded to 1,000
entries and 1 MiB. Oversized or malformed input cannot silently narrow into a valid configuration.

This package is ESM, MIT licensed, Node.js 22 or newer, with explicit public exports. Applications
own end-user settings, persistence, account enrollment, directories, permissions and execution
authority. No AgenAI Workspaces or private Hostd contracts are exposed.

## Managed execution

Create an explicit store and coordinator after composing your validated runtime registry:

```ts
import {
  createDelegationCoordinator,
  createInMemoryDelegationStore,
} from "@agen-ai/agent-orchestration";

const store = createInMemoryDelegationStore();
const coordinator = await createDelegationCoordinator({
  host: applicationDelegationHost,
  store,
  limits: store.limits,
});
const client = await coordinator.bindParent({ scope: authorizedParentScope });
const choices = await client.targets();
// The caller selects an exact permitted reference; an empty catalog is not a fallback.
const selected = choices.targets.find((target) => target.reference.targetId === selectedTargetId);
if (!selected) throw new Error("The selected configuration is unavailable.");
const task = await client.spawn({
  operationId: crypto.randomUUID(),
  target: selected.reference,
  expectedPolicyRevision: choices.policyRevision,
  input: { parts: [{ type: "text", text: "Investigate the assigned task." }] },
});
const result = await client.wait({ taskId: task.taskId, timeoutMs: 30_000 });
// A timeout leaves the child running. Inspect, observe, send or explicitly cancel it later.
```

The scoped client supports `spawn`, `inspect`, `observe`, `wait`, `send` and `cancel`. Stable task
identity is separate from each run. Retry an operation with its same ID and same input to receive
its retained receipt; changing input under an existing ID fails. Public views omit raw admitted
input. One coordinator consumes provider output and commits each bounded observation before pulling
the next output; slow observers read the retained projection and never consume the provider stream.

`send` distinguishes `steer` (supported active-turn delivery), `next_turn` (one explicitly queued
follow-up) and `follow_up` (a new run after completion). Native resume requires current host
permission and the exact retained conversation binding; unsupported continuation never falls back
to an unrelated new conversation. Uncertain steering retires the session and remains recovery
required even if a later terminal event arrives. Cancellation is a request until provider terminal
evidence confirms it; a cancellation race does not overwrite a completed result.

Managed selection changes prevent new inputs and queued starts. They do not interrupt an already
running child. The host's separately revocable execution lease controls active account/execution
authority. Inspection, cancellation and live request resolution each use their own current host
authority, so deselection need not strand a running task or pending approval. Parent turn completion
has no child cancellation side effect. Native harness delegation remains independent.

## Host responsibilities and cleanup

`DelegationHost` supplies the registry, synchronous current policy and access assertions, an
execution lease, authorized child resources, applied-configuration verification, and request routing.
The coordinator directly owns validated session creation/resume, session-scoped configuration,
stream consumption and close. A successfully opened session is not proof that a requested model
or fast setting was applied; the host must attest the exact configuration mapping.

Acquire child resources before native opening. The directory policy must explicitly be `shared` or
`isolated`; the host provisions and retains it. An optional fresh host binding must share an
idempotent release implementation with the resource lease. Resource release covers a binding that
was never claimed; after a claimed opening, runtime cleanup finishes first. The coordinator never
calls the provider-facing binding facade's release method. After accepted interruption, the retained
execution receives one bounded control grace to publish cancellation/terminal output before its
lifetime signal is aborted. The interruption receipt owns no output. Producers
must still quiesce before runtime and host resources are released. Failed cleanup retains the exact owner
and resources rather than pretending shutdown completed. Close the coordinator before disposing
the host-owned registry. `dispose` supports bounded `drain` or `cancel`; there is no detached executor.

Approval and elicitation requests go only to the host. A process-local opaque handle grants access
to `resolveRequest`; persisted request identifiers are historical data and cannot resolve a live
request. The coordinator commits the request and its observation before starting the host routing task. That task
runs independently from the sole child output reader, so output continues while the host awaits a person.
`resolveRequest` delivers through the retained turn execution and returns `delivered`, `rejected` with
`requestState: "pending" | "unavailable"`, or `delivery_uncertain`. A delivered receipt confirms provider-owned
acceptance of that exact canonical answer or form step; it does not claim native transport acknowledgment,
turn completion or approved effect completion. Only a definitive pending rejection restores answerability;
uncertainty forbids replay. The receipt settles without waiting for a later output, request or terminal.
An unavailable rejection removes only that exact request's eligibility; it does not complete the
child or its parent. Request expiry, accepted interruption and terminality fence fresh answers.
Local malformed, stale or pre-aborted answers reject before provider entry; entered provider
exceptions and uncertain receipts retain the child output/cleanup owner and prohibit resending.
Raw request answers and native diagnostics are not stored in observations.

## Store and capacity contract

The in-memory store is explicitly volatile. Store port contract version 3 provides owner fencing, immutable outcomes,
operation idempotency, bounded records and independent settlement/control capacity. The explicit
`@agen-ai/agent-orchestration/store-adapter` entrypoint supplies a pure transition planner and closed
row mutations for storage adapters. It does not provide a database, arbitrary transaction callback,
filesystem persistence or automatic restart execution. Store adapters own atomic commits and physical
capacity; the shared planner owns logical transitions and serialization validation.

Defaults allow four active runs, 32 queued runs, depth two, 256 retained tasks, 1,024 retained runs
and eight runs per task. A waiting approval retains its active slot. Operational count, aggregate
capacity and time budgets are finitely configurable. Serialization ceilings are 24 KiB
and 16,000 text characters per input, 8 KiB per observation/result, 2 KiB per failure, and 64 KiB per
page. Each admission reserves 32 KiB for final outcome/notification plus four 2 KiB critical control slots;
ordinary observation saturation cannot consume those reservations. Retention is explicit: records
and idempotency receipts are not automatically evicted to make room for new work.

Each descendant inherits an immutable, content-addressed ceiling of exact catalog/target/source
references. It must also pass the current origin and descendant policies. A later policy relaxation
cannot expand that ceiling; changed catalog/source revisions can require a new root task.

Settlement records a bounded completion envelope atomically with the outcome. An interrupted process
cannot restore a live executor or approval handle merely from stored records or a native conversation ID.

Failed child outcomes retain the authoritative V10 failure's `category`, `code`, bounded `message`
and `recovery` across inspection, collection, notifications and callback/MCP tools. The complete
public failure fits 2 KiB of canonical UTF-8 JSON, including escaped characters. Messages are shortened
at Unicode character boundaries as needed; codes retain a separate 128-character canonical nonblank
limit so both historical delegation codes and current protocol codes remain representable.
Child context and quota identity references are omitted because the parent visibility contract does
not qualify those identities. `wait_for_quota` retains its kind; other recovery hints retain their
safe action or exact `notBefore` data. If a retry timestamp makes the failure exceed its byte limit
even with an empty message, the projection omits that optional timestamp and retains `kind: 'retry'`
before fitting the message. It never rounds the reported instant. Hints never authorize another
child or parent-provider invocation.

A valid unsuccessful terminal without an error, such as `expired`, records a stable `unknown`
failure. V10 rejects a malformed `failed` terminal without its required error before projection.
An exception after observed dispatch remains `recovery_required` with `dispatch_uncertain`, and
unresolved cleanup or control uncertainty still overrides an apparent definitive failure.
An old store-port contract is rejected before ownership acquisition; persistence adapters must
explicitly migrate their independent record format before presenting contract version 3.

## Completion and restart

`collect` is the default completion policy and requires no parent delivery port. `next_turn` and
`automatic` require an explicit `parentDelivery: DelegationParentDeliveryPort` on the coordinator.
A durable store rejects a volatile inbox. Reopening retained non-collect work without its usable
delivery port fails before scheduling execution. The host owns parent lifecycle and turn dispatch;
the SDK owns delivery of the bounded envelope into the host's inbox.

Inbox `accept` must deduplicate by `(storeId, notificationId)` and return its stable inbox ID. After an
uncertain acknowledgement, the coordinator calls `inspect` before attempting acceptance again. Retry
backoff is bounded from one to 30 seconds. Expiry prevents new acceptance attempts; uncertain attempts
continue inspection with bounded deadlines and backoff until the inbox confirms acceptance, rejection,
or absence. A confirmed absence after expiry marks the notification expired. One actual
inbox callback runs at a time. A timed-out callback that has not quiesced keeps its execution owner;
shutdown cannot release that owner while a callback can still commit a side effect.
Shutdown stops starting inbox deliveries and quiesces any entered callback; retained pending
notifications remain available to the next owner. Draining child execution does not imply that the
parent has consumed its completion.

Task outcome, inbox acceptance and parent-provider dispatch are independent facts. Acceptance does
not prove the model consumed a result. Delivery is conditional on retained eligible intent, current
authority and eventual destination availability. Expiry, revocation or dismissal leaves the original
task result intact. The host rechecks visibility at inspection and authorization at dispatch.

The reference inbox queues results for busy, running or waiting parents, never wakes stopped or
paused parents, and dismisses retired destinations. Automatic delivery dispatches only at an idle safe
boundary; next-turn delivery waits for an explicit host boundary. Both use the host's normal parent
turn exclusion. A committed dispatch intent without a conclusive receipt becomes `recovery_required`
after restart and is not dispatched again automatically.

Owner recovery marks potentially executed children uncertain and preserves historical requests
without making them actionable. A queued run with no preparation/dispatch intent may still start
under current authorization. A settled run can redeliver its result without invoking its provider.
Delivery retries retain only their latest claim and receipt inside the reserved final slot; retries
of superseded attempts are stale. Ordinary provider operation receipts retain their existing lifetime.

The public repository's `examples/delegation` directory contains the SQLite adapter, parent inbox and
separate-process crash tests. It is an explicit Linux/Node 24.18.0/SQLite 3.53.1 reference for local
filesystem type `0xEF53`, with a trusted owned `0700` directory,
not a required SDK dependency or a distributed production store. Other adapters must independently
qualify their physical capacity, ownership and synchronization guarantees.
Reserved capacity protects against configured budget saturation; actual volume loss or unrelated
filesystem exhaustion still requires explicit recovery and cannot be reported as a committed result.

The reference task database and its optional inbox advance together to format 3; the separate owner-lock
database remains format 1. Ordinary open does not migrate retained data. The explicit offline migration
requires exclusive ownership, stopped old producers, settled/retired runs, no claimed notifications and
no dispatch-intended inbox entries. Each predecessor migration creates a consistent synchronized
backup and retains record identities, historical receipts and settled `recovery_required` outcomes.
The 1-to-2 predecessor maps absent failure classification to unknown and refuses oversized
transformations without shortening committed content. The 2-to-3 step preserves every historical
row value and receipt; it changes only the validated format header. Neither migration restores
callbacks, invokes a provider or replays an answer.
Rollback uses the retained backup in a separately owned directory with the matched old implementation;
old code cannot open format 3 and no in-place downgrade is supported. The public repository's
`MIGRATING-TO-0.4.md` and `examples/delegation/README.md` contain the command and refusal procedure.
This public reference's Node 24.18.0/SQLite 3.53.1 qualification is independent of private Hostd's
Node 22.23.2/SQLite 3.51.3 durable runtime.

Cancellation retries must reuse the operation ID from the accepted request. A different ID after a
canonical cancellation is rejected as a conflict; it is not retained as an alias. A retry reports
current cancellation truth for the runs covered by that accepted request, without affecting a
later follow-up or repeating provider interruption. Previously queued
`next_turn` work does not resume after its predecessor is canceled or uncertain. An explicitly
requested `follow_up` remains subject to fresh authorization and exact native resume support.

Contract 3 records request-resolution `delivered` independently from subsequent output completion.
Each new resolution intent retains its exact request identity, and a rejected receipt retains authoritative
request eligibility. Receipt commits update only that request; a successor request cannot be overwritten.
Settled format-2 history retains its original `completed` meaning without being reinterpreted as delivery.
Format 1 must first migrate to 2 using the matched predecessor migration. The offline 2-to-3 step requires
settled or retired runs, no outstanding request intents and no claimed or delivery-intended inbox entries.

Distinct steering, request-resolution and interruption decisions are serialized for each live
task while output consumption proceeds independently. Steering uses the current policy revisions
for its new input and preserves the run's exact applied target and immutable inherited ceiling.
An admission-capacity rejection leaves an existing host approval request waiting and cancelable.


## Agent tools and guidance

`createDelegationHostBinding({ client })` constructs a fresh binding for an already authorized
scoped client. It returns `undefined` while managed delegation is disabled. Enabled delegation with
no selected targets still supplies tools that explain the empty selection; it never chooses a
fallback model. The client’s `bindingSnapshot()` exposes the current enablement, completion policies
and finite tool limits without exposing host authority or credentials.

```ts
import { createDelegationHostBinding } from "@agen-ai/agent-orchestration";

const binding = await createDelegationHostBinding({
  client,
  instructionPlacement: "tool_context",
});
// Pass a present binding as context.hostBinding when opening a supporting runtime session.
// A claimed binding is released by runtime session cleanup; do not release its facade directly.
```

The binding supplies `delegation_targets`, `delegate_task`, `task_status`, `task_send` and
`task_cancel`. Target choices carry exact references and policy revisions. Mutation tools require
a UUID operation ID; retry the same operation with the same ID and arguments after a lost receipt.
`task_status` supports bounded waiting and paginated run history. Input content remains bounded by
the coordinator, and agent-visible projections stay within 24 KiB before the runtime result envelope.
No tool accepts parent identity, execution authority, policy changes, approval decisions or launch
commands. Permission requests remain host-owned.

Disabling delegation after a harness caches its tools denies new spawning, steering and follow-up
input. Existing status, result inspection and cancellation remain available under current host
visibility/control authority. Closing a tool binding stops its calls and waits for them to settle;
it does not dispose the coordinator or cancel children already admitted.

Generated instructions are internal SDK behavior. Applications select only an actual supported
instruction placement, not a prompt template. The default `tool_context` uses tool/server context
and makes no trusted system/developer-role claim. `system` and `developer` require a supporting
adapter; there is no silent downgrade or automatic user-message injection. Optional `nativeToolNames`
must name tools the session actually exposes; the guidance distinguishes them from managed tasks
without changing their availability. Tool guidance is not an authorization boundary.

## Explicit MCP transport

Import `startDelegationMcpBridge` from `@agen-ai/agent-orchestration/mcp` to serve one binding over
Streamable HTTP using exact `@modelcontextprotocol/sdk@1.29.0`. Import alone starts no listener.
Start only when a binding exists and the provider supports the negotiated transport:

```ts
import { startDelegationMcpBridge } from "@agen-ai/agent-orchestration/mcp";

const bridge = binding ? await startDelegationMcpBridge({ binding }) : undefined;
// Supply bridge.server to the host's session-local MCP composition.
// Once provider transport producers have stopped: await bridge?.release().
```

Each explicit start owns an ephemeral `127.0.0.1` endpoint and fresh bearer credential. Keep the
returned headers in trusted transport configuration; never log or persist them as task data.
The bridge accepts `tool_context` instructions, validates tool inputs/results through the runtime’s
shared pure validators, and supports bounded HTTP POST responses without resumable SSE. It rejects
foreign Host/Origin values and unauthorized calls. HTTP headers and bodies have a ten-second receipt
budget; the response budget defaults to 60 seconds and is explicitly configurable with
`requestTimeoutMs`. Set it above a longer custom status-wait budget. Requests are capped at 64 KiB,
responses at 128 KiB, with 32 concurrent requests, 16 actual callback producers and 32 connections.
The separate request allowance leaves room for MCP cancellation notifications while callbacks wait.
Disconnected callers still count against the callback bound until their work settles. A binding can
have only one live bridge; successful transport release permits a fresh explicit start with a new
credential. The ordinary package graph cannot import MCP.

`release()` stops admission, aborts transport calls and waits for actual producers before closing
resources. It does not invoke `binding.release`; the runtime session owns that lease. A direct host
that never transfers its binding into a runtime opening must release the binding after bridge
quiescence. An aborted HTTP request does not roll back admitted work or authorize replay. A failed
or timed-out cleanup retains ownership for an explicit retry. No global MCP configuration, skill
installation, child process or credential discovery occurs.

The optional ACP provider accepts `sessionMcpBinding: { transport: "http", create }` to install a
fresh bridge for each bound parent opening. Its factory receives the validated binding and returns
owned MCP server entries plus a transport release callback. The provider checks negotiated support,
merges static setup under its bounds, and closes native producers before the bridge; runtime then
releases the binding. See the provider package's session-scoped binding example. Each concrete
agent/version still needs actual tool discovery/invocation qualification before a host treats its
managed delegation integration as available.

## Runnable public examples

From the public SDK repository root, build its packages and run:

```sh
pnpm examples:delegation
pnpm examples:delegation:acp
```

The direct example checks disabled setup, standard/max configuration at the native invocation,
explicit fast selection, developer model/option exclusion and stale-source rejection. It exercises
progress, actual steering, queued continuation, native cancellation and a live host approval.
The credentialless ACP peer discovers and invokes the managed tools, ends its parent turn while a
child waits for approval, and consumes the completion in a later authorized parent turn. These
workflows use the same small host composition as the durable CLI.

`examples/delegation/README.md` documents the qualified SQLite setup/restart/inspect/cleanup commands
and separate-process crash cases. The packed consumer compiles and runs these sources using only
public entrypoints. Synthetic success does not qualify another installed harness, account or vendor
extension. Initialization or accepted MCP configuration alone is insufficient.

This release is SDK-first. AgenAI Workspaces preferences, account enrollment and Hostd integration
or production harness registration remain separate product follow-up work. Public package
availability does not enable those controls or grant private execution authority.
