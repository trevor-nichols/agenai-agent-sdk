# @agen-ai/provider-claude

Owned Claude Agent SDK driver for the AgenAI coding-agent runtime on Linux. It drives exactly
Claude Agent SDK `0.3.322` with Claude Code `2.1.322`, replaces every native tool with the seven
owned tools from [`@agen-ai/provider-tools`](../provider-tools/README.md), and supports the `host`
and `provider_accept_edits` approval policies. This optional package is introduced in coordinated `0.4.14` with Agent Protocol V14.

The package root exports only constants and plain option types. Importing it reads no credentials
and acquires nothing. The driver constructor requires the explicit `@agen-ai/provider-claude/node`
entrypoint.

## Usage

```ts
import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { createNodeClaudeProviderDriver } from '@agen-ai/provider-claude/node';
import { prepareNodeProviderWorkspace } from '@agen-ai/provider-tools/node';

const workspace = await prepareNodeProviderWorkspace({ directory: '/absolute/owned-store' });
const driver = createNodeClaudeProviderDriver({
  executablePath: '/absolute/claude', // Claude Code 2.1.322 bytes matching this package's pin
  credential: { kind: 'api_key', value: apiKey },
  usageLimits: { maxBudgetUsdPerSession: 1 },
  tools: {
    workspace,
    stateParentDirectory: '/absolute/private-state-parent',
    bubblewrapPath: '/usr/bin/bwrap',
    filesystemHelperPath: '/absolute/agenai-sandbox-files',
    restrictions: { denyRead: ['.env', 'secrets/**'] },
  },
});
const registry = await createAgentProviderRegistry({
  drivers: [driver],
  definitions: [{ providerKey: 'claude', instanceId, driverConfiguration: { model: 'claude-sonnet-5-5' } }],
});
const session = await registry.requireInstance(instanceId).adapter.createSession({
  sessionId, workingDirectory: workspace.workspaceDirectory,
  configuration: { kind: 'managed', revision }, approvalPolicy: { kind: 'provider_accept_edits' },
  onBindingCreated, signal,
});
```

`driverConfiguration` accepts only `{ model }`. The credential, executable, endpoint and
containment are factory options and never pass through runtime configuration. `apiBaseUrl`
defaults to the Anthropic API; it must be HTTPS, or HTTP on a loopback address, without embedded
credentials. The credential route is an explicitly supplied Anthropic API key; saved logins and refresh flows
are not supported. The key is never discovered from the environment.

`usageLimits.maxBudgetUsdPerSession` (positive, at most 1000) passes Claude Code's `maxBudgetUsd`.
It bounds the estimated cost Claude Code accumulates across the session's query, not an invoice. A
turn that reaches it fails with `execution_limit` code `claude_max_budget_usd`. The turn bound is
fixed at 32.

## What a session supports

Each driver materializes one instance bound to one prepared workspace. An instance has one live
session and each session has one active text turn. Sequential turns and a fresh session after
successful close are supported. Sessions are created fresh; resume, branch,
native agents, application MCP servers, steering, structured output and non-text input report
unsupported. Turns can be interrupted. Approvals are once-only and scoped to the exact action;
there are no remembered grants.

Every owned tool call that reaches the broker ends in exactly one item. When the tools refuse a call
themselves, the turn also emits a `provider.diagnostic` with code `owned_tool_refused` whose context
holds the tool (`operation`) and the category (`status`: `invalid_input`, `outside_workspace`,
`restricted` or `unavailable`). Its message and the item summary are fixed text; neither repeats the
model's input. Host denials carry no category.

| Policy | Edits | Commands |
| --- | --- | --- |
| `host` | Every edit waits for the host. | Every command waits for the host. |
| `provider_accept_edits` | Eligible edits apply without a host response. Restricted paths, repository metadata and agent configuration files still ask. | Every command waits for the host, including commands that edit files. |

The policy is fixed when the session opens. The session's `approvalPolicy` reports the selected
policy with controlled-configuration verification.

## Token usage

Each turn whose prompt reached Claude emits two `usage.observed` events after its other output and
before `turn.completed`. They are two separate views of the same work; never add them together.

