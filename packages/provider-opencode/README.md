# @agen-ai/provider-opencode

Owned OpenCode V2 driver for the AgenAI coding-agent runtime on Linux. It drives exactly the
OpenCode `2.2.7` client and native runtime, replaces the complete native tool inventory with the
seven owned tools from [`@agen-ai/provider-tools`](../provider-tools/README.md), and supports the
`host` and `provider_accept_edits` approval policies. This optional package is introduced in coordinated `0.4.14` with Agent Protocol V14.

The package root exports only constants and plain option types. Importing it reads no credentials
and acquires nothing. The driver constructor requires the explicit `@agen-ai/provider-opencode/node`
entrypoint.

## Usage

```ts
import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { createNodeOpenCodeProviderDriver } from '@agen-ai/provider-opencode/node';
import { prepareNodeProviderWorkspace } from '@agen-ai/provider-tools/node';

const workspace = await prepareNodeProviderWorkspace({ directory: '/absolute/owned-store' });
const driver = createNodeOpenCodeProviderDriver({
  executablePath: '/absolute/opencode', // OpenCode 2.2.7 bytes matching this package's pin
  provider: 'anthropic', // or 'openai'
  credential: { kind: 'api_key', value: apiKey },
  usageLimits: { maxOutputTokensPerRequest: 4096, maxModelStepsPerTurn: 12 },
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
  definitions: [{ providerKey: 'opencode', instanceId, driverConfiguration: { model: 'claude-sonnet-5-5' } }],
});
const session = await registry.requireInstance(instanceId).adapter.createSession({
  sessionId, workingDirectory: workspace.workspaceDirectory,
  configuration: { kind: 'managed', revision }, approvalPolicy: { kind: 'provider_accept_edits' },
  onBindingCreated, signal,
});
```

`driverConfiguration` accepts only `{ model }`. The model provider, credential, executable,
endpoint and containment are factory options and never pass through runtime configuration.
`apiBaseUrl` defaults to the selected provider's API origin and receives the `/v1` path; it must be
HTTPS, or HTTP on a loopback address, without embedded credentials. Anthropic uses the Messages API
and OpenAI uses the Responses API over HTTP. The credential route is an explicitly supplied API key, with no saved-login or refresh flow. There are
no environment, plugin, configuration or verification options.

`usageLimits` sets OpenCode's native bounds. `maxOutputTokensPerRequest` (1 to 256000) caps the
output tokens of every model request the session makes. `maxModelStepsPerTurn` (1 to 1000) is
OpenCode's agent step bound for one turn: at the bound OpenCode asks for a final answer and runs no
further tool calls. A logical step can include a length continuation, so the step limit is not an
absolute HTTP-request count. Neither control is a cost or invoice cap.

## What a session supports

Each driver materializes one instance bound to one prepared workspace. An instance has one live
session and each session has one active text turn. Sequential turns and a fresh session after
successful close are supported. Sessions are created fresh; resume, branch, native agents,
application MCP servers, steering, structured output and non-text input report unsupported. Turns
can be interrupted. Approvals are once-only and scoped to the exact action; there are no remembered
grants.

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
policy with controlled-configuration verification once readiness has been proven.

## Token usage

Sessions report `usage.observed` in two views that are never added together:

| View | Scope | Accounting | Attribution | Source |
| --- | --- | --- | --- | --- |
| `opencode-session-usage` (authoritative) | the session | snapshot from a fresh zero | unknown | `session.usage.updated` and one `session.get` readback per turn |
| `opencode-model-steps` (detail) | each SDK turn, contained in the session | one delta per native model step | the step's model | `session.step.ended` and `session.step.failed` |

The session snapshot is whatever OpenCode records for the session, so it may include auxiliary
requests OpenCode records there. Descendant and auxiliary inclusion are therefore unknown, and
the snapshot is never attributed to the configured model. A native step is a logical step, not a
model request: model calls and turns are unsupported counts.

OpenCode reports exclusive buckets. Input tokens add uncached input, cache reads and cache writes
once; output tokens add visible output and reasoning once. Both native route parsers accept missing
usage, and OpenCode turns absent buckets into zero before session accumulation. A later positive
total cannot establish that every earlier step reported its usage. Both views therefore expose
positive reported counts as lower bounds with `not_reported`; zero is unavailable with `not_reported`.
Inclusive sums are unavailable when every contributing bucket is unreported, including all-zero
native input or output. Existing interruption and incomplete-result reasons are retained. A route
still determines which counters can be observed:

