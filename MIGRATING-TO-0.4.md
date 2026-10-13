# Migrating to 0.4.0

Version `0.4.0` is the coordinated release for seven packages: `@agen-ai/validation`,
`@agen-ai/agent-protocol`, `@agen-ai/agent-runtime`, and optional `@agen-ai/agent-orchestration`,
`@agen-ai/acp-transport`, `@agen-ai/provider-acp` and `@agen-ai/acp-registry`. The earlier `0.3.2` preparation was
never published; its uncertain-steering retirement correction is carried forward here.

Agent Protocol advances from V9 to V10 with a deliberate failure-contract change. Update capability
declarations and event envelopes to `protocolVersion: 10`; live parsers reject V9 values. Core dependency
boundaries and explicit entrypoints remain unchanged. Optional runtime host-binding fields remain
additive. Package semver is independent of native vendor versions and private transport or product
persistence versions.

## Continuous turn output and independent answers

The published `0.3.1` API ended one output segment at a request boundary, then returned another
segment when the session accepted an answer. A host commonly drained those segments with a helper
that returned the opened request:

```ts
// Before: published 0.3.1. consumeSegment is the application's old drain helper.
let request = await consumeSegment(session.runTurn(input));
while (request) {
  const resolution = await chooseAnswer(request);
  request = await consumeSegment(session.resolveRequest({ resolution }));
}
```

Replace `session.runTurn(input)` with `session.startTurn(input)` and consume the returned
`execution.outputs` once. The input type is `AgentProviderStartTurnInput`. Replace the session's
stream-returning `resolveRequest` with `await execution.resolveRequest({ resolution, signal })`.
The answer returns a delivery receipt; all later output stays on the original execution. There is
no compatibility alias for the segmented API in this release.

`startTurn` validates and reserves synchronously, with native work beginning on the first output
pull. Keep one consumer and one outstanding pull. `request.opened` makes that exact request
answerable before the event reaches the caller; a subsequent waiting observation does not reopen an
answered request. Waiting is nonterminal, and unrelated output can continue. The runtime exposes one
pending request; an adapter may retain a bounded native FIFO when its mapping supports it.

Host decisions must run independently from the output reader. Track their completion and cancellation,
keep reading with per-output backpressure, and join owned work during cleanup. The existing
[session example](examples/run-session.ts) demonstrates this ownership with a signal-aware host
approval callback. Awaiting a person inside the reader would delay the very output this API preserves.

The following `0.4.0` pattern starts an owned answer task without awaiting the human in the output
loop. The host must make `chooseAnswer` observe cancellation. The caller retains the supplied
session if close fails and closes its registry only after session cleanup succeeds.

```ts
import type { AgentRequest, AgentRequestResolution } from '@agen-ai/agent-protocol';
import type {
  AgentProviderOutput, AgentProviderSession, AgentProviderStartTurnInput,
} from '@agen-ai/agent-runtime';

async function runInteractiveTurn(
  session: AgentProviderSession,
  input: AgentProviderStartTurnInput,
  chooseAnswer: (request: AgentRequest, signal: AbortSignal) => Promise<AgentRequestResolution>,
  publish: (output: AgentProviderOutput) => Promise<void>,
): Promise<void> {
  const lifetime = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, lifetime.signal]) : lifetime.signal;
  const answers = new Set<Promise<void>>();
  let answerFailure: { error: unknown } | undefined;
  let operationFailure: { error: unknown } | undefined;
  try {
    const execution = session.startTurn({ ...input, signal }); // Synchronous reservation.
    for await (const output of execution.outputs) { // First pull starts native work.
      await publish(output); // Preserve destination backpressure.
      if (output.kind === 'event' && output.event.type === 'request.opened') {
        const request = output.event.payload.request;
        const answer = (async () => {
          const resolution = await chooseAnswer(request, signal);
          signal.throwIfAborted();
          const receipt = await execution.resolveRequest({ resolution, signal });
          // This small example requires delivery; see the receipt rules below for a UI.
          if (receipt.status !== 'delivered') throw new Error(`Answer ${receipt.status}.`);
        })().catch((error: unknown) => {
          answerFailure ??= { error };
          lifetime.abort(error);
        });
        answers.add(answer);
        void answer.finally(() => answers.delete(answer));
      }
    }
  } catch (error) {
    operationFailure = { error };
  } finally {
    lifetime.abort();
    try { await session.close({ reason: 'shutdown' }); }
    finally { await Promise.all(answers); }
  }
  if (answerFailure) throw answerFailure.error;
  if (operationFailure) throw operationFailure.error;
}
```

