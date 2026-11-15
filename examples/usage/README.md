# Token usage accounting

This hermetic example walks through the Agent Protocol V14 token-usage contract
using only installed public entrypoints: `@agen-ai/agent-protocol`,
`@agen-ai/agent-protocol/usage`, `@agen-ai/agent-runtime` and `@agen-ai/agent-runtime/usage`.
It uses no native process, model, credentials, network, tools or storage. Its JSON evidence is
explicitly `synthetic`; success qualifies no native provider mapping.

Use coordinated package version 0.4.14. The preceding 0.4.13 release implements Agent Protocol V13,
which has no `usage.observed` event or `tokenUsage` capability. Read
[UPGRADING-TO-AGENT14.md](../../UPGRADING-TO-AGENT14.md) for the migration.

From the public SDK checkout, after installing and building its dependencies:

```sh
pnpm examples:usage
```

The program prints one JSON object with eleven scenarios. Each record states a representative
outcome; the runtime test suite owns the complete arithmetic corpus.

| Scenario | Shows |
| --- | --- |
| `no_measurement` | An empty ledger has no summary. An explicit unavailable measurement stays unavailable rather than zero. |
| `inclusive_subdivisions` | Disjoint native buckets compose an inclusive input total. Unreported subdivisions stay unavailable. |
| `partial_reasoning` | Exact output 100 keeps reasoning at least 7. No exact visible-output residual exists. |
| `stable_history` | Comparable exact historical snapshots 400/40 then 600/60 establish new work 200/20. |
| `duplicate_replay` | The identical record delivered again is a duplicate returning the same ledger. Changed content under that identity is rejected. |
| `unknown_baseline` | An unknown origin, or an unknown comparison for one counter, keeps the total but disables subtraction. |
| `historical_backfill` | A lower bound of 400 followed by a complete 1000 improves the total without establishing 600 new tokens. |
| `continuing_checkpoints` | Open session checkpoints delivered on different turns advance one series until a final observation settles it. |
| `parent_and_child` | An authoritative turn total of 1000 and a contained call detail of 300 are separate views, never summed. |
| `equal_deltas` | Two distinct calls with equal 200/20 deltas add to 400/40. |
| `unavailable_on_success` | A validated session completes successfully while reporting usage as legitimately unavailable. |

## Reading the results

- `exact` is a complete count, and `exact` zero is a measured zero.
- `at_least` is a bounded lower bound with reasons.
- `unavailable` means unmeasured, with reasons. `['unsupported']` appears only when the view
  never reports that counter.
- `total` is what the selected view covers. `newWork` is what the admitted observations establish
  as newly consumed. Deltas and fresh-zero snapshots measure new work directly; historical
  snapshots require an exact, comparable baseline before subtraction.
- Summaries are per view. Authoritative and detail views overlap by design, so the caller selects
  one view and never adds views together.
- Silence, or a session close with no report, is no measurement. It is not a known zero.

The `usage.observed` envelope `turnId` is the delivery path. The payload scope names the
accounted work, which may span several turns. `lifecycle.ts` shows an application reading the
sole validated turn output, admitting usage into its own ledger, persisting the delivered events
as JSON and rebuilding an identical summary. The turn's `completed` outcome is the native outcome;
unavailable usage does not change it.

## Contract failures

The example does not exercise rejected input through a provider. Inside a validated session,
malformed, foreign, conflicting, regressing or over-bound usage is not converted to unavailable:
it fails with a `usage_*` contract error and the session's existing cleanup owner, as described in
the [runtime README](../../packages/agent-runtime/README.md). The `duplicate_replay` scenario shows
the pure reducer returning `usage_identity_conflict` as data.

## Native providers

This example starts no native provider. With a supported constructor, apply the same reader from
`lifecycle.ts` to that provider's sessions and select one of its declared views. Prerequisites,
views and qualification limits are in the [Claude](../../packages/provider-claude/README.md#token-usage),
[OpenCode](../../packages/provider-opencode/README.md#token-usage) and
[controlled Grok](../../packages/provider-acp/README.md#controlled-grok-prompt-token-usage) READMEs.
Those constructors passed installed native qualification on Linux x64 and native-arm64 Docker
Desktop. Generic ACP declares token usage unsupported.

The public raw sandbox CLI recipes for Claude Agent SDK 0.3.273, Codex 0.163.0 `exec`, Cursor
2026.10.22-27dcf5f, Grok 1.0.62 and OpenCode 2.1.2 do not emit normalized token-usage telemetry.
That delivery is deferred; it is not a claim that those native CLIs lack usage counters, and
nothing in this example implies a capability for those recipes.