| Route | Reported | Unsupported |
| --- | --- | --- |
| Anthropic Messages | input, cache read, cache creation, output | reasoning, 5-minute and 1-hour cache creation |
| OpenAI Responses | input, cache read, output, reasoning | cache creation and its retention categories |

Each turn reports the session snapshot after owned work settles and before `turn.completed`, followed
by the turn's step deltas; the last delta is final. Distinct session checkpoints arriving between turns
or after settlement are retained in arrival order for the next `turn.started`, within the shared
64-observation / 256-KiB pending bound. Active-turn stream totals and readback reconcile into the
settlement checkpoint. The readback runs only after OpenCode reported
the turn's execution result, and is bounded at 5 seconds. A dropped or unanswered readback leaves the
streamed totals and the turn outcome, and nothing is replayed. A readback must cover the totals known
when its request started; a stream update arriving during that request can overtake it. Malformed
responses, exceeded bounds and totals that decrease or contradict earlier accounting fail the session.

A failed step with usage is a lower bound, and one without usage is unavailable. A step that never
settles, an interrupted or lost turn, and an abandoned reader leave the step unavailable. Each also
makes every later session snapshot a lower bound, because OpenCode may not have recorded that work.
Usage events are judged as they arrive, even while the reader is paused or the turn is settling.
Invalid counters, conflicting or reused step identities, steps outside a turn, foreign readbacks
and more than 1,024 steps per session fail the session with the corresponding `usage_*` contract
error. A step on another model is configuration drift.
Settled step identities remain retained until the original reader finishes, so an identical result
replay during delivery is ignored while conflicting results or new work fail the session.

Token-usage qualification covers OpenCode 2.2.7 on Linux x64 and in the native-arm64 Docker Desktop
Linux guest, using the same packed archives on both. On each platform the installed driver passed
five scripted cases per route: two turns, two model steps in one turn, a canceled stream, an
invalid-request error and a lost server. It also passed two-turn API checks using Anthropic
`claude-haiku-4-5` and OpenAI `gpt-4.1-mini`. Cache and reasoning activity were qualified with
scripted responses; no live check observed those activities. Those historical archives used the
earlier precision mapping and do not qualify this correction. Current hermetic regressions cover
absent/defaulted zeroes followed by positive totals on both routes; fresh installed evidence has
its own archive scope. When a step stops at the output-token bound, OpenCode adds a
`session.synthetic` continuation, which the driver refuses as drift, so the turn fails. The OpenAI API
check with `gpt-5-nano` at a 256-token bound ended that way; that failed attempt remains separate
from the passing `gpt-4.1-mini` check. Live proxy evidence distinguishes a clean HTTP end from a
client close after the API terminal event. The earlier attempt with ambiguous closure evidence also
remains failed. These operational counts are not billing data; live egress was observed, not prevented.
This evidence does not qualify native Darwin, resume/branch or the separate raw sandbox recipe.
Migration from Agent Protocol V13 is in [UPGRADING-TO-AGENT14.md](../../UPGRADING-TO-AGENT14.md).

## Composition

Each session starts its own `opencode serve` process on a private authenticated loopback port with
a complete explicit environment: private home, XDG configuration, data, state and cache
directories, an empty `PATH`, and a random server password. Nothing is inherited from the
controller process and no project, user or Claude Code configuration is discovered. One private
configuration document selects the provider route, disables every native agent except the default
one, denies unknown actions, denies every native tool and integration, and allows only the packaged
plugin and the seven owned tools. The native location is an empty private directory, never the
workspace.

The packaged read-only plugin replaces the complete native tool inventory, removes other model
providers, MCP servers and skills, locks every agent's permission rules, disables native retries and
WebSocket model dispatch, and forwards each owned tool call to a private broker endpoint owned by
the driver. The endpoint listens on loopback in the guest network namespace and accepts exactly one
connection, which must authenticate with a per-session token. Before any model request the driver
requires, in order: the server's exact version, the event stream's connection receipt, the
requested session, the plugin's acknowledgement of the exact owned inventory carrying this
session's unpredictable nonce, the end of the plugin load, exactly the two private configuration
sources, locked agents and no saved grants.
A missing, malformed or refused acknowledgement fails the opening without dispatching a model
request. Model effects happen only through the owned tools, and every command runs in the contained
namespace described by `@agen-ai/provider-tools`. Each owned call is judged on the complete input
the model sent: OpenCode's built-in input repair is removed from the configuration, and the plugin
forwards what it observed before OpenCode's decoding drops undeclared fields. An unknown or
mistyped field anywhere in a call refuses it before any approval or effect. Native session, message
and call identities are correlated as data and never used as paths.