Run [`examples/live-request-output.ts`](examples/live-request-output.ts) with
`pnpm examples:live-request-output` after building the public checkout. Its deterministic provider
withholds the answer until the reader observes unrelated progress, then records exact answer
acceptance, later output and terminal settlement on the same reader. It needs no native executable,
account or network. The packed consumer compiles and runs it using the seven matching tarballs.

The closed `AgentRequestResolutionResult` reports:

- `delivered`: the provider-owned handler accepted this exact canonical answer or form step. It does
  not universally prove native transport delivery, model consumption or approved effect completion.
- `rejected`: definitive non-acceptance, with an `AgentError` and required `requestState`.
  `pending` permits another valid answer to that same callback; `unavailable` removes its eligibility.
- `delivery_uncertain`: entry occurred but acceptance cannot be established. The session is unusable;
  retain its output/cleanup owner and never automatically resend.

Malformed, foreign, stale, expired and pre-aborted inputs reject before provider entry with their
precise validation errors. Unexpected provider throws retain `AgentProviderDelegatedOperationError`
with `operation: 'resolve_request'` and started-execution evidence; these also prohibit replay.
An optional synchronous `onProviderExecutionStarted` observer runs after validation and atomic claim,
immediately before the candidate handler. A throwing observer prevents entry. Do not pass an async
observer and treat its unawaited Promise as durable admission.

Handle a local refusal separately from a provider receipt: correct malformed input or an unoffered
choice only while the exact request remains current. A `rejected/pending` receipt permits a fresh
valid answer after current expiry, cancellation and authority checks; it does not authorize blind
resubmission. `rejected/unavailable` removes that request from the UI even if later output is still
running. Neither rejection transfers the reader or proves the turn failed.

Request expiry and cancellation do not prove an answer was accepted. Ordinary answers past
`expiresAt` fail locally; an explicit canonical `canceled` resolution still reaches the handler's
availability checks. Accepted interruption withdraws pending response eligibility, while its status
does not prove native cancellation completed. Keep reading the original execution for that evidence.
Once terminal output is observed, no new response is admitted, even if an earlier answer receipt is
still settling. An older queued waiting event cannot reopen a claimed, canceled or settled request.

An unstarted aborted handle releases its reservation and cannot later start work. Returning an entered
iterator abandons execution; close it before replacement. Interruption requires provider entry;
cancel an unstarted reservation through its signal or iterator return. `AgentProviderTurnInterruptionResult`
contains only status/error information. Interruption acknowledgment is independent from terminal output,
which remains owned by the original stream. Close initiates cancellation before
joining callbacks that need it to settle. Failed cleanup retains the exact retryable owner and any
host-binding lease until native producers quiesce.

This process-local runtime interface change retains Agent Protocol V10. Providers and custom wrappers
must migrate their execution/control ownership together; changing method names alone is insufficient.

## Failures and provider retry observations

Every `AgentError` now requires `category`, `code`, `message` and `recovery`, with optional bounded
`context`. Existing root imports and `parseAgentError`/`safeParseAgentError` remain available; deliberate
schema composition uses `@agen-ai/agent-protocol/zod`. Replace the former `retryable` flag with an
evidence-backed recovery hint: `unknown`, `none`, `retry`, `wait_for_quota` or `user_action`. Use category
`unknown` and `{ kind: 'unknown' }` when the adapter has no stronger evidence. Do not derive a generic
category or recovery action from a native error message alone.

