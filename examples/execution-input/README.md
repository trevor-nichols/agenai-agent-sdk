# Input during an owned execution

This hermetic example teaches the optional provider-neutral runtime contract using a
**caller-owned teaching provider**. It invokes the actual exported runtime validator.
It uses no native process, model, credentials, network, tools, or storage. Its JSON
evidence is explicitly `synthetic`; success qualifies no native provider mapping.

The unpublished ten-package 0.4.4 candidate ships **no public native provider with
execution-input support**.
All public ACP/Grok compositions remain unsupported. The separately controlled
private Claude SDK 0.3.309 / Code 2.1.309 diagnostic mapping has exact Linux x86_64 /
Node 24.18.0 qualification; there is no public Claude execution constructor in this
example or SDK package inventory. Its evidence does not qualify subscription login,
production deployment or billing. The optional input domain adds no package or
Agent Protocol V13 / Host Protocol V26 change. See the
[candidate upgrade guide](../../UPGRADING-TO-0.4.4.md#optional-input-on-an-owned-execution).

From the public SDK checkout, after installing and building its dependencies:

```sh
pnpm exec tsx examples/execution-input/main.ts
```

The program prints one JSON object with five scenario records: accepted and consumed,
accepted with consumption unconfirmed, definite native rejection, uncertain delivery,
and unsupported input. Every record checks the exact original output, one caller
turn, one output reader, the expected zero or one submission, and joined session and
instance cleanup. The uncertain case also checks that the runtime refuses further
mutation before another provider dispatch.

`application.ts` contains the reusable caller flow. It starts the sole output reader
first, waits for `turn.started`, then narrows `execution.input?.kind === 'supported'`.
Absence and `{ kind: 'unsupported' }` both mean unsupported. It keeps that reader
running while it awaits both `sendMessage()` and any accepted
receipt's `settled` promise. The teaching provider deliberately needs output progress
to release those observations; replacing the reader with either wait stalls and fails
the bounded example. The returned flow exposes both `result` and `joined` so the caller
retains explicit reader ownership on exceptional paths. `main.ts` owns opening and
cleanup and exports `runExecutionInputExample()` without running it on import.
`teaching-provider.ts` owns the synthetic provider semantics; applications should supply their deliberately
selected provider rather than copy a fixture as native implementation.

An accepted receipt confirms admission of that exact message. It does not establish
consumption, obedience, or execution completion. A `consumed` settlement attributes
the message to the original native command or an owned native continuation of the
same SDK execution. The contract is `current_or_owned_continuation`; it is broader
than strict current-command steering and leaves the existing `turns.steer` contract
unchanged. An `unconfirmed` settlement preserves the accepted receipt while stating
why consumption cannot be confirmed. A provider that cannot report consumption
declares `consumptionReporting: 'unavailable'` and returns that explicit reason.

A definite `rejected` receipt states non-admission. `delivery_uncertain` states that
delivery might have happened. The runtime fences further mutation while the original
reader remains available. Never replay an uncertain instruction, create a fallback
turn, steer, or interrupt to simulate delivery. Close and retain cleanup ownership;
opening a fresh session does not make resubmitting an uncertain message safe.

Execution input accepts text only and uses a freshly parsed, unique
`AgentExecutionInputMessageId` for every submission. IDs are retained in the bounded
session-generation census even after settlement; they are separate from turn and
human-request IDs. Respect the provider's declared outstanding-message, per-execution,
and retained-byte limits. SDK ceilings are two outstanding messages, sixteen entered
messages per execution and 1 MiB of buffered UTF-8 envelopes, with canonical turn-content
limits on every message. The separate session-generation census retains at most
4,096 IDs and 1 MiB of ID bytes. This fixture deliberately lowers its execution limits
to one message and 4 KiB. There is no idle-session input method: use ordinary `startTurn()`
when idle. Sending before reader entry, after terminality, through an old execution,
during a human request or its unresolved response, or on a schema-bound execution
fails before provider entry. Pre-entry validation, abort, and capacity errors preserve
their existing error classification; a provider-invoked failure can instead carry
`AgentProviderDelegatedOperationError` evidence and requires conservative cleanup.

The owner closes the session, joins the public output reader, then disposes the instance,
using a fresh cleanup signal even after input uncertainty. If cleanup fails, keep the process-local
`ExecutionInputExampleCleanupError` and its `retryCleanup()` closure until cleanup
succeeds. Never persist that closure or use a cleanup retry to replay input. The
five-second orchestration bounds detect a stalled example; elapsed time never proves
native completion or producer quiescence.

The installed public-package check separately exercises actual packed ACP constructors
against a synthetic serialized peer. Its six cases cover generic ACP, Grok input
advertisements and the selected Grok 1.0.62 structured-output mapping, each with owned
and borrowed connections. All six preserve one original turn/reader, dispatch zero
native input requests and join cleanup. Stable ACP negotiation or a native extension
name grants no execution-input support. These unsupported cases are separate from
the five neutral teaching scenarios and private Claude's native qualification.
