# Migrating to 0.4.2

`0.4.2` is the coordinated published release for all seven SDK packages and Agent
Protocol V12. npm `latest` and `beta` select this release. Keep the installed package
family at one version. Publication and passing synthetic examples do not expand
a native provider's qualification. The published `0.4.1` artifacts and their original qualification remain
unchanged. Upgrades from earlier versions also need the
[0.4.1 guide](MIGRATING-TO-0.4.1.md) and [0.4 guide](MIGRATING-TO-0.4.md).

The complete source/release set is `@agen-ai/validation`, `@agen-ai/agent-protocol`,
`@agen-ai/agent-runtime`, `@agen-ai/agent-orchestration`, `@agen-ai/acp-transport`,
`@agen-ai/provider-acp` and `@agen-ai/acp-registry`, all at `0.4.2`. An application
installs only the packages it needs, with one matching version across its installed
family. Source release admission requires the complete matching seven-archive set.
Agent Protocol V12 is the serialized contract version, independently of the package
version and private Host/storage versions. Private V25 remains undeployed.

## Handle request withdrawal on the original output reader

Update current protocol envelopes to `protocolVersion: 12`. Current parsers reject
V11 envelopes; retained history needs its original version's decoder. Do not
rewrite a historical version field to make it pass the current parser.

Handle `request.unavailable` as the end of answer eligibility for its exact
request ID. Remove that request's controls and cancel its presentation work.
Continue consuming the same execution's `outputs`: the event does not end the
turn, interrupt unrelated work, submit a denial, or invalidate a later request.
An application must keep output reading independent of human decisions and
`resolveRequest` delivery receipts.

An answer may already have entered when its request becomes unavailable. Retain
the original answer operation and its final receipt. A late `delivered` receipt
still means delivered; a late `rejected` receipt with `requestState: 'pending'`
does not restore a canonically retired request. An uncertain receipt remains
uncertain and must not be replayed. Render availability and delivery as separate
facts instead of replacing one with the other.

The executable [live request example](examples/live-request-output.ts) lets A
remain unanswered, observes A's withdrawal, answers B once, and completes through
the original reader. It records candidate answer entries and joins the actual
producer and request handlers during cleanup.

Keep local errors distinct from receipts. A malformed or pre-aborted answer fails
before native entry. A retired/stale/wrong-kind/duplicate turn answer rejects with
`AgentProviderContractError` / `request_resolution_mismatch`; it does not manufacture
a native delivery receipt. Session response parsing rejects mismatched offered
actions, form values and plan revisions locally; a retired session handle retains
its existing rejected/unavailable result. Returned delivery receipts use `delivered`,
`rejected` with an explicit request state, or `delivery_uncertain`. After provider
entry, a turn execution's `resolveRequest` can instead throw
`AgentProviderDelegatedOperationError` with `operation: 'resolve_request'` and
`providerExecution: 'started'` if the candidate fails or its returned receipt fails
validation. That failure retains uncertainty and fences session mutation. Keep the
original output reader and cleanup owner, close the session, and never replay the
answer. A rejected promise alone therefore does not establish pre-entry failure.
Only a definitive pending rejection while the same request remains live permits
a fresh answer. Neither cleanup nor a terminal proves that an uncertain answer
was refused.

## Preserve bounded FIFO and callback ownership

The public turn execution exposes one answerable request at a time. The adapter
may retain multiple real native callbacks under a bounded FIFO. Exact withdrawal
of the displayed request must retire it before the next surviving request opens;
withdrawal of a queued callback removes it without displaying it. Keep unrelated
output flowing while the active request waits. Do not reorder prompts, synthesize
denials or add concurrent public answering to avoid the queue.

The selected ACP lifecycle profile permits at most `min(maxPendingRequests, 16)`
retained native callbacks and 1 MiB of request material within the existing shared
session queue. Lower configured limits win. Queued, displayed, response-entered
and cancelled callbacks all count until actual transport settlement and entered
host work finish. Generic ACP configuration still accepts 1–256 pending requests,
default 16; it does not advertise 256 selected lifecycle callbacks. The existing
default output budget remains 128 messages / 8 MiB. Capacity exhaustion is an
owned integration failure, with cleanup and no fabricated human choice.

All turn/session requests share a session-generation census of 4,096 IDs and
1 MiB of UTF-8 ID bytes. Retired IDs cannot be reused or evicted to admit new work.
Exhaustion fences mutation and initiates owned cleanup.

## Narrow and tag session responses

Session interactions now have three closed request kinds: `decision`, `form`,
and `plan_review`. Narrow `interaction.request.kind` before accessing kind-specific
fields and return the matching tagged response. An existing decision response
must change from `{ choiceId }` to `{ kind: 'decision', choiceId }`.