The closed categories are `rate_limited`, `quota_exhausted`, `budget_exhausted`, `execution_limit`,
`context_limit`, `authentication`, `permission`, `invalid_request`, `overloaded`, `transport`, `provider`,
`protocol`, `internal` and `unknown`. Keep allowance exhaustion separate from turn budget and execution
limits. HTTP 429 alone establishes rate limiting. Context contains only optional bounded `operation`,
`component` and `status` fields; raw native payloads and credentials do not belong in the error.

`runtime.retrying` is a nonterminal, turn-scoped observation with `owner: 'provider'` and an `AgentError`.
Its optional one-based `attempt` and `maxAttempts` count retries after the original attempt; omit
unobserved counters and delay. Counters are local to the observed provider retry operation, so separate
operations in one turn may restart at one. `runtime.warning` no longer accepts `retryable`.

Recovery hints and provider retry observations grant no host resend or replay authority. Preserve
definitive rejection, uncertain delivery, session retirement and cleanup ownership separately. A quota
reference must identify observed source, pool and window facts and reuse the existing quota reset shape;
only `rate_limited` and `quota_exhausted` failures may carry it. Historical V9 records need their recorded
decoder; do not reinterpret or rewrite them through the V10 live parser. See the
[protocol README](packages/agent-protocol/README.md) for the closed categories, hints and exact bounds.

### Consumer handling

Keep retry progress, diagnostics and authoritative settlement distinct in the consumer. This handler
uses only public protocol types; its host-supplied view callbacks update presentation without invoking
another turn:

```ts
import type {
  AgentError,
  AgentEvent,
  AgentTurnCompletedPayload,
} from '@agen-ai/agent-protocol';

export function handleTurnEvent(event: AgentEvent, view: {
  retrying(error: AgentError, attempt?: number): void;
  diagnostic(error: AgentError): void;
  settled(result: AgentTurnCompletedPayload): void;
}): void {
  switch (event.type) {
    case 'runtime.retrying':
      view.retrying(event.payload.error, event.payload.attempt);
      break;
    case 'runtime.error':
      view.diagnostic(event.payload.error);
      break;
    case 'turn.completed':
      view.settled(event.payload);
      break;
  }
}
```

Consume the original output stream with per-output backpressure through its true terminal boundary,
including while a request is pending. A retry observation followed by success settles the same turn once. Render
terminal failure from the `turn.completed` result; a preceding diagnostic or failed tool item does not
independently establish another failed turn. Live V10 parsing requires an error for `outcome: 'failed'`
and forbids it on other terminal outcomes.

Use `category` and `recovery` to present the condition or an existing authorized account/configuration
action. An application still owns any later execution decision, including certainty about prior
effects, current authorization and session usability. Do not schedule continuation because a reported
`notBefore` or quota-reset timestamp elapsed. Stream failure, uncertain steering, and post-dispatch
exceptions retain their existing retirement rules even when the cause offers `recovery.kind: 'retry'`.
Let already-entered output settle where possible, then close and rematerialize the unusable session.

Cancellation acceptance does not prove native settlement or producer quiescence. Preserve unresolved
execution as uncertain. If `session.close` fails, retain that session and retry cleanup before releasing
dependent resources. For failed opening cleanup, retain only the exact matching
`AgentProviderSessionCleanupError` and its `retryCleanup()` handle as described below. Never serialize
that handle or treat successful cleanup as permission to replay an unresolved operation.

## Optional managed delegation

