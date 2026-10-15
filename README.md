# AgenAI Agent SDK

A provider-neutral TypeScript contract for hosting coding agents.

> All seven packages are published at `0.4.0`. This checkout prepares coordinated `0.4.1` source,
> which remains unpublished and implements Agent Protocol V11.
> See [MIGRATING-TO-0.4.1.md](MIGRATING-TO-0.4.1.md) for approval consequences and the session-lifetime interaction API,
> and [MIGRATING-TO-0.4.md](MIGRATING-TO-0.4.md) when upgrading from `0.3.1`.

## Why this exists

Claude Code, Cursor, Codex, OpenCode, Grok, and custom agent CLIs all model sessions differently.
Their turn APIs, interaction requests, streaming output, capabilities, and shutdown behavior rarely
line up. A host that supports several agents can end up rebuilding the same lifecycle code for every
provider.

The AgenAI Agent SDK gives those providers one process-local interface to implement. A driver
materializes an instance, the instance exposes an adapter, and the adapter opens sessions. The host
works with the same validated session contract regardless of the native API behind it.

Credentials, process management, native session identifiers, and provider adapters stay with the
adapter owner. The optional ACP transport exposes bounded ACP wire mechanics for adapter authors.
Product concerns such as users, workspaces, authorization, billing, persistence, and scheduling
stay in the host.

The SDK does not require an API key or rank credential mechanisms. An adapter can use an existing
subscription login, an interactive account flow, an API credential, or another provider-supported
mechanism. The host decides which configured adapter an authorized caller may use; the adapter
keeps its credential material and native login lifecycle private.

Write the host once. Adapt each agent once.

## Packages

| Package | Purpose |
| --- | --- |
| `@agen-ai/validation` | Validator-neutral issue data with an optional Zod 4 adapter. |
| `@agen-ai/agent-protocol` | Sessions, turns, requests, session decisions, capabilities, classified failures, provider retry events, artifacts, environment catalogs, parsers, and schemas. |
| `@agen-ai/agent-runtime` | Drivers, instances, adapters, sessions, session-lifetime handlers, environment lifecycle validation, registry mechanics, and conformance tools. |
| `@agen-ai/agent-orchestration` | Optional certified target policy, scoped managed tasks and tools, completion inbox delivery, and bounded storage contracts. |
| `@agen-ai/acp-transport` | Optional Node.js ACP JSON-RPC transport with explicitly selected pinned schemas, bounded framing, correlation, and standard session operations. |
| `@agen-ai/provider-acp` | Optional ACP driver with explicit connection ownership, a Node process launcher, and bounded session/permission lifecycles. |
| `@agen-ai/acp-registry` | Optional bounded catalog validation, deterministic search and exact plans, with explicit Node fetching, verified installation and retained launch. |

All seven packages are ESM, require Node.js 22 or newer, use explicit public entrypoints, and are
MIT licensed. Imports have no side effects. The transport also distributes upstream Apache-2.0
schema assets. All seven source versions are `0.4.1`; their published coordinated release is `0.4.0`.

The dependency chain is intentionally narrow:

```text
@agen-ai/agent-runtime
  -> @agen-ai/agent-protocol
       -> @agen-ai/validation
       -> zod

@agen-ai/agent-orchestration
  -> @agen-ai/agent-runtime
  -> @agen-ai/agent-protocol
  -> @agen-ai/validation
  -> zod
  -> @modelcontextprotocol/sdk@1.29.0 (explicit /mcp transport graph only)

@agen-ai/acp-transport
  -> ajv@8.17.1

@agen-ai/provider-acp
  -> @agen-ai/acp-transport
  -> @agen-ai/agent-runtime
  -> @agen-ai/agent-protocol

@agen-ai/acp-registry
  -> @agen-ai/validation
  -> zod
  -> pinned archive readers (Node installation graph only)
```

The optional transport has no dependency on the core packages, and the core packages do not
depend on it. It accepts host-owned streams and adds no process launcher, provider credentials,
registry installer, or authorization policy. Native ACP data stays at that explicit boundary.
The optional provider composes the transport with the runtime's existing driver/session API.
Its `/node` entrypoint adds explicit POSIX process-group launch and cleanup, plus a host-supplied
execution-boundary port for workloads whose descendants need broader ownership. The caller owns
confinement and credentials. Windows hosts supply an owned connection through the root provider API;
the built-in launcher rejects Windows before spawning.
The optional registry validates and searches inert catalog metadata and creates exact install plans.
Fetching and verified binary/npm/uv installation live under `/node`, with explicit origin policy,
caller-selected toolchains and an owned installation store. Retained launch verifies the complete
payload and requires an active reference. Catalog parsing and planning do not perform network,
filesystem or child-process operations or grant provider execution authority.

## Install

Install the published coordinated `0.4.0` runtime:

```sh
pnpm add @agen-ai/agent-runtime@0.4.0
```

The protocol and validation packages are installed automatically. Install them directly when you
need their public APIs without the runtime:

```sh
pnpm add @agen-ai/validation@0.4.0 @agen-ai/agent-protocol@0.4.0
```

Keep every SDK package you install at the same coordinated version, including optional packages.
The source Agent Protocol V11 directly replaces V10 at the live boundary; the current parser has no
V10 compatibility mode. The published `0.4.0` release retains V10.
The session-lifetime API described below belongs to unpublished `0.4.1` source. Run its examples
from a built source checkout, or consume a complete matching set of locally packed `0.4.1` artifacts.
Installing `0.4.0` does not provide that new API.

## Handle decisions outside a turn