OpenCode itself runs as the caller's user inside the Linux guest, outside the command sandbox. The
API key reaches it only through the private configuration document, which is removed with the
session's state. Commands cannot reach the server or the endpoint. Treat the guest and the
executable as trusted.

## Lifecycle

One reader owns each turn's observations; request resolution, cancellation and turn completion all
go through it. Frames, queues, callback counts, captured output and approval waiters are bounded.
The plugin admits serialized tool-call frames up to 16 MiB, independently of the tools' per-file
`fileBytes` limit. Larger calls are refused before broker dispatch. Native events have a separate
32 MiB plus 64 KiB wire limit, allowing a canonical admitted input to be echoed both as an object
and as JSON argument text. Unusually expanded raw argument text or provider metadata must also fit
that event limit; exceeding it still fails the event stream and fences the session. Ordinary HTTP
responses retain their 4-MiB bound. The event reader uses a dedicated SSE parser because the pinned
OpenCode client's built-in parser has a smaller fixed limit; requests retain the pinned client.
Interrupting a turn withdraws pending approvals, signals entered tools to stop, and requests native
interruption. Entered tools are joined before the turn ends. A call OpenCode cancels before it enters
the owned tools is answered without running. The interrupt receipt and every other
native control request are joined before the turn ends and before another turn starts; a failed
receipt fences the session. A native permission request is rejected once, a native form is canceled,
and any configuration or session drift, foreign tool, provider-executed tool, event-source loss or
server exit fails the turn and fences the session as soon as OpenCode reports it, even while the
reader is paused or the turn is finishing. The event stream is never reconnected or replayed.
Closing a session stops the owned tools, then the server process group, joins both, and removes the
private state. If cleanup cannot settle, the
session close and instance dispose errors keep the original owner, lease and state, and expose a
retry handle.

A turn queues at most 1,024 observations for its reader. Past that bound the turn fails with
`opencode_turn_output_overflow`: entered tool calls are aborted and joined, OpenCode is interrupted,
later tool calls are refused without running, and the session admits no further turn. A failed
session opening whose cleanup cannot settle stays owned by the instance. A new session is refused
with `session_active`, and disposal retries that cleanup before releasing the state and lease.

Errors: `NodeOpenCodeProviderOptionsError` (invalid factory options or configuration, without
secret values), `NodeOpenCodeProviderError` (`session_active`, `closed`, `invalid_session`) and
`NodeOpenCodeNativeFailure` (`startup`, `readiness`, `runtime`, `transport`, `capacity`). Tool owner refusals
use `NodeProviderToolsError` from `@agen-ai/provider-tools`.

## Qualification

Credentialless runs with scripted loopback Anthropic Messages and OpenAI Responses models exercised
automatic and host-decided edits, multi-file patches, exact once-only command approval, containment,
refusals including unknown input fields, native tool exclusion, cancellation, event-source loss,
sequential sessions and readiness refusal without any model request through the public driver on
Linux x64 and in the Linux arm64 Docker Desktop
workload. The same frozen installed candidate also passed real API-key qualification on both
routes: `claude-sonnet-5-5` through Anthropic and `gpt-5.5-2026-04-23` through OpenAI. Each route
passed six final cases on each platform and one Linux feasibility case. The
[installed example](../../examples/accept-edits/README.md) owns the runnable command workflow; the
[handoff](../../examples/accept-edits/HANDOFF.md) is the single evidence index for exact
source/archive/native identities, cleanup, limits and later documentation-only changes.

Both compositions require Node `24.18.0`, the exact pinned executable/helper/Bubblewrap bytes and
a prepared private workspace/state parent. On Desktop the whole caller and provider run in the
qualified Linux arm64 guest; native Darwin, Windows, Rosetta and arbitrary Linux arm64 hosts are
unqualified. Construction does not download, install, prepare a container or provision credentials.
The provider process is trusted and is outside the command sandbox. Later native versions, other
credential mechanisms and containment profiles require their own evidence.

## Checks

```sh
pnpm --filter @agen-ai/provider-opencode build
pnpm --filter @agen-ai/provider-opencode test
pnpm --filter @agen-ai/provider-opencode typecheck
```