`@agen-ai/agent-orchestration` adds bounded host-certified target catalogs and a pure resolver for
developer exclusions and end-user selection. The core packages do not depend on it. Developer
exclusions default empty and user policy defaults disabled. With delegation enabled, omitted selection
chooses all currently available certified standard configurations, including future additions. Fast
requires explicit opt-in, and `max`, `xhigh`, `ultra` or other provider-certified reasoning identities
have no SDK ceiling. An explicit empty selection stays empty. User selection cannot restore an
excluded target; descendant choices also stay within an immutable exact ancestor ceiling. The resolver
does not start sessions or change native subagents. See the
[package README](packages/agent-orchestration/README.md) for host certification, exact source revisions,
unknown semantics and bounds.

An explicitly constructed coordinator now owns managed execution through your validated registry.
Supply current policy and access checks, an execution lease, authorized child resources and exact
configuration attestation. The coordinator applies the selected configuration to its owned child
before the first prompt and rechecks authority at dispatch. A native option label alone does not
certify a model, reasoning level or standard/fast behavior. Catalog/source/account/loading changes
must invalidate stale target references. Parent and shared sessions are not reconfigured.

Scoped clients expose target discovery, spawn, inspection, observation, bounded waits, explicit
steering/queued-next-turn/follow-up modes and cancellation; live request resolution remains host-only.
Task control decisions serialize while output preserves per-event backpressure. A returned uncertain
steering result cannot become a queued or automatically replayed turn. Keep admitted children owned
after the parent turn ends, and close the coordinator before its registry. Failed cleanup retains
the affected leases and resources rather than authorizing owner transfer.

Completion defaults to `collect`, which requires no inbox, including with durable task storage.
Opt into `next_turn` or `automatic` only with a compatible explicit `DelegationParentDeliveryPort`.
Any inbox configured for durable task storage must be durable; the bounded volatile store remains
available for process-local use. The SDK offers a deduplicated completion envelope to
the host inbox, which owns current parent authority and any parent-model dispatch. Acceptance does
not prove execution or consumption. Lost acknowledgments are inspected before retry, and expiry,
revocation or dismissal does not delete the child result. Recovery never replays uncertain child
execution or an uncertain parent dispatch. The explicit `/store-adapter` entrypoint shares atomic
transition rules with host storage adapters; physical capacity and database transactions remain the
adapter's responsibility.

Failed child outcomes now preserve `category`, `code`, `message` and `recovery` through collection,
notification and parent delivery. The parent-visible projection omits error context and quota identity
references; `wait_for_quota` remains meaningful without disclosing a child's account or pool identity.
Recovery hints are data and never authorize another child or parent turn. An exception after observed
dispatch still requires recovery, including when its cause resembles a transient network failure.

The failure projection retains its 2 KiB canonical JSON byte limit. Store adapters now implement
`DelegationStore.contractVersion: 3`; older ports are rejected before managed execution. Request
operations retain exact request identity and independent delivered/rejected/uncertain truth. A rejected
request receipt retains callback availability. Historical `completed` request operations describe the
old continuation boundary and remain unchanged; they cannot restore a live callback.

The optional reference SQLite task database now uses format 3. Its paired parent inbox advances in
the same transaction; the separate ownership database stays at format 1. Ordinary construction never
upgrades retained data. Stop the old application and producers, settle or retire active runs and
outstanding request intents, and resolve claimed notifications and dispatch-intended inbox entries
through the matched old owner. Settled recovery-required results retain their uncertainty.

Format-1 input first requires the explicit failure-contract predecessor migration to format 2.
Then perform the format-2-to-3 migration. From the public repository root:

```sh
# Required only when the retained task database is format 1.
pnpm exec tsx examples/delegation/sqlite/migrate.ts --root /absolute/path/to/store --inbox --target-version=2
# Required for format 2; format 3 is validated and returned as already_current.
pnpm exec tsx examples/delegation/sqlite/migrate.ts --root /absolute/path/to/store --inbox
```