| View | Scope | Meaning |
| --- | --- | --- |
| `claude-query-model-usage` | the session's query (`materialization`, open) | Authoritative cumulative snapshot from the result's `modelUsage`; the revision is its `result_index`. Attribution is the reported model, or a sorted mix of reported models. |
| `claude-main-loop-turn` | the turn (`turn`, final, contained in the query scope) | Detail delta from the result's main-loop `usage`. Attribution is unknown. |

Input adds raw, cache-read and cache-creation input once. Claude Code turns nullable API cache
counters and retention categories into zero before accumulating either view. This loses whether
an earlier request omitted a counter, even when a later cumulative value is positive. Both views
therefore use the following precision; counter reasons also preserve interruption or incomplete-result gaps:

| Counter | Complete-result precision |
| --- | --- |
| Inclusive input | Lower bound with `not_reported`; known raw zero plus unreported caches is a lower bound of zero |
| Cache read, cache creation, 5-minute and 1-hour cache creation | Zero or absent is unavailable with `not_reported`; positive is a lower bound with `not_reported` |
| Output, including thinking | Exact, including a measured zero |

A reported retention split equal to cache creation cannot restore the lost provenance. Reasoning output, model
calls and turns are unsupported. Claude reports only an approximate default for thinking, and its
native turn count does not establish either model-request units or SDK turns.
Population is unknown: which helper models and descendants Claude counts is not established.
Assistant-message output can be a placeholder; this adapter uses only settled result measurements.

A missing result, missing usage or a zeroed error result is unavailable, not zero. Earlier
snapshots stay; after an interruption, an incomplete error or worker loss, later snapshots of that
query are lower bounds. Reader abandonment preserves already delivered observations but produces no
additional usage. Identical repeated results are ignored; conflicting results fence the session with
`usage_identity_conflict` or `usage_sequence_invalid`, including while the reader is paused. Non-integer counters,
more than 8 reported models, a model id longer than 128 characters, or retention categories that
sum above cache creation fail the session with `usage_invalid` or `usage_capacity_exceeded`. A counter that
falls fails it with the runtime's `usage_counter_regression`. These limits are operational bounds,
not billing data.

Native qualification covers SDK 0.3.322 / Code 2.1.322 on Linux x64 and in the native-arm64 Docker
Desktop Linux guest, using the same packed archives on both. Each platform passed seven installed
scripted cases (two turns, tool continuation, interrupted stream, budget stop, API error, worker
loss and unreported retention) and a separate two-turn Anthropic API check using
`claude-haiku-4-5`. Attribution preserves native `modelUsage` keys, which can be aliases. Cache
activity was exercised with scripted responses; the live checks observed none. Those historical
archives used the earlier mapping and do not establish exact cache accounting or qualify this
precision correction. Current hermetic regressions cover defaulted zeroes, later positive totals,
and measured output zeroes; fresh installed evidence has its own archive scope. Live egress was
observed, not prevented. This evidence does not qualify native Darwin, resume/fork, billing, or the
separate raw sandbox recipe. Migration from Agent Protocol V13 is in
[UPGRADING-TO-AGENT14.md](../../UPGRADING-TO-AGENT14.md).

## Composition

The driver starts its own Node worker process, which hosts the SDK and launches Claude Code with:

- `tools: []` and every recorded native built-in disallowed;
- one SDK-owned MCP server exposing exactly the seven owned tools, plus fixed aliases (`Bash`,
  `Write`, `Edit`, `Read`, `Glob`, `Grep`) that resolve to those tools;
- no settings sources, plugins, hooks, session persistence or remote MCP servers;
- a permission callback that denies any residual request.

Claude must report exactly the owned server and tool set, the configured model, the `default`
permission mode and the pinned Claude Code version. Any other native tool fails the turn with
`claude_residual_tools`. Any other model, mode or version, a status that changes the permission
mode, or a refusal fallback to another model fails it with `claude_configuration_drift`. Model
identity is compared exactly: Claude Code 2.1.322 resolves aliases such as `sonnet`, remaps some
legacy Opus identifiers and substitutes its default model for one it does not allow, so configure a
full model id that Claude Code reports unchanged. The scripted qualification model also receives
Claude Code's reserved `DeferredToolPlaceholder`; a call to it is refused with no effect. Its
presence is model-dependent and is not part of the owned tool inventory. Configuration is
immutable after the session opens. Model effects happen only through the owned tools, and every
command runs in the contained namespace described by `@agen-ai/provider-tools`.