For a form, use the exact offered submit or cancel action, choice ID and typed
answers. For a plan review, return the exact offered action and the displayed
plan identity and revision. Revision feedback belongs only to its offered revise
action. A label that says "approve" is not authority to substitute a choice,
revision or action. The accepted terminal deliberately omits submitted form
values and revision feedback.

Install `interactions.onRequest` before opening the session. A returned opening
does not mean every setup question has ended. A handler can retain its bound
handle and return immediately, or keep signal-aware presentation work pending.
Observe both the request's terminal and its independent answer receipt. An
aborted presentation signal does not establish callback settlement.

## Own native continuation output before answering

A session response can start native work without a new caller prompt. Install
`nativeContinuations.onExecution` before opening whenever the selected adapter
and response support that behavior. Immediately consume the supplied ordinary
execution. The runtime requires an actual pending iterator `next()` before it
dispatches the work-starting answer; retaining the handle or merely obtaining an
iterator is insufficient.

Caller turns and native continuations share one admission slot. Do not call
`startTurn` to make a continuation run. Preserve the response receipt and the
continuation outcome independently: delivery alone does not prove work started.
An offered abandonment can settle with no execution at all. If preparation or
reader admission fails before dispatch, no native answer is sent; after dispatch,
uncertain work retains its original output and cleanup owner.

Application openings use `AgentCreateSessionInput`, `AgentResumeSessionInput` and
`AgentBranchSessionInput`; validated adapters expose those host-facing contracts.
Adapter authors keep the candidate `AgentProvider*SessionInput` types and their
provider publication context separate. Exact support declarations identify opening
operation, request kind and continuation timing (`after_open_return`,
`before_open_return` or `before_binding`). No support is inferred from a method
name, a restored flag or an earlier session descriptor.

Support is explicit. Inspect session request kinds, human-wait modes and exact
continuation combinations of opening operation, request kind and timing. Missing
support is unsupported. Create support does not imply resume or branch, and a
core form example does not establish a native provider's form capability.

The core-only [session continuation example](examples/session-continuations.ts)
demonstrates a typed form, an active output reader, a no-work plan abandonment,
unsupported configuration and owned cleanup. The optional
[ACP counterpart](examples/session-continuations-acp.ts) composes the selected
Node provider mapping with a controlled executable peer. Its recorded native
frames prove that this example sends no extra prompt. Both examples are synthetic.

## Separate human waiting from operational deadlines

Omitting `humanWait`, or selecting `{ kind: 'bounded' }`, keeps the five-minute
default and thirty-minute ceiling. An explicitly supporting adapter accepts
`humanWait: { kind: 'until_withdrawn_or_closed' }` to omit the SDK human timer.
Do not also set `limits.requestTimeoutMs` in that mode.

Use the handle's effective `deadline` to display a host/provider deadline or
`{ kind: 'no_deadline' }`. Provider expiry, opening association, preparation,
response observation, cleanup deadlines and retained-work limits still apply.
An SDK human-wait timeout is not a declined answer. The integrated continuation
example demonstrates the policy without a long sleep or a special test clock.

The effective deadline is fixed once when the validated offer is admitted; queue
residence, UI delay and retry do not restart it. Genuine provider expiry wins a tie
with host policy and stays unchanged in the descriptor. No provider-local expiry
survival mapping is qualified here, so expiry retains conservative owned shutdown.
Session descriptor retention defaults to 8 requests / 524,288 bytes, configurable
to 1–32 / 65,536–2,097,152 bytes. One request is at most 65,536 UTF-8 bytes, a decision
response 1,024 bytes and a form/review response 65,536 bytes. Response material is
separately bounded per unsettled attempt. Preparation/reader readiness has one
fixed 30-second window; response/start observation and cleanup each default to
30 seconds with 1–120 second overrides. A terminal-but-unjoined owner still counts.

## Upgrade orchestration stores to contract 4

An external delegation store must implement contract 4 before it can participate
in managed execution. Changing its numeric declaration alone is insufficient:
retiring A must make the surviving run eligible for B, and an already entered A
answer must settle independently without changing B's current request. Duplicate
operations keep their original receipts. Use the explicit `/store-adapter`
transition planner to keep these mutations consistent.

The public SQLite reference retains physical format 3. Its SQL layout, persisted
record shapes and settled history meanings are unchanged; there is no format
3-to-4 migration. Existing format 1/2 offline migrations retain their original
scope. The reference's exact platform qualification remains separate from the
packages' Node.js 22 minimum. Reopening history never recreates a callback or
automatically replays an answer.

## Keep cleanup ownership after presentation ends

Begin `session.close()` before joining work that needs native shutdown to settle.
Keep the original output reader, entered responses and actual callback promises
owned until they drain. Only release the session's process, installation or host
resources after successful native cleanup. A callback ignoring its abort signal
still counts as retained work.