Omit `--inbox` only for a store originally created without the parent inbox. Each step requires
exclusive ownership on the qualified Linux / Node 24.18.0 / SQLite 3.53.1 / filesystem `0xEF53`
tuple, validates through its frozen source decoder and creates a synchronized private sibling backup
including committed WAL pages. The 1-to-2 step adds unknown category/recovery to historical failures
without truncating them. The 2-to-3 step preserves all row values, IDs, timestamps, completion envelopes
and historical receipts unchanged; only the header advances after target validation.

Retain each result's `backupRoot`, `sourceVersion`, `targetVersion`, `storeId`, `sourceDigest` and
`targetDigest`. Repeating a completed step validates its target without rewriting data. A refusal
leaves the source intact. Resolve old authority with its old owner rather than clearing records or
replaying an answer. The predecessor reader refuses format 3. Recovery never reconstructs callbacks
or starts a provider. This public example's local qualification is independent of private Hostd's
Node 22.23.2 / SQLite 3.51.3 release.

Reopen format 3 through the current implementation in a fresh process. Rollback requires all owners
and producers stopped and the complete backup `store/` restored to a different owned directory with
the matched old implementation. Never downgrade new records in place. See the
[durable example instructions](examples/delegation/README.md) for exact backup and refusal behavior.

`createDelegationHostBinding({ client })` exposes `delegation_targets`, `delegate_task`, `task_status`,
`task_send` and `task_cancel` for one trusted scope. Disabled policy returns no binding; enabled but
empty selection still returns tools with a bounded explanation. Model arguments carry durable
UUID operation IDs, not parent identity, policy, executable authority or approval handles. Cached tools
reauthorize every call; disabling new delegation can still leave authorized status/results/cancellation
available. Releasing the binding drains its calls without disposing the coordinator or its children.

The SDK generates internal guidance from actual capabilities. Hosts need no user-facing prompt text
or delegation template. Instruction placement must match adapter support; tool context is not a
trusted system/developer message, and guidance does not enforce policy. Native tools remain independent;
only host-certified actual native tool names may be included in guidance. The optional `/mcp` entrypoint
constructs an owned loopback HTTP bridge over the same handlers when explicitly called. Ordinary imports
open no transport or execution resources.

## Optional session host bindings

The runtime accepts a fresh `AgentSessionHostBinding` on create, resume and branch. Its tools and
instructions are available only when the adapter declares compatible `hostBinding` support.
Absent support means unsupported. Existing adapters and native sub-agent controls retain their
behavior when no binding is supplied.

Hosts own trusted callbacks and must provide idempotent cleanup. Adapters own native tool installation,
name collision checks, truthful instruction placement and producer quiescence. A failed opening with
incomplete native cleanup can retain an `AgentProviderSessionCleanupError`, including openings with
no host binding. `AgentProviderHostBindingCleanupError` remains its compatible binding-specific
subclass. Check ownership with `isAgentProviderSessionCleanupErrorFor(error, originalOpeningInput)`;
an `instanceof` check alone cannot associate a foreign propagated error with this opening. Retain
the trusted error and call `retryCleanup()` before releasing its resources. Opened sessions retry
through `session.close`. Do not treat a failed close as proof that native producers stopped or expose
cleanup handles/diagnostics to a model. See the
[runtime README](packages/agent-runtime/README.md) for schema bounds, pure invocation/result validators,
adapter partial-opening cleanup and lease ownership.

## Provider-neutral boundary

The new ACP packages compose the existing public interfaces. Native session identifiers,
credentials and diagnostics stay within their optional boundary; they do not widen the core
contracts. Provider adapters remain responsible for native translation and credential lifecycle;
the host remains responsible for authorization, containment and durable delivery.

The public dependency chain stays `agent-runtime` to `agent-protocol` to `validation`, with exact
`zod@4.4.3` in the packed protocol and validation packages. Ordinary entrypoints remain
validator-neutral, while deliberate schema composition uses `/zod`.

## Optional ACP transport