Claude Code itself runs as the caller's user inside the Linux guest, outside the command sandbox. It
receives a complete explicit environment with private home, configuration and temporary
directories under the driver's state directory; nothing is inherited from the controller process.
The API key reaches Claude Code only through that environment and reaches the worker only through
its owned stdin channel. Treat the guest and the executable as trusted.

## Lifecycle

One reader owns the worker's output in order; request resolution does not wait for it. Queues,
captured output and approval waiters are bounded. Interrupting a turn withdraws a pending approval
without an effect, or stops an entered command and joins it.

Owned tool calls share a 128-MiB serialized JSON byte budget (including each wire envelope),
with at most 64 pending callbacks. This is separate from the tools' per-file `fileBytes` limit:
it accommodates a maximum-size single-file edit even under worst-case JSON escaping, while a
large multi-file patch may need smaller batches. Calls that exceed the remaining budget return
a tool error before host dispatch; they do not fence the session. Each settled callback releases
its bytes. Prompts, results and other worker control messages retain their 1-MiB wire bound.

Drift and worker loss act when they arrive, even while the reader is paused: the session admits no
further turn, pending approvals are withdrawn and their late answers refused, entered tool calls are
aborted and joined, Claude is interrupted, and later tool calls are refused without running. The turn
then fails with that observation's code, including one that arrives after Claude's result while
entered calls settle. A worker or transport failure uses `claude_worker_failed`. Closing a session stops the
worker process group and joins it. If cleanup cannot settle, the session close and instance dispose
errors keep the original owner, lease and state, and expose a retry handle.

A turn queues at most 1,024 observations for its reader. Past that bound the turn fails with
`claude_turn_output_overflow`: entered tool calls are aborted and joined, Claude is interrupted,
later tool calls are refused without running, and the session admits no further turn. A failed
session opening whose cleanup cannot settle stays owned by the instance. A new session is refused
with `session_active`, and disposal retries that cleanup before releasing the state and lease.

Errors: `NodeClaudeProviderOptionsError` (invalid factory options or configuration, without secret
values), `NodeClaudeSdkError` (the installed SDK is not the pinned tuple),
`NodeClaudeProviderError` (`session_active`, `closed`, `invalid_session`, `not_ready`) and
`NodeClaudeWorkerFailure` (`startup`, `runtime`, `transport`). Tool owner refusals use
`NodeProviderToolsError` from `@agen-ai/provider-tools`.

## Qualification

Credentialless runs with a scripted loopback model exercised edits, host decisions, command
approval and containment, refusals, cancellation, readiness refusal, read-protected edits and
pathological globs through the public driver on Linux x64 and in the Linux arm64 Docker Desktop
workload. The same frozen installed candidate also passed real Anthropic API-key qualification
with `claude-sonnet-5-5`: six final cases on each platform, plus one Linux route-feasibility case.
The [installed example](../../examples/accept-edits/README.md) owns the runnable command workflow;
the [handoff](../../examples/accept-edits/HANDOFF.md) is the single evidence index for exact
source/archive/native identities, cleanup, limits and later documentation-only changes.

Both compositions require Node `24.18.0`, the exact pinned executable/helper/Bubblewrap bytes and
a prepared private workspace/state parent. On Desktop the whole caller and provider run in the
qualified Linux arm64 guest; native Darwin, Windows, Rosetta and arbitrary Linux arm64 hosts are
unqualified. Construction does not download, install, prepare a container or provision credentials.
The provider process is trusted and is outside the command sandbox. Other versions, models,
credential mechanisms and containment profiles require their own evidence.

## Checks

```sh
pnpm --filter @agen-ai/provider-claude build
pnpm --filter @agen-ai/provider-claude test
pnpm --filter @agen-ai/provider-claude typecheck
```
