# Upgrading to Agent Protocol V14

Agent Protocol V14 separates token consumption from context occupancy. Coordinated `0.4.14`
introduces fourteen packages and V14; the preceding `0.4.13` is the ten-package V13 release.
Build and install the complete package family at `0.4.14`; V13 and V14 packages do not interoperate.
See [UPGRADING-TO-0.4.14.md](UPGRADING-TO-0.4.14.md) for the permission-policy and provider additions.

## What changed

| Agent Protocol V13 | Agent Protocol V14 |
| --- | --- |
| `context.usage.updated` payload has optional `cumulative` counters | Occupancy only: `measurementScope`, `usedTokens`, `maxTokens`, optional `compaction` |
| `capabilities.context.usage` lists `cumulativeFields` | Lists only `measurementScopes` |
| No consumption event | `usage.observed`, carrying one `AgentTokenUsageObservation` |
| No consumption capability | Required `capabilities.tokenUsage`: `unsupported`, or one to four declared views |
| Collaboration usage `{ kind: 'reported', inputTokens?, ... }` | `{ kind: 'unavailable' }` or `{ kind: 'reference', scopeId }` naming an admitted usage scope |
| Serialized `protocolVersion: 13` | `protocolVersion: 14`; the live parser rejects every other version |

New public entrypoints are `@agen-ai/agent-protocol/usage` (types, constants, parsers) and
`@agen-ai/agent-runtime/usage` (the optional pure reducer and pending buffer). The runtime adds
six contract error codes: `usage_invalid`, `usage_identity_conflict`, `usage_scope_mismatch`,
`usage_counter_regression`, `usage_sequence_invalid` and `usage_capacity_exceeded`.

## Read consumption from `usage.observed`

V13 consumers often read totals from occupancy samples:

```ts
// Agent Protocol V13
if (event.type === 'context.usage.updated') {
  inputTokens = event.payload.cumulative?.inputTokens ?? 0;
}
```

V14 has no such field. Admit usage events from the same turn reader into a ledger and summarize
one view:

```ts
import { admitTokenUsageEvent, createTokenUsageLedger, summarizeTokenUsageView } from '@agen-ai/agent-runtime/usage';

let ledger = createTokenUsageLedger({ sessionId });
for await (const output of execution.outputs) {
  if (output.kind !== 'event' || output.event.type !== 'usage.observed') continue;
  const admission = admitTokenUsageEvent(ledger, output.event);
  if (admission.status === 'rejected') throw new Error(admission.code);
  ledger = admission.ledger;
}

const usage = instance.capabilities.tokenUsage;
const view = usage.kind === 'supported'
  ? usage.views.find((declared) => declared.view.authority === 'authoritative')
  : undefined;
const summary = view === undefined ? undefined : summarizeTokenUsageView(ledger, view.view.viewId);
// summary === undefined: nothing was admitted for that view. It is not zero.
```

Keep these rules when migrating:

- Read each counter's `kind`. `exact` 0 is a measured zero; `at_least` is a lower bound;
  `unavailable` is unmeasured. Never replace a missing value with 0.
- Pick one view. Authoritative and detail views overlap and are never added together.
- Do not add snapshots. A snapshot replaces earlier revisions of its scope. Deltas and fresh-zero
  snapshots measure `newWork` directly. Historical snapshots require an exact, comparable baseline
  before subtraction; an unknown origin leaves new work unavailable. A lower bound of 400 followed by an exact 1000 does not establish
  600 new tokens.
- Do not build a whole-session total from per-turn details or a parent plus its children.
- The envelope `turnId` is the delivery turn. The payload `scope` is the measured work, which can
  be an earlier turn, the session or a materialization.
- `finality: 'open'` is a checkpoint; the series continues on a later turn. Only `final` settles a
  scope. A completed turn, a successful close or silence is not a final total or a zero.
- Usage arrives only on `execution.outputs` and an owned operation's `onOutput`. There is no
  session usage reader, and `close()` returns nothing.
- A completed turn with unavailable usage is still completed. Invalid usage fails through the
  provider contract error and the session's cleanup owner, as other contract failures do.

The [usage example](examples/usage/README.md) runs these cases through installed entrypoints.

## Update exhaustive code

- Add `usage.observed` to switches over `AgentEvent['type']`.
- Add `tokenUsage` to capability literals and capability-driven UI or routing.
- Replace collaboration `reported` handling with `reference` and `unavailable`.
- Add the six `usage_*` codes to switches over `AgentProviderContractErrorCode`.
- Remove references to `AgentContextCumulativeUsage`, `cumulative` and `cumulativeFields`.

## Update a custom driver

A driver that reports no consumption declares `tokenUsage: { kind: 'unsupported' }` and removes
`cumulative` from its occupancy samples and `cumulativeFields` from its capability. Do not move
old cumulative counters into `usage.observed` without the scope, identity, origin and coverage
facts the native source actually establishes.

A driver that reports consumption declares each view with its scope kind, `reportedCounters` and
attribution kinds, then emits observations on the active turn reader between `turn.started` and
the terminal event, or through an operation's `onOutput`. Retain opening, resume and between-turn
observations with `createTokenUsagePendingBuffer` and drain them onto the next output path.
Configuration selection results cannot carry usage. Parse native data once at the driver
boundary: documented missing values become `unavailable` or `at_least` with closed reasons,
while malformed, foreign or contradictory data is a contract violation. The
[runtime README](packages/agent-runtime/README.md) lists the admission rules and bounds, and the
example's synthetic provider shows a minimal declaration.

## Stored history

V13 serialized values remain valid history but are rejected by the V14 parser. Decode them with
the published `0.4.13` packages or your own frozen decoder, keep their original bytes, and do not
translate V13 cumulative or collaboration counters into V14 observations. Those values carry no
scope, identity or origin, so summing them with V14 usage would double count.

## Provider coverage

| Composition | Token usage in this candidate |
| --- | --- |
| Generic ACP (`@agen-ai/provider-acp`) | Unsupported. Occupancy and cost updates are not consumption. |
| Owned Claude 0.3.322 / Code 2.1.322 (`@agen-ai/provider-claude`) | Supported; see its [README](packages/provider-claude/README.md#token-usage). |
| Owned OpenCode 2.2.7, Anthropic and OpenAI routes (`@agen-ai/provider-opencode`) | Supported; see its [README](packages/provider-opencode/README.md#token-usage). |
| Controlled Grok 1.0.77 (`@agen-ai/provider-grok`) | Supported; see the [ACP mapping](packages/provider-acp/README.md#controlled-grok-prompt-token-usage). |
| Raw sandbox CLI recipes for Claude Agent SDK 0.3.273, Codex 0.163.0 `exec`, Cursor 2026.10.22-27dcf5f, Grok 1.0.62 and OpenCode 2.1.2 | Deferred. They expose raw native output and emit no `usage.observed`. |

Deferred recipe support is a delivery decision, not a claim that those native CLIs lack usage
counters. AgenAI's private host adapters for Codex and Cursor do not add public Codex or Cursor
drivers or change those recipes. The supported rows passed installed native qualification on
Linux x64 and native-arm64 Docker Desktop; each README states its exact limits.

The private monorepo's matching host protocol and workspace event projections changed in source
only. Nothing has been deployed.