`@agen-ai/acp-transport` is a new optional package at source version `0.4.0`, with Ajv `8.17.1` as
its sole runtime dependency. Its root entrypoint exposes the bounded stream client, exact extension
registration, limits, and schema validation. `/client` also exposes typed standard-session operations.
The transport defaults to the preserved ACP v0.11.4 stable/unstable schema identities. Select
`schemaProfile: 'schema-v1.23.0'` explicitly for modern stable v1. Both profiles use protocol
version 1; unsupported profiles and modern unstable selection fail during construction. Optional
methods still require the peer capability and the host's corresponding semantic implementation.
Package-owned generation inputs and upstream Apache-2.0 licensing travel with the standalone source.

`AcpUnknownExtensionPolicy` defines the plain `'reject' | 'standard'` type for the
`unknownExtensionPolicy` constructor option. The type is available from the root
and `/client` entrypoints. Direct transport construction
defaults to `'reject'`. In `'standard'`, unknown `_...` notifications are discarded
and unknown `_...` requests receive `-32601` with the original typed ID. These paths
do not invoke host callbacks or grant execution authority. Known and registered
methods retain exact validation, and all byte, rate, writer and correlation limits
still apply. Responses retain their correlation semantics regardless of payload
content. Required vendor features need explicit mappings; an ignored observation
does not certify a capability.

Adapter owners migrating from a private transport package must replace its import specifier with
`@agen-ai/acp-transport` or the explicit `@agen-ai/acp-transport/client` entrypoint. Import only
exported symbols; internal source/declaration paths and compatibility re-exports are unsupported.
Keep the legacy default when preserving an existing v0.11.4 integration. Selecting the modern
profile is an explicit protocol decision that needs compatible negotiation and mapping, not a
package-name-only migration.

Existing core consumers do not need to install the transport. It does not launch a provider,
install a registry entry, select credentials, or supply product authorization. Adapter owners inject
their streams and retain those responsibilities. Adapter authors may install
`@agen-ai/acp-transport@0.4.0` explicitly.

## Steering lifecycle correction

If a provider returns `{ status: "delivery_uncertain", error }`, the validated session preserves
that receipt and becomes unusable for later mutation. Its original output stream remains owned and
can drain toward terminality. A pending request does not end that reader or restore mutation authority.
Further mutations fail with `session_unusable`; close the session to quiesce work that cannot finish
without another response, and rematerialize before continuing.

The host must preserve the unresolved delivery state. Closing or reopening a session does not prove
that the original input was delivered or rejected. Do not automatically resend the steering text,
convert it into a follow-up turn, or retry a pending action based on that uncertainty.

A definitive `rejected` result remains reusable. Pre-delegation validation failures preserve their
original errors. Provider-invoked steering failures retain existing started-execution evidence.
The former waiting-interruption invalidation in `0.3.1` is superseded by continuous execution ownership:
an accepted interruption keeps terminal output on the original reader. Interruption and steering both
require native entry; a reserved execution has not yet started a provider turn.

## Upgrade checklist

Upgrade the core packages together:

```sh
pnpm add @agen-ai/validation@0.4.0 @agen-ai/agent-protocol@0.4.0 @agen-ai/agent-runtime@0.4.0
```

Install optional packages at that same version only when the application uses their APIs:

```sh
pnpm add @agen-ai/acp-transport@0.4.0 @agen-ai/provider-acp@0.4.0 @agen-ai/acp-registry@0.4.0
pnpm add @agen-ai/agent-orchestration@0.4.0
```

Run the consumer's typecheck and lifecycle tests. Verify that returned steering uncertainty is
shown honestly, the current output stream can settle, and a later action closes and rematerializes
the unusable session without replaying unresolved input. Existing environment and account-quota
ports, capability matching, and per-output backpressure remain required. Keep the original execution
reader through pending requests and true terminal settlement; await delivery receipts separately.
Update all error producers, warning payloads and event consumers for V10; retain frozen readers for
recorded V9 data. Before adopting durable managed storage, migrate the paired task/inbox format and
verify that a failed child remains classified after reopen while uncertain execution stays
`recovery_required` without another provider invocation.