[`examples/lifecycle-interactions.ts`](examples/lifecycle-interactions.ts) is the default walkthrough
for a setup question that remains pending after opening. It uses only protocol and runtime public
entrypoints and a deterministic adapter, with no native process, account, network or model turn:

```sh
pnpm build
pnpm examples:lifecycle-interactions
```

Inspect `adapter.sessionInteractions` before choosing this path. Supported adapters declare the
exact opening operations, currently supported `decision` request kind and exclusive producer
ownership. Install `interactions: { onRequest }` in the create, resume or branch input before native
admission. The callback receives a bound `AgentSessionInteraction`; opening can return while the
question is still live, and the host can answer that same handle later. Registering a UI after
opening is too late. The handler may return immediately after retaining a handle, or keep
signal-aware UI work pending; the provider must not wait for a human answer merely to return an
otherwise opened session.

Present the request's title, workspace target, descriptions and every offered consequence. Select
an offered `choiceId` through `interaction.respond`, observe its independent receipt, and observe
`interaction.terminal` and `interaction.signal` to retire the question. A workspace grant authorizes
current and future workspace configuration, is persistently managed by the provider and may affect
sibling or later sessions sharing its profile. Declining keeps configuration gated; it does not
revoke an earlier grant or promise a persisted denial. The SDK does not remember grants itself.

`delivered` records acceptance by the adapter and produces an `answered` terminal. It does not
attest a remote acknowledgment, immediate configuration loading or persistent native effect.
`rejected` with `requestState: 'pending'` leaves the handle eligible for a fresh valid answer;
`'unavailable'` ends that eligibility. `delivery_uncertain` fences session mutation and must never
be replayed. Local validation and a response signal aborted before provider entry remain errors
before delegation. A response that fails or times out after provider entry becomes uncertain.

Close the session to stop producers and join entered handlers and responses, then dispose the
registry. Request terminality and signal abortion are eligibility boundaries; neither establishes
callback drain or native-process quiescence. A rejected cleanup retains its exact callable owner
and resources for retry. The [migration guide](MIGRATING-TO-0.4.1.md) includes no-handler behavior,
bounded limits, opening cancellation and failed-startup cleanup through the registry cause.