A failed close retains its stopped session for cleanup retry. A failed opening
can retain its exact cleanup error and `retryCleanup()` owner. Preserve that live
owner; do not serialize it, create a replacement session to stand in for cleanup,
or dispose the enclosing registry while its resources remain owned.

Adapter authors must keep the consumer handler distinct from the provider's
request-publication port, `AgentProviderSessionInteractionContext.onRequest`,
and provide effect-free staged preparation for
responses that can continue work. The [runtime contract](packages/agent-runtime/README.md)
describes those ports and their ordering. Conformance's `resolutionFor` callback
also accepts asynchronous decisions or `undefined` for a deliberate non-answer;
its request-scoped signal lets presentation work stop while output reading
continues.

Direct ACP handler integrations also account for the required
`AcpReverseRequestContext.settled` promise. It observes actual reverse-handler and
entered response-write settlement, independently of caller-visible write rejection
or cancellation. A handler must not await its own settlement inside itself, and
an integration must not substitute an already-resolved promise while native work
is still retained.

## Select only the qualified native composition

Final installed-native qualification covers 15 selected cases on the exact MS009
r3 seven-package candidate. It uses Linux x86_64 / Node 24.18.0, genuine vendor
executables, isolated scripted model responses and a constant fake credential.
This proves the selected native/SDK lifecycle; it proves no real backend
authentication, inference or billing. Later archive changes require an explicit
applicability comparison or affected native reproof.

| Native composition | Qualified scope | Limits that remain explicit |
| --- | --- | --- |
| Grok Build 1.0.60; modern stable `schema-v1.23.0`; explicit `grok-build-1.0.60-session-requests-v1`; owned Node boundary | Initialization, active A withdrawal with zero A answers and later B once-only effect, a 250 ms human wait, genuine parked-state preparation and fresh retained approve/revise/abandon | Review support is only `resume / plan_review / after_open_return`. Approve/revise produce owned continuation output without caller `startTurn`; abandon starts no continuation during bounded observation. Simultaneous live Grok callbacks into the SDK FIFO queue remain unqualified under the accepted amendment. |
| Claude Agent SDK 0.3.301 / Claude Code 2.1.301; diagnostic adapter using the installed public runtime | Initialization, gateway completion, active/background withdrawal, finite FIFO/queued withdrawal, survivor effects and final authoritative idle | No public Claude provider package or private pin upgrade follows. The original external application's missing-idle report is a separate integration concern. |
| Grok Build 1.0.50; historical trust/remembrance regression | Exact trust/edit/covered-repeat/uncovered-terminal effects and fresh-process reapproval | Original launch settings remain unchanged. Preparation records five task-limit events/warnings at the 64-task ceiling. Actions complete, but capacity headroom, arbitrary external commands, remembrance duration, denial and revocation are unqualified. |

The exact executable SHA-256 values are:

- Grok Build 1.0.60: `10e6af64b24724fc1074c373e906b9ad121110044dddcbd97ad43c3a25f96d5f`.
- Claude Code 2.1.301: `bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222`.
- Grok Build 1.0.50: `c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5`.

The selected current Grok environment explicitly sets `GROK_AUTO_WAKE=0`,
`GROK_WORKER_THREADS=1`, `GROK_SUBAGENT_WORKER_THREADS=1` and
`GROK_GIX_STATUS_THREADS=1`. Automatic parent wake remains unqualified. Native
permission forwarding is observed to serialize; native child pending metadata
does not create an SDK callback owner. Generic controlled ACP FIFO and actual
Claude FIFO remain separately qualified. The 250 ms native wait does not prove
arbitrary duration; controlled runtime time tests establish absence of the SDK
human timer independently.

Every selected case observes first successful SDK session close and an independently
empty original workload while the consumer remains alive, before disposal.
Failed and superseded native attempts retain their exact source, archives and
verdicts. Their external recovery cannot become successful SDK-close evidence.
Outside-turn native forms, create/branch reviews, other continuation timing,
provider-local expiry survival, browser login, durable native recovery, other
pairings/platforms and private Hostd/fleet execution remain unsupported or unqualified.
Existing folder-trust, remembered-edit and older publication evidence retain their
original exact scope.

The host application still owns UI presentation, authorization, response persistence,
historical replay and its own provider composition/end-to-end qualification. The
generic SDK04/R1–R3 changes do not close separate executed-model or source/state/cleanup
investigations in that application. Publication also does not complete that integration.

## Validate the installed composition

From the standalone source repository, build before running the examples:

```sh
pnpm build
pnpm examples:live-request-output
pnpm examples:session-continuations
pnpm examples:session-continuations:acp
pnpm check
```

These checks use public entrypoints, exact package versions and controlled
fixtures. Select native mappings only within their separately documented
qualification. The SDK adds no product-specific authorization, permission
database, persisted callback authority or implicit provider upgrade.