Maintainers validate the governed standalone public projection and packed external consumer before
the separate publication workflow. Preparing or exporting source does not publish packages, create
release tags, submit provenance, promote registry dist-tags, or deploy a private runtime.
For local evaluation now, build the standalone source checkout and run its deterministic workflows:

```sh
pnpm build
pnpm examples:local
pnpm examples:registry
pnpm examples:delegation
pnpm examples:delegation:acp
```

The [managed examples](examples/delegation/README.md) also provide
`pnpm examples:delegation:durable` setup, inspect, restart and cleanup commands. Their SQLite reference
and `pnpm test:examples:durable` crash matrix require the exact qualified Linux/Node/SQLite/filesystem
tuple documented there; the SDK's broader Node support does not qualify other durable environments.
These are SDK host compositions. Product settings, preference persistence, account-aware catalogs and
production provider registration remain application follow-up work.

## Optional ACP provider

`@agen-ai/provider-acp` constructs an ordinary runtime driver from fresh, exclusively leased ACP
connections. Its `/node` entrypoint accepts an explicit executable, arguments, environment and
process working directory. The session working directory remains the existing runtime input.
The built-in launcher supports POSIX process groups and waits for both the owned group and its
streams to close, including descendants left after the leader exits. Windows launch is rejected
before spawn with `acp_provider_process_platform_unsupported`; Windows hosts use the root
`createAcpProviderDriver` API with their own owned connection and process-tree supervisor.
Owned connections are released on close; borrowed connections detach the provider without taking
ownership of the caller's streams. The launcher does not install an agent or provide confinement.

The provider initializes modern stable ACP v1 and fixes one capability envelope for the instance.
It rejects incompatible later connections before session mutation. Once-only permission resolution
continues the original prompt, preserving canonical turn and item identities. Consumers use the
execution-owned answer method and existing session interruption, close and disposal controls. A lost response after
local dispatch never causes automatic replay. Advanced provider capabilities require their own
faithful mapping; schema availability alone does not enable them.

Both the injected-stream provider and `/node` launcher default
`unknownExtensionPolicy` to `'standard'`. Consumers that require the earlier strict
behavior must pass `unknownExtensionPolicy: 'reject'` when constructing the provider.
The option is forwarded to every fresh connection and cannot be changed on a running
session. Close or retain the exact failed cleanup owner before rematerializing;
switching policy never authorizes replay of an uncertain prompt.

Consume the original `execution.outputs` with per-output backpressure through true terminality.
Pass exact answers to `execution.resolveRequest` while that reader remains owned. Its `delivered`
receipt proves local canonical handler acceptance: an ACP intent step can be accepted before the
complete native form is answered. A later transport failure belongs to the original execution and
cannot erase that receipt or authorize replay. Keep the original turn signal/deadline across human
waiting; response deadlines bound only their own operation. Interruption acknowledges dispatch;
only native terminal evidence establishes final settlement.

Managed configuration remains the default. Opt into selectable catalogs at driver construction,
use the documented native-default bootstrap input, then submit exact offered catalog/field
revisions. Native labels do not enable enforced plan mode. Advertised resume restores the exact
binding and suppresses bounded historical replay. Form continuation preserves native accept,
decline and cancel with an intent stage before answers. Inline images, plans, partial file changes
and command observations follow the provider's documented capability envelope.

To mount managed tools through ACP, configure the optional
`sessionMcpBinding: { transport: 'http' | 'sse', create }` factory. Binding support is declared only
when the requested transport was negotiated with the peer. Each create/resume with a host binding
gets a fresh owned MCP lease after initialization and before native session opening; static MCP
servers remain available. A factory can compose `startDelegationMcpBridge` from the explicit
orchestration `/mcp` entrypoint and return its server entry and release callback. That HTTP bridge
uses tool/server context for guidance; ACP setup does not supply trusted system/developer placement.
Negotiated transport and accepted configuration are not proof that a native harness exposes or invokes
tools. Qualify actual discovery and invocation separately, as the deterministic ACP example does.