Existing adapters may omit `sessionInteractions`; that means unsupported. Ordinary openings
without an `interactions` context keep their existing behavior. Supplying a context for an
unsupported opening operation fails before adapter delegation. This separate session-lifetime
surface retains the continuously owned turn output reader and authentication and materialization
APIs. V11 separately changes turn approval options to carry an explicit `consequence`; see the
[migration guide](MIGRATING-TO-0.4.1.md#use-v11-approval-consequences).

## Handle remembered turn approvals

[`examples/remembered-approvals.ts`](examples/remembered-approvals.ts) is a core-only V11 walkthrough
using a synthetic adapter and ordinary protocol/runtime imports. It displays each offered decision
and consequence, including explicit unknown duration and applicability, then selects the exact
offered remembered option ID. Its answer handler waits for unrelated progress while the original
reader keeps running, receives an independent delivery receipt, observes the original terminal
output and joins session cleanup:

```sh
pnpm build
pnpm examples:remembered-approvals
```

The synthetic adapter performs no action and has no permission database. `delivered` means that the
adapter accepted the selected answer; it does not prove a provider stored a rule, will match a later
action, or revoked anything on close. Hosts must present the offered explanation and obtain their
own decision. The example's simulated choice is limited to the bundled fixture.

[`examples/remembered-approvals-acp.ts`](examples/remembered-approvals-acp.ts) adds an optional controlled
ACP stdio peer. It explicitly selects `declared-complete-consequences-v1` for the peer's inspected
initialized identity and complete edit menu. Separate synthetic turns select remembered allow,
remembered deny and cancellation. The peer records actual request/response frames so the output
shows exact native reply correlation and one original prompt per turn:

```sh
pnpm examples:remembered-approvals:acp
```

The declaration attests that every option in those exact menus has only its represented decision
and once-only or provider-owned remembered consequence. Inspect and qualify a real peer before
making that attestation. Native labels alone establish no duration or scope; omission keeps the
provider's conservative once-only mapping. This controlled peer implements no native persistence,
future matching or tool effect. Its temporary wire audit is evidence, not remembered policy.

The packed-consumer gate compiles and runs the same core example with only validation, protocol and
runtime installed, then runs the ACP example against the matching optional tarballs. It also checks
ordinary public type entrypoints and both provider constructor declarations without source aliases.

### Selected native remembered-edit qualification (SDK03)

The final installed `0.4.1`/V11 proof used the genuine Linux x86_64 Grok Build `1.0.50`
(`c58f321264ba`) executable and the opt-in `grok-build-1.0.50-edit-remembrance-v1` mapping.
An isolated loopback model fixture drove real native edits without real account credentials or
paid/backend inference. In one public/native session, the six turns requested permission
`[1, 1, 1, 0, 0, 1]` times: once-only edit, once-only repeat, remembered edit, exact repeat,
neighboring owned file, and uncovered terminal action. Every expected fixture effect occurred;
each gated action received its exact native answer once through the original SDK execution.

A second attempt reopened verified retained state with a fresh native process and native session.
Its edit asked again and ran after once-only approval. That observation changes process and session
together; it does not define universal expiry or persistence. Each public SDK close had an
independent same-cgroup empty checkpoint with the controller alive, before registry/host disposal
and without earlier external intervention.

The [provider qualification record](packages/provider-acp/README.md#qualified-remembered-edit-scope-sdk03)
contains the exact executable, runtime tuple, report and seven native-used archive hashes.
Same-version repacking is not artifact identity. Duration and applicability remain unknown;
arbitrary matching, separate projects/profiles, remembered denial, terminal remembrance,
revocation and other providers remain unqualified. This SDK03 edit proof is separate from the
earlier SDK02 session-lifetime folder-trust proof below, whose retained `0.4.1` artifacts use V10.
Neither proof publishes this source or establishes consumer application or private execution support.

## Handle operational failures

`AgentError` retains V10's neutral `category`, stable `code`, safe `message` and tagged `recovery`,
with bounded optional context. Categories distinguish rate limiting, account allowance, turn budget,
execution/context limits, authentication, permission, invalid input, overload, transport and other
provider failures. Recovery hints describe possible next steps; a retry hint or quota reset never
authorizes replay or schedules another turn.

`runtime.retrying` observes a retry already owned by the provider. Keep the same turn and output
consumer active; optional attempt/maximum counts exclude the original attempt and remain absent when
unknown. A `runtime.error` diagnostic alone is not a terminal boundary. Present a failed turn from its
authoritative `turn.completed` result, preserving uncertainty when dispatch or native settlement cannot
be confirmed. A failed tool item does not by itself fail the turn.

Contract errors and retained cleanup handles keep their existing meaning. Cancellation acceptance
does not prove producers stopped, and successful cleanup does not make an unresolved operation safe
to repeat. The [consumer-handling example](MIGRATING-TO-0.4.md#consumer-handling) shows a small event
handler and the required cancellation, session-retirement and cleanup rules. The
[protocol README](packages/agent-protocol/README.md#errors-and-trust) defines exact categories,
recovery alternatives, quotas and bounds.

## Read output while a request waits

[`examples/live-request-output.ts`](examples/live-request-output.ts) demonstrates the separate
turn-owned request path. From this public source checkout, run:

```sh
pnpm build
pnpm examples:live-request-output
```

It uses a deterministic provider with no native process, account or network. One execution and one
output reader observe an opened request and unrelated progress before the host supplies the exact
answer. A separately owned handler waits for that progress, receives a delivery receipt, and joins
cleanup after later output and the original turn's terminal event. The packed consumer runs this
same source against the seven matching tarballs.

`startTurn` validates and reserves synchronously; native work starts on the first output pull.
Keep one consumer and one outstanding pull, and run human decisions independently of that reader.
`delivered` confirms provider-owned acceptance of the exact canonical answer or step. A rejected
receipt requires `requestState: 'pending' | 'unavailable'`; only pending can preserve that request
for a fresh valid answer. Local validation errors remain errors, and uncertain delivery forbids
replay. A receipt or waiting observation never completes the turn. See the
[before/after migration example](MIGRATING-TO-0.4.md#continuous-turn-output-and-independent-answers)
for cancellation, terminal fencing and abort-before-join cleanup.

## Run an ACP agent

The source checkout includes two credentialless, executable examples. They use a synthetic ACP
peer, require no account or network access, and exercise the ordinary runtime session and
once-only permission APIs. Build the packages before running them:

```sh
pnpm build
pnpm examples:local
pnpm examples:registry
```

The local example works with the supported Node platforms. The registry example's raw synthetic
executable uses a POSIX shebang, so it requires Linux or macOS on x64/arm64 and a Node executable
path without whitespace. Neither example requires npm/Python/uv installation tools. On failure,
they retain their temporary workspace; the registry example also persists its exact installation
reference. Establish native-process quiescence before releasing retained resources.

[`examples/local-command.ts`](examples/local-command.ts) starts a caller-selected absolute
executable with literal arguments, an explicit working directory and an explicit environment.
It constructs `createNodeAcpProviderDriver` from `@agen-ai/provider-acp/node`, registers that driver
with `createAgentProviderRegistry`, and runs a validated session. This path needs no registry or
installation store. For an agent you already manage, replace the fixture command with your approved
launch recipe; the launcher never inherits `process.env`, selects credentials or creates a sandbox.
The root provider entrypoint also accepts exclusively leased streams when the host owns acquisition.

[`examples/registry-install-run.ts`](examples/registry-install-run.ts) demonstrates the explicit
discovery and installation path with local fixture bytes:

1. Parse an approved catalog with `parseAcpRegistrySnapshot`, search it, and select an exact entry
   and target with independently retained snapshot and entry pins.
2. Create an immutable `createAcpInstallPlan` with explicit integrity, network, scripts and
   reproducibility policy. Package distributions also need exact resolution and toolchain evidence.
3. Open an owned installation store through `@agen-ai/acp-registry/node` and deliberately install
   the plan against its retained expected digest. Installation produces a separate verified receipt.
4. Acquire an exact installation reference and call `resolveLaunch`. Compose the returned recipe
   with the host's approved environment and working directory, then create the normal ACP driver.
5. Start one execution, consume `execution.outputs` through terminality, answer through
   `execution.resolveRequest` independently, close sessions and dispose the
   provider, then release the installation reference. Removal is a separate explicit operation.

The fixture computes pins from its own known synthetic bytes to keep the example self-contained;
a production host must obtain its expectations from an independently trusted source. The example
deletes its original artifact and reopens the store before launch, demonstrating that
retained launch uses the verified installation rather than downloading or resolving an agent again.
The shared [`examples/run-session.ts`](examples/run-session.ts) shows a pending once-only approval
continuing the same prompt with independently owned, signal-aware human handling. Its
`ExampleSessionCleanupError` is an example-host error with a `retryCleanup()` closure that retains
the session or exact SDK opening-cleanup receipt and registry. A failed cleanup keeps the workspace
and any installation reference retained; retry the owned cleanup before disposing those resources.
This helper error is not an SDK export or a serializable recovery handle.
These examples demonstrate API behavior; they do not qualify a native
agent, an authenticated account, inference, or production containment.

## Managed delegation

`@agen-ai/agent-orchestration` adds managed child tasks above the validated runtime. Its ordinary
entrypoint is inert: importing it opens no sessions, listeners, databases or processes. Native harness
subagents keep their own behavior and policy. Construct a coordinator explicitly when your host wants
the SDK to manage separate child sessions.

Delegation has three independent choices: the developer excludes targets, the user enables and
selects permitted targets, and the main agent chooses from the resulting catalog. Developer exclusions
default empty and user policy defaults disabled. With delegation enabled and selection omitted, all
currently available, host-certified standard targets are eligible, including future catalog additions.
An explicit empty selection stays empty. Fast execution requires explicit opt-in; certified `max`,
`xhigh`, `ultra` and other provider reasoning identities have no SDK ceiling. Unknown execution
semantics require explicit selection and a visible host limitation. User selection cannot override a
developer exclusion, and descendants cannot expand their ancestor's exact target ceiling.

The host certifies complete target combinations and their exact configuration mappings. It owns
current policy, source/account/loading authority, result and control access, execution leases, and
authorized child resources. The coordinator applies the selected child configuration before its first
prompt and checks current authority at dispatch. Native option names alone do not certify standard or
fast execution. Catalog and source changes invalidate stale references even if their labels stay the
same. No configuration change is applied to the parent or a shared session.

`createDelegationHostBinding({ client })` closes over a trusted scoped client and returns no binding
while delegation is disabled. Enabled policy with no permitted targets still exposes a bounded empty
catalog explanation. The tools are `delegation_targets`, `delegate_task`, `task_status`, `task_send`
and `task_cancel`; mutation calls carry durable UUID operation IDs for honest retries. Cached tools still
check current authority. Disabling delegation prevents new execution while authorized status, result
and cancellation access can remain available. Status supports bounded waits and paginated history;
tool projections fit within 24 KiB and the runtime's 32 KiB result envelope. Parent identity, policy,
executable authority and approval handles never come from model arguments. Approval resolution stays
host-only, and tool failures expose bounded neutral errors rather than native diagnostics.

The SDK generates guidance internally from the effective capabilities. A host does not need to expose
prompt text in its user interface or ask users to write a delegation template. Guidance uses the
adapter's declared instruction placement; tool context is not a trusted system or developer message.
It cannot grant authority or enforce policy. Host-certified native tool names may appear in guidance,
and installing managed tools preserves native tools. Releasing a binding drains its calls without
disposing the coordinator or canceling admitted children. Close the coordinator before its runtime
registry, retaining leases and resources until their producers have quiesced.

Completion defaults to `collect`, where the caller reads the task result without requiring an inbox.
`next_turn` and `automatic` require an explicitly compatible `DelegationParentDeliveryPort`. Any inbox
configured for durable task storage must be durable. The SDK submits deduplicated completion envelopes
to that host inbox and does not
dispatch the parent model. Inbox acceptance, authorized parent dispatch and child outcome are separate
facts. A lost acknowledgment is inspected before another acceptance attempt. Revocation, expiry or
inbox dismissal preserves the child result. Recovery never replays uncertain child execution or an
uncertain parent dispatch. The host consumes `next_turn` completions at an explicit turn boundary and
may dispatch `automatic` completions only at an authorized idle boundary, sharing its normal parent-turn exclusion.
A child can outlive the parent turn that delegated it.

Pending delivery retries use backoff of one to 30 seconds until notification expiry. Shutdown stops new
inbox deliveries and quiesces entered callbacks; a timeout does not release an owner while its callback
can still commit. Draining children does not mean their parent consumed the completion.

Run the credentialless direct and ACP workflows after building the source checkout:

```sh
pnpm build
pnpm examples:delegation
pnpm examples:delegation:acp
```

The direct workflow demonstrates configuration before prompting, selection, progress, steering,
queued turns, cancellation and host approval. The ACP workflow uses a deterministic peer that actually
discovers and invokes managed MCP tools, then ends its parent turn while a child remains waiting.
Neither workflow needs credentials or inference. The ACP process example uses the provider's POSIX
launcher; hosts on other platforms supply their own owned connections.

The [durable walkthrough](examples/delegation/README.md#durable-command-line-walkthrough) adds a local
SQLite store and parent inbox with explicit setup, inspect, restart and cleanup commands. That reference
qualifies Linux, Node `24.18.0`, SQLite `3.53.1` from `node:sqlite`, and a local filesystem of Linux type
`0xEF53`; it rejects other tuples. SDK support for Node 22 or newer does not qualify this reference on
every supported Node version. In the exact qualified environment, use the root printed by setup:

```sh
pnpm examples:delegation:durable setup --scenario normal
pnpm examples:delegation:durable inspect --root /absolute/generated/root
pnpm examples:delegation:durable restart --root /absolute/generated/root
pnpm examples:delegation:durable cleanup --root /absolute/generated/root
```

Run its separate crash/recovery qualification lane in that same environment:

```sh
pnpm build
pnpm typecheck:examples
pnpm test:examples:durable
```

The connected [failure-handling example](examples/delegation/README.md#handle-retries-classified-failures-and-uncertainty)
is available as `pnpm examples:delegation:failures` on that qualified tuple. It demonstrates a
provider-owned retry ending successfully, a classified child failure collected after reopening
SQLite, and uncertain execution that remains `recovery_required` despite a retry hint. The durable
qualification lane and the opted-in packed consumer execute it using only public package entrypoints.

Retained format-1 task stores require the explicit
[offline migration](MIGRATING-TO-0.4.md#optional-managed-delegation) before format-3 open. The optional
inbox migrates atomically in the same database, while owner-lock format remains 1. Stop and resolve
old execution/delivery owners first; the migration retains a synchronized backup and refuses
unresolved or oversized transformations. Rollback requires that backup and the matched old
implementation in a separately owned directory. The public reference's qualification is independent
of private Hostd's Node 22.23.2/SQLite 3.51.3 durable runtime.

See the [orchestration README](packages/agent-orchestration/README.md) for bounded tools, storage,
authority and cleanup contracts. This release supplies SDK building blocks and executable host
compositions. Product settings, preference persistence, account-aware catalogs, production provider
registration and user experience remain application follow-up work.

## ACP support

The transport validates the selected wire schema. The provider separately maps the semantics it
can faithfully express through Agent Protocol V11. Initialization fixes one capability envelope per
instance, and later connections must match it.

`createAcpProviderDriver` and `createNodeAcpProviderDriver` default
`unknownExtensionPolicy` to `'standard'`: an unrecognized `_...` notification is
discarded, and an unrecognized `_...` request receives a correlated `-32601`
response. Neither invokes a host callback. Direct `createAcpClient` construction
defaults to `'reject'`. Select `'reject'` explicitly on a provider to retain strict
extension rejection, then create a fresh provider/session; changing policy never
replays an uncertain operation. Both choices preserve schema, framing, rate,
correlation and cleanup limits. Known or registered methods still use their exact
validators. A vendor feature that needs an extension requires an explicit mapping
and separate behavior evidence.

| Surface | Provider support in `0.4.1` source |
| --- | --- |
| Sessions and turns | Create, default text turns, streamed text/reasoning/tool progress, and settlement-backed interruption. Exact resume requires advertised `session/resume` or `session/load`; load replay is bounded and suppressed. |
| Turn permissions | Once-only, exact-action choices; one native prompt survives each canonical request continuation. Persistent turn grants are unsupported; the explicitly selected workspace decision below is separate. |
| Session-lifetime decisions | Unsupported by default. The selected Node `grok-folder-trust-v1` mapping supports workspace decisions for create only and requires a handler and host-supplied execution boundary. |
| Configuration | Managed by default; explicitly selected boolean/select catalogs with offered revision checks. ACP has no remote compare-and-set guarantee. |
| Session-local MCP tools | Explicit `sessionMcpBinding` factory after the requested HTTP/SSE transport is negotiated. Instructions use tool context; setup alone does not certify native tool discovery or invocation. |
| Forms | Boolean, single-select and multi-select forms within V11 bounds, preserving accept/decline/cancel. Broader forms need an explicit host facility; unsupported constraints fail before presentation. |
| Images | Advertised inline PNG/JPEG/WebP input within fixed image and turn budgets. No implicit file reads, URL fetching or media output. |
| Observations | Plans, partial structured file changes, and session command catalogs. Missing metadata stays unknown. These observations do not establish a final workspace Review. |
| Host facilities | Explicit authentication, URL/form, filesystem and complete terminal callbacks. Paths, commands and method labels do not authorize an effect. |
| Unsupported semantics | Branching, same-turn steering, enforced plan mode, context usage/compaction, account quota, effective skill/rule inventory, collaboration, generated resources and artifact publication. |

The provider has no portable list/delete/logout/import administration API. Hosts can use the
transport directly for separately authorized native administration. See the
[provider capability matrix](packages/provider-acp/README.md#capability-matrix) for exact mapping
requirements, form constraints, operational bounds and failure behavior.

For managed tools, configure `sessionMcpBinding: { transport: 'http', create }` on the provider and
have the factory construct `startDelegationMcpBridge` from `@agen-ai/agent-orchestration/mcp` using its
validated session binding. The factory returns exact MCP server entries and an owned release callback;
each create or resume receives fresh resources. Static native MCP servers remain available. Without
the configured factory and negotiated transport, host binding support is unsupported. The bridge
starts only when explicitly constructed, binds loopback with fresh bearer credentials, and carries
generated instructions through MCP tool/server context. Qualify discovery and invocation for each
actual native harness version separately from ordinary runtime opening.

On successful close, the provider quiesces its native connection before releasing the MCP bridge;
the runtime then drains and releases the original host binding. A rejected opening with incomplete
cleanup can retain an `AgentProviderSessionCleanupError`. Check its ownership with
`isAgentProviderSessionCleanupErrorFor(error, originalOpeningInput)` and keep `retryCleanup()` and
its resources until cleanup succeeds. The binding-specific subclass remains available. Cleanup
handles and native diagnostics belong to the trusted host, not model-visible tool results.

The separately invoked [native qualification example](examples/delegation/native/README.md)
performs discovery, bounded authenticated execution and offline evidence checks.
Earlier repository qualification exercised Grok `1.0.50` on Linux x86_64 through an explicit
API-key route with `grok-4.3`, Low reasoning and the observed default service-tier
request mapping. Both direct launch and verified retained-binary launch completed
actual managed tool calls, once-only approvals, child-result delivery and cancellation,
with owned resources closed. Retained launch reopened the installation in a fresh
process. The retained version-1 reports describe the prior continuation API. Current version-2
execution reports require fresh installed qualification; deterministic packed runs do not qualify
this changed output lifetime. That exact pairing used a volatile completion inbox; the durable
reference has its own qualification. Native smoke is opt-in and is never scheduled by ordinary
tests. Other native versions, account routes, platforms and production hosts require
their own evidence.

## Selected native lifecycle mapping

The Node provider's explicit selection is
`sessionInteractions: { mapping: 'grok-folder-trust-v1' }`. It requires a genuine direct native
executable, the exact literal arguments `['agent', '--no-leader', 'stdio']`, an exclusively owned
`executionBoundary`, and an `interactions` handler on every create input. Construction rejects
the selection without that boundary, before materialization can start a target. The root provider's
injected or shared connections do not support this mapping. It stays disabled when omitted.

| Phase and request kind | Selected mapping support |
| --- | --- |
| Materialization/readiness interaction | Unsupported; these phases do not accept the session handler. |
| Create workspace `decision` | Supported; a native question can arrive during opening and remain pending after return. |
| Resume or branch | Unsupported with this selection. |
| Outside-turn forms or authentication | Unsupported. Turn forms and explicitly configured host facilities use their existing APIs. |

`NodeAcpExecutionBoundary` is a host port from `@agen-ai/provider-acp/node`. A synchronous `reserve`
returns fresh inert ownership before `start` acquires resources. Its `release` must fence admission,
terminate and join the whole workload, including descendants that create new POSIX groups or sessions,
and join streams before succeeding. Process-group shutdown alone does not meet that contract.
The [typed Linux reference](examples/execution/linux/README.md), including
[`boundary.d.mts`](examples/execution/linux/boundary.d.mts), supplies a working composition using
systemd, cgroup v2 and Bubblewrap. It remains example-host code outside the published package and
has explicit OS, tooling, mount, network and resource prerequisites. Retain the host before startup,
then retain sessions, registry and any installation reference until their owned cleanup succeeds;
finally dispose the host. A startup cleanup error can be retained in the registry error's `cause`,
as shown in the [migration guide](MIGRATING-TO-0.4.1.md#retain-startup-and-opening-cleanup).

The earlier SDK02 native grant, decline and pending-close qualification used its retained installed
public `0.4.1`/Agent Protocol V10 artifacts on this exact composition: Grok Build `1.0.50`
(`c58f321264ba`), native SHA-256
`c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5`, direct no-leader launch,
modern stable ACP `schema-v1.23.0`, the selected mapping, API-key authentication, Linux x86_64
kernel `7.0.0-38-generic` and Node `24.18.0`. The Linux owner used systemd `259.5`, Bubblewrap
`0.11.1` and the frozen installed dependency/toolchain/network inputs. Its whole-service limits were
64 tasks, 512 MiB and 180 seconds. These prompt-free cases establish resource fit for those cases;
they do not qualify model-turn sizing or other native/account/platform combinations.

The public handler observed a live question after opening in each case. Grant returned `delivered`
and had separate vendor-file evidence of the exact workspace grant. Decline returned `delivered`
and left that grant absent; there is no separate attestation of a native acknowledgment or persisted
denial. Pending-close selected no response, ended the question as `session_closed` and rejected a
stale grant as unavailable. Each returned SDK close had an independent empty checkpoint for the
same workload cgroup while the consumer remained alive, followed by host retirement without
external intervention. Native wire reply correlation and prompt-frame counts remain unobserved.
The frozen consumers invoked no SDK turn; separate controlled peers prove wire correlation and
no-prompt behavior.

This session-lifetime proof does not qualify SDK03 remembered turn choices. Controlled qualification
and fresh standalone checks are separate evidence. The retained SDK02 native
consumer's frozen dependency closure included `fast-uri@3.1.8`; this standalone checkout retains
its `fast-uri@3.1.0` override. A new `pnpm check` proves its own inspected inputs and does not make
those dependency tuples identical or repeat the authenticated native qualification. Documentation
edits and later packing can change archive identities; new `0.4.1` tarballs do not become the
retained native-qualified archives through their version alone. The selected
mapping does not qualify interactive materialization, native durable recovery, SDK-managed remembered
permissions, private host execution, consumer application integration or publication.

## Pinned inputs and verification

| Input | Accepted identity |
| --- | --- |
| Legacy transport schema | `v0.11.4`, commit `e931357254ff44573294d5cee214a269e0cd6c54`; stable is the transport default, unstable is explicitly selectable. |
| Modern provider schema | Stable `schema-v1.23.0`, commit `6d08f412a7a1370d3cc9a124e3be3d6acf92641e`; the provider selects it explicitly. |
| Registry metadata | `published-v1`, based on registry commit `7f9be29696108572a2bca70e0563af528073a0c3`; complete `version: '1.0.0'` catalogs with only the documented empty `extensions` exception. |

Both schema profiles use ACP wire version 1. That number selects neither a schema profile nor
optional capabilities. Modern unstable definitions and ACP v2 are unsupported. The transport
ships exact schema bytes, hashes, licenses and provenance in its
[profile directories](packages/acp-transport/schema); the registry documents its
[accepted format and upstream inputs](packages/acp-registry/README.md#identity-and-the-accepted-profile).
Stable and preview catalogs are distinct caller-selected sources, with no automatic overlay or
latest-version resolution.

Verification evidence has several separate meanings:

| Evidence | What it establishes |
| --- | --- |
| Source, snapshot, entry and plan digests | Identity of the selected inputs. The caller must retain expected pins independently; a self-computed digest does not establish publisher trust. |
| Expected artifact checksum | A byte expectation approved before installation. A later measurement cannot supply a missing expectation retroactively. |
| Installation receipt | Verification of the actual artifacts, complete payload, launch recipe and declared obligations. Launch checks current payload and retained toolchain entry bytes again. |
| Exact package version and dependency lock | A fixed top-level resolution and, when supplied, declared dependency closure. Installation also checks actual manifests and closure; a version alone is incomplete. |
| npm package provenance | Evidence about the SDK package build/publication. It does not authenticate agents selected from a catalog or authorize their execution. |

Strict plans require expected integrity, disabled package scripts and complete package inputs.
Permissive plans retain missing-checksum or missing-original-lock gaps after installation. Native
shared libraries, operating systems and complete external Node/Python toolchain trees remain host
dependencies. Installers support checked binary archives/raw executables and offline npm/uv
installation from approved artifacts; package lifecycle scripts, Python source builds, unsupported
dependency metadata and download-on-demand `npx`/`uvx` launch are rejected.

The host owns trusted source selection, execution permission, credentials, process/network/filesystem
containment, user interaction, durable output and recovery. Keep a turn-lifetime signal valid across
pending requests; canceling that signal cancels the retained native prompt. Keep every installation
reference until all processes using it have stopped, including failed startup and cleanup. An
uncertain dispatch or cancellation must remain uncertain; close the unusable session and establish
cleanup before rematerializing, without replaying the original action. Neither installation success
nor the six recognized target identifiers establishes native or production qualification.

## Runtime shape

```text
host policy
    |
    v
driver -> materialized instance -> adapter -> provider session
                                      |
                                      +-> validated streaming output
```

The host selects and authorizes an instance before entering the SDK. The runtime validates the
materialized instance, capability declarations, adapter behavior, stream boundaries, readiness,
environment ports, and disposal. A session covers create, resume, branch, turns, interaction
requests, steering, interruption, environment observation, and close according to the capabilities
reported by its provider.

This is a service-provider interface, not a network protocol and not a lowest-common-denominator
wrapper. An adapter translates its native provider behavior at the boundary while keeping useful
provider mechanics inside the adapter.

## Environment and effective content

Agent Protocol V11 retains the distinction between content a host manages and content a selected native harness actually
reports:

- `managedContent` is the caller-managed inventory used for distribution and product workflows.
- `effectiveContent` is the observed harness inventory, with separate registration, enablement,
  user-invocation, and model-callability facts.
- `commands` describes effective command entries.
- `extensions` describes installed packages and exact references to contributed content, commands,
  or integrations.
- `integrations` is a discriminated catalog for both MCP servers and Apps or connectors.

The environment snapshot composes those domains and distinguishes unsupported, not initialized,
unavailable, partial, and complete observations. Catalog revisions and observation timestamps are
descriptive evidence. They do not grant authorization or invocation authority.

Both runtime environment ports are explicit capability-matched variants: `unsupported`, `read`, or
`read_and_watch`. A materialized instance uses `environment` for workspace discovery. A provider
session uses `environment` for observations of its already bound session. Discovery requires the
host-selected environment ID, a canonical absolute working directory, and validated configuration;
session observation requires the bound environment ID. Supported ports declare their domains, and
the runtime rejects a port whose kind or domains disagree with the capability declaration.

## Selected content references

A turn can carry a selected effective-content reference instead of embedding native skill text or
forwarding a slash-prefixed command. The reference carries the environment revision, content
catalog revision, content identity, and content revision. The host must authorize the current
catalog entry and its immutable execution lease before provider delegation.

```ts
import {
  parseAgentEnvironmentId,
  parseAgentEffectiveContentId,
  type AgentContentReferenceInputPart,
} from "@agen-ai/agent-protocol";

const selectedSkill: AgentContentReferenceInputPart = {
  type: "content_reference",
  environmentId: parseAgentEnvironmentId("environment:workspace"),
  environmentRevision: 7,
  contentCatalogRevision: 12,
  contentId: parseAgentEffectiveContentId("skill:review"),
  contentRevision: 3,
  arguments: "Focus on tests and release notes.",
};
```

Providers advertise whether they accept content references, whether reference arguments are
supported, the maximum number of references, and the allowed prompt and argument text formats.
The protocol bounds a turn to 16 references and bounds each argument to 4 KiB of UTF-8. Runtime
validation applies the declared capability, while the product host remains responsible for current
catalog identity, visibility, and execution authority.

## Work from source

You need Node.js 22 or newer and pnpm 11.7.0.

```sh
git clone https://github.com/trevor-nichols/agenai-agent-sdk.git
cd agenai-agent-sdk
corepack enable
pnpm install
pnpm check
```

`pnpm check` validates repository/release metadata, checks generated protocol surfaces, builds and
typechecks all seven packages and the examples, executes the local, registry, direct-delegation and
ACP-delegation workflows, hermetic native-runner tests and package tests, then packs
each package for a separately installed consumer proof. The packed consumer also
executes those hermetic runner tests and verifies default and strict extension
policies through installed providers. Nothing is published by that command.
Durable reference qualification is a separate `pnpm test:examples:durable` lane with the exact
environment described above. Set `AGENT_SDK_DURABLE_TEST_ROOT` to a qualified absolute directory
to include that lane in the packed external-consumer proof.
Registry installation tests require Python and uv as well as Node/npm; see the
[installation test prerequisites](packages/acp-registry/README.md#real-installation-test-prerequisites).
The synthetic Linux test lane does not establish native macOS/Windows, account, inference or fleet
qualification. Qualify each actual agent version, target, toolchain and host policy separately.

Package-specific API and lifecycle notes live in each package README:

- [`@agen-ai/validation`](packages/validation/README.md)
- [`@agen-ai/agent-protocol`](packages/agent-protocol/README.md)
- [`@agen-ai/agent-runtime`](packages/agent-runtime/README.md)
- [`@agen-ai/agent-orchestration`](packages/agent-orchestration/README.md)
- [`@agen-ai/acp-transport`](packages/acp-transport/README.md)
- [`@agen-ai/provider-acp`](packages/provider-acp/README.md)
- [`@agen-ai/acp-registry`](packages/acp-registry/README.md)

## Prepared changes in 0.4.0

This coordinated release advances Agent Protocol to V10 and preserves the explicit core entrypoints.
`AgentError` now requires category and recovery evidence alongside code and message, and removes
`retryable`. The turn-scoped `runtime.retrying` event observes retries owned by the provider without
authorizing host replay. Unknown facts stay unknown; quota references reuse bounded observed quota
facts. See the [migration guide](MIGRATING-TO-0.4.md#failures-and-provider-retry-observations) for the
breaking contract changes and historical V9 decoding requirement.

It also carries forward the runtime correction first prepared in the unpublished `0.3.2` source. When a
provider returns `delivery_uncertain` from steering, the validated session now becomes unusable
for further mutation. The active output stream can settle; the host then closes and rematerializes
the session before continuing. A definitive rejection remains reusable. No automatic resend or
follow-up turn is introduced.

The source also adds optional `@agen-ai/acp-transport` at `0.4.0`. Its pinned ACP v0.11.4 stable and
unstable schemas and legacy defaults remain unchanged. Hosts may explicitly select the separate
modern stable `schema-v1.23.0` profile; modern unstable methods and ACP v2 are not included. Both
profiles use wire protocol version 1, which does not select a schema profile. Schema generation
uses package-owned inputs and works in a standalone checkout. The optional provider maps that
modern stable profile into the existing runtime API through injected
connections or an explicit Node launcher. The optional registry adds bounded catalog validation,
deterministic target selection, immutable plans, verified binary/npm/uv installation and reference-safe
retained launch with explicit resolution and integrity policy.
The optional `@agen-ai/agent-orchestration` package adds certified target policy and explicitly
constructed managed execution over the runtime registry, with a bounded volatile store, host-injected
completion delivery and a shared `/store-adapter` transition contract. The optional
[durable reference](examples/delegation/README.md) demonstrates SQLite ownership and parent-inbox
recovery in its qualified environment. Managed delegation defaults off; developer exclusions default empty,
users control remaining selections, fast starts unselected, and no SDK reasoning ceiling is imposed.
Native harness subagents remain independent. `createDelegationHostBinding` adds scoped agent tools
and generated instructions only when enabled; the explicit `/mcp` entrypoint starts an individually
owned loopback bridge for a supporting host. The ordinary import graph remains free of MCP transport
initialization. The provider's optional negotiated `sessionMcpBinding` factory composes those tools
with ACP sessions. See [managed delegation](#managed-delegation) for completion modes, executable
workflows and host ownership.
All seven package versions advance together under the coordinated release policy. Deploying a host
or using real accounts and inference requires its own authorization
and qualification. Package semver does not track a native vendor version. See
[MIGRATING-TO-0.4.md](MIGRATING-TO-0.4.md) for the host lifecycle and coordinated upgrade checklist.

## What changed in 0.3.1

This coordinated patch preserves Agent Protocol V9 and all public type and runtime behavior. It
clarifies the provider-neutral authentication boundary: credential selection and login lifecycle
belong to adapters, and the SDK neither requires API keys nor treats them as the default. No public
Claude adapter, provider account identity, credential path, or product authorization type is added.

See [CHANGELOG.md](CHANGELOG.md) for the complete release notes and
[MIGRATING-TO-0.3.1.md](MIGRATING-TO-0.3.1.md) for the compatibility and upgrade checklist.

## What changed in 0.3.0

This coordinated release advances all three packages from Agent Protocol V8 to V9. It adds the
effective environment catalogs and scoped discovery or observation lifecycle, folds MCP and Apps
or connectors into one integration catalog, and adds capability-bound selected content references.
The former standalone session integrations observation port is removed. Materialized instances and
sessions must expose explicit environment ports, including an explicit unsupported value when the
provider has no environment support.

See [CHANGELOG.md](CHANGELOG.md) for the complete release notes and
[MIGRATING-TO-0.3.md](MIGRATING-TO-0.3.md) for the source changes required by provider adapter
implementations. Earlier migration guides cover [operation observations](MIGRATING-TO-0.2.4.md),
[the V7-to-V8 upgrade](MIGRATING-TO-0.2.3.md), and [the original 0.2.0 cut](MIGRATING-TO-0.2.md).

The SDK remains beta while external provider adapters prove the public surface. Pre-1.0 releases
may contain breaking API changes during this period, and release notes call out each one.

## Contributing

Issues and pull requests are welcome. AgenAI develops the SDK alongside private host code in a
private monorepo, which remains the source authority. Maintainers import accepted public changes
there, run the full integration suite, and export the canonical public result back to this
repository. Contributor authorship is preserved through that process.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, [RELEASING.md](RELEASING.md)
for the maintainer release process, and [SECURITY.md](SECURITY.md) for private vulnerability
reporting.

## License

MIT. See [LICENSE](LICENSE). The ACP schema assets retain their upstream Apache-2.0 license and
provenance in each profile directory under
[`packages/acp-transport/schema`](packages/acp-transport/schema).