The explicit [native qualification runner](examples/delegation/native/README.md)
retains earlier Grok `1.0.50` Linux x86_64 evidence for the API-key route, `grok-4.3`, Low
reasoning and an observed default service-tier request mapping. Those immutable version-1 reports
describe the prior continuation API, including direct and fresh-process retained-binary runs.
The current version-2 execution reports require fresh installed qualification; deterministic
source and packed checks do not supply it. Earlier evidence does not qualify the official
script-dependent npm wrapper, browser login, durable native completion or other harness pairings.
Authenticated execution requires an independently pinned candidate and explicit live opt-in.

The provider closes the native connection before releasing its MCP lease; the runtime owns original
binding release afterward. Neither the factory nor bridge calls the provider facade's `release`.
Retain exact opening-cleanup errors and resources on failure, including late factory acquisition after
cancellation. Ending a parent turn does not close its session, release its binding or cancel admitted
children.

Authentication, file and terminal operations require explicit constructor-owned host facilities.
The provider supplies no ambient credential, filesystem or process authority. Dispatched operations
with uncertain outcomes are never automatically replayed. See the
[provider README](packages/provider-acp/README.md) for the capability matrix, exact host contracts,
supported form constraints and operational limits.


## Optional ACP registry

`@agen-ai/acp-registry` exposes bounded catalog parsing, namespaced source identities, deterministic
search and exact platform/distribution selection from its root. A plan binds the accepted snapshot
and entry digests, target, literal launch metadata, exact package resolution, toolchain identities
and installation policy. Agent release versions are opaque catalog identities and never resolve
npm or Python packages implicitly. An expected checksum and a later measured checksum are different
evidence; a top-level package version is not a complete dependency lock.

The root performs no network, filesystem or process operations. Explicit `/node` fetching checks
every redirect against caller-selected trusted origins and bounds time and accepted bytes. It
returns accepted content for caller-owned persistence without automatic stale-cache fallback.

`/node` also implements verified installation, rather than stopping at an inert plan or download:

1. Open an owned store with `openAcpInstallationStore` and retain the approved plan digest
   independently of serialized plan bytes.
2. Deliberately call `store.install` with that digest and approved artifacts. Binary archives/raw
   executables are checked and bounded. npm and uv installation use exact inspected toolchains,
   verified local artifacts, offline package managers and disabled package lifecycle scripts.
3. Persist the receipt's exact installation identity and acquire a reference before `resolveLaunch`.
   Launch revalidates the complete retained payload and toolchain entries; it never invokes `npx`,
   `uvx`, a latest resolver or an implicit download.
4. Pass the explicit launch recipe to the provider, retain the reference through every session and
   native process, then release it only after successful cleanup. Failed startup or cleanup retains
   the reference until the host establishes process quiescence. Removal and interrupted-install
   recovery are separate operations with exact ownership requirements.

An installation receipt does not change a plan's `verified: false` declaration or erase missing
expected integrity/dependency-lock gaps. Hashes do not authenticate a publisher, entry hashes do
not attest an entire Node/Python installation, and offline flags do not create OS confinement.
Python source builds, package scripts and unqualified dependency shapes fail explicitly. The
six accepted catalog targets are metadata identities, not qualification of every native platform.
Catalog metadata and successful verification grant no credential or execution authority.

The accepted `published-v1` registry profile is based on commit
`7f9be29696108572a2bca70e0563af528073a0c3`; it accepts complete `version: '1.0.0'` catalogs and
the documented empty `extensions` exception. Agent release identities remain distinct from exact
package resolution. See the [registry README](packages/acp-registry/README.md) for policy, supported
locks, installers, recovery and resource limits, and
[`examples/registry-install-run.ts`](examples/registry-install-run.ts) for the complete synthetic path.
