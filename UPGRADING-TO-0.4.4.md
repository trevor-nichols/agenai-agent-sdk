# Upgrade to SDK 0.4.4

`0.4.4` is the published, coordinated **ten-package release** selected by npm `latest` and `beta`. It advances Agent
Protocol from V12 to **V13**, adds native structured final responses and `generateObject`, optional
runtime execution input, optional `@agen-ai/agent-history`, and optional `@agen-ai/sandbox` /
`@agen-ai/sandbox-docker` for explicit isolated command execution. Execution adapters must update their
capability and turn completion declarations even when they do not support structured output. Managed store contract 4
and SQLite physical format 3 remain unchanged. History stays independent of runtime execution
and requires no history port on an execution adapter. Execution input is an optional process-local
runtime domain; it adds no further protocol version change or package.

The earlier **seven-package `0.4.3`** release did not include agent-history or either sandbox
package. The [v0.4.4 release](https://github.com/trevor-nichols/agenai-agent-sdk/releases/tag/v0.4.4)
identifies the coordinated published family. Earlier protocol upgrades still follow
[MIGRATING-TO-0.4.2.md](MIGRATING-TO-0.4.2.md); users of pre-publication candidates must also
apply the API migrations below.

## Validate the installation

Install the published runtime and only the optional packages your application selects:

```sh
pnpm add @agen-ai/agent-runtime@0.4.4
pnpm add @agen-ai/agent-history@0.4.4
pnpm add @agen-ai/sandbox@0.4.4 @agen-ai/sandbox-docker@0.4.4
```

The runtime brings protocol and validation transitively. Keep every directly selected SDK package
at `0.4.4`, including optional orchestration and ACP packages. Install exact optional native peers
only for the chosen constructor; the history root needs no vendor SDK or execution package.
Current public examples target this published family. Repository example commands require the
matching built `v0.4.4` checkout; example files are source rather than additional npm entrypoints.

### Optional source and local-archive validation

Source development and local archive review are separate from npm consumption. From a reviewed
standalone checkout with the [documented tooling](CONTRIBUTING.md#local-setup):

```sh
corepack enable
pnpm install
pnpm check
node scripts/release/verify-release-set.mjs
```

The source verifier checks the exact ten-package inventory and coordinated version without
contacting npm publication APIs. After packing all ten source packages into an owned directory,
verify the actual archive set as well:

```sh
node scripts/release/verify-release-set.mjs \
  --release-directory /absolute/owned/development-tarballs
```

Retain the source revision, lockfile, complete archive filenames, versions, hashes and check results.
The archive directory must contain exactly the matching ten tarballs; incomplete, duplicate,
foreign or mixed-version sets fail admission. To test a local development build in a separate
project, install that verified archive set explicitly:

```sh
pnpm add /absolute/owned/development-tarballs/*.tgz
```

Keep every selected SDK package at `0.4.4`. Install only the exact optional native peers required
by the chosen constructor. The history root does not require vendor SDKs, execution packages,
ACP, credentials or a native process. Local tarballs are an optional development route, distinct
from published npm installation, source checks and exact-native qualification.

## Select optional sandbox execution

Sandbox use is explicit and does not change existing runtime sessions or Agent Protocol V13.
The neutral `@agen-ai/sandbox` root provides policy, file/process contracts and cleanup ownership;
`/backend` is its backend implementation seam. Select `@agen-ai/sandbox-docker` separately for
local Docker resources. Select `@agen-ai/sandbox/acp` and its optional matching
`@agen-ai/provider-acp` peer to compose those resources with the existing Node ACP constructor.
Neither sandbox package is included in published `0.4.3`.

Release `0.4.4` inputs default to execution until explicitly stopped. Omit `policy.execution`
or set `{ kind: 'until_stopped' }`; neither schedules an execution or idle timer. For a finite
budget, set `execution: { kind: 'deadline', timeoutMs }` using a positive safe-integer duration
in milliseconds. There is no SDK business-duration ceiling, including for multi-day values.
Resource, stream and cleanup controls remain independent; this does not imply crash survival.

Earlier candidate users must replace `deadlines.executionMs` with an explicit execution policy
and remove retired `deadlines.operationMs`. Select a fresh explicit `deadlineAt` on an
individual transfer when needed; omission has no total transfer timer. Retired fields reject,
so a caller's intended finite deadline cannot silently become indefinite. Startup and cleanup
retain their own fields. `SandboxRequestInput` / `SandboxPolicyInput` permit omitted execution;
parsed `SandboxRequest` / `SandboxPolicy` and backend drivers always receive a normalized policy.
The process budget begins at process startup entry; `withSandbox` also applies an explicitly
selected finite budget to its callback. See the [policy contract](packages/sandbox/README.md#explicit-policy-and-finite-values).

Replace `importFiles`/`exportFiles` with `importTree` and callback-scoped `exportTree`.
`fileFromBytes` borrows existing caller bytes in bounded chunks; keep them unchanged until the
transfer settles. Streaming sources declare exact file lengths and must reach actual EOF.
Export bytes remain provisional until the operation promise succeeds. Choose workspace or
an iterable of exact file paths; the latter does not read the whole workspace.

For physical directories, explicitly import `importSandboxDirectory` and
`exportSandboxDirectory` from `@agen-ai/sandbox/node`. Keep the source hierarchy quiescent;
the import helper is not a snapshot. Export requires a new destination namespace and returns
its published `files` child after validation. Use the returned `directory` path instead of
assuming exported files are direct children of the namespace. Existing destinations are
preserved. Retain `SandboxDirectoryCleanupError.retryCleanup()` on filesystem cleanup failure;
its `publishedDirectory`, when present, identifies an already committed result that cleanup
retry preserves. Neither helper implicitly destroys caller sandbox storage.

Use `SANDBOX_DEFAULT_TRANSFER_BUFFERS` for working memory, replacing the retired transfer-limit
policy. Logical file/count/payload/archive/path quotas are optional `quotas` on each operation.
Cumulative stdin/output quotas are optional too; bounded stdin/output staging remains explicit.
Docker construction now requires a caller-owned canonical `spillDirectory` and uses backend
revision `engine-1.52-v4-<profile>`; old or cross-profile recovery records cannot adopt
changed-policy resources, even when reserved before daemon verification.
The Docker format currently represents each file through `8 GiB - 1`, without an aggregate
workspace/count ceiling. No larger single-file qualification is claimed.

Omitted `profile` preserves `linux-x64`. On Apple Silicon, explicitly choose
`desktop-apple-virtualization-native-arm64` for an arm64 image or
`desktop-apple-virtualization-rosetta-amd64` for an amd64 image under Rosetta. Both require a
Darwin/arm64 controller and Linux/arm64 Docker Desktop daemon. Selecting either asserts Apple
Virtualization framework and ECI disabled; selecting Rosetta also asserts it is enabled. The
SDK checks the observable daemon/image/workload properties but does not attest Desktop settings.
It never changes them or discovers a Docker context. These Mac profiles are implemented and
await actual native qualification. Run the explicit [platform verification lane](scripts/development/agent-sandbox-qualification/platform/README.md)
using a fresh ten-package installation on the Mac; do not copy Linux `node_modules` or treat
synthetic admission tests as native evidence. Intel Mac and other VMMs remain unqualified.

Use the complete [Docker walkthrough](examples/sandbox/README.md), its
[runnable example](examples/sandbox/docker.ts), and its [session helper](examples/sandbox/session.ts)
instead of reproducing registry/session cleanup in application code. `withSandboxAcpSession` and
`SandboxAcpSessionError` are example exports, not package APIs. The helper accepts an explicit
backend, request, recovery policy, imported files and native launch/mapping options.

Prepare the trusted image independently and select its exact existing local image ID. It must
support the backend's non-root read-only-root profile, have no declared volumes, and meet the
[fixed image environment requirements](packages/sandbox-docker/README.md#prepare-the-guest-image).
Additional image ENV metadata is rejected; the SDK does not normalize it, install an agent,
select credentials or inherit a host profile. Use the returned guest `sandbox.workspace` for both
launch and session opening; it grants no host path access.

Finish imports before process reservation. ACP materialization eagerly initializes one native
connection and may start the process before any session opens, so retain and dispose the registry
or materialized instance after failed opening too. One SDK session can run multiple turns on that
connection. Another connection/session or authentication reconnect needs a fresh sandbox.
SDK close stops the entire compute boundary and joins its streams while retaining workspace
storage; export selected files after successful close, then destroy retained resources. Failed
cleanup retains exact retry handles and original failures. Persisted recovery requires the original
explicit backend and a quiescent prior controller; it restores cleanup ownership only.

The ACP bridge returns an empty host facility object. Separately supplied host callbacks, MCP
servers and runtime host bindings keep their caller's authority. Outbound networking allows broad
host/LAN/internet reachability, credentials are visible within the guest, and file-transfer limits
are not a workspace disk quota. There is no destination allowlist, automatic execution replay,
multi-session sandbox reuse or runnable crash recovery.

The [Docker qualification scope](packages/sandbox-docker/README.md#qualification-scope) records
Linux x86_64 / Node 24.18.0 / rootful Engine 29.1.3 API 1.52 with the required cgroup/security
profile. Its separate installed native proof uses exact Grok Build 1.0.62, requested `grok-4.3` / low
reasoning and API-key authentication for four turns with exact artifacts, cancellation and complete
resource cleanup. It does not qualify other providers, subscription authentication, fleet execution
or billing, and does not expand structured-output, history or execution-input support. Hosted
Docker CI requires separate workflow evidence; local native results do not establish a hosted pass.

## ACP prompt lifetime

Ordinary ACP prompts no longer have an implicit thirty-minute execution limit. The provider
preserves omission of the existing per-turn `deadlineAt`; a prompt remains owned until native
completion, explicit cancellation, connection closure or failure. To select a finite turn budget,
supply a fresh `deadlineAt` when calling `startTurn`. Long future dates use sliced timers and
are not capped at Node's single-timer duration. A selected expiry uses native cancellation,
retaining the original prompt RPC until terminal confirmation or bounded cancellation failure.

Remove `limits.promptTimeoutMs` from provider construction; it is rejected as an unknown limit.
Move an intended execution budget to each caller turn's `deadlineAt`. The independent
`limits.terminalWaitTimeoutMs` controls host `terminal/wait_for_exit` observation and preserves
its previous thirty-minute default and finite bounds. Initialization, authentication, other host
operations, human-decision waiting and cleanup keep their own existing controls. The separately
scoped `generateObject` operation keeps its documented finite timeout contract.

Direct transport requests retain their finite defaults. An explicit
`{ lifetime: 'until_settled' }` request option installs no deadline while retaining the exact pending
request ID, capacity, response observer and abort/disposal ownership. It cannot be combined with
`timeoutMs` or `deadlineAt`. Omitted or `'bounded'` lifetime preserves existing numeric timing
options. `AcpRequestOptions` is now a discriminated union type; consumers extending its previous
interface should use a type intersection. No Agent Protocol version change is required.

## Optional input on an owned execution

The runtime root exports `AgentExecutionInputSupport`, `AgentExecutionInput`, message/receipt/outcome
types and `parseAgentExecutionInputMessageId()`. Existing adapters can leave the new optional
`executionInput` declaration absent. Existing executions can leave `input` absent; absence and
`{ kind: 'unsupported' }` both mean unsupported. A supported execution port must match its adapter's
validated declaration exactly. This domain does not change strict `turns.steer`, serialized Agent
Protocol V13 or private Host Protocol V26 contracts, and supplies no idle-session input method.

Start with the [execution-input walkthrough](examples/execution-input/README.md), its reusable
[caller flow](examples/execution-input/application.ts) and [cleanup owner](examples/execution-input/main.ts):

1. Reserve the ordinary caller turn and start its sole `outputs` reader. Keep it continuously owned.
2. After reader entry, narrow `execution.input?.kind === 'supported'`. An unsupported result ends
   the input path without substituting another provider operation.
3. Parse a fresh unique message ID and call `sendMessage()` with that `messageId`, text `parts` and
   an optional `signal`. Respect the exact port's declared limits before submitting.
4. Keep the original reader running while awaiting the receipt and any accepted receipt's
   `settled` promise. The reader owns all original and continuation output through final settlement.
5. Close the session with a fresh cleanup signal, join that reader, then dispose owned resources.
   If close fails, retain the same session for another close attempt, or the exact cleanup handle
   and its `retryCleanup()` when provided, together with owned resources until cleanup succeeds.

| Result | Required interpretation |
| --- | --- |
| `accepted` receipt | Authoritative admission of the exact message. The separate `settled` promise is still owned; admission does not prove consumption, model compliance or completion. |
| `consumed` settlement | Exact message/turn attribution to `original_native_command` or `owned_native_continuation`, within the same SDK execution. It does not prove compliance. |
| `unconfirmed` settlement | Preserve acceptance and the bounded reason; missing consumption evidence never authorizes replay. A provider without such evidence declares `consumptionReporting: 'unavailable'`. |
| `rejected` receipt | Definite non-admission with a bounded `AgentError`; there is no settlement promise. |
| `delivery_uncertain` receipt | Delivery might have occurred. Mutation is fenced while the original output reader can still drain. |

The delivery contract is `current_or_owned_continuation`, broader than strict current-command
steering. Native queue priority is a mapping detail, not a portable scheduling guarantee. Never
automatically replay accepted/unconfirmed or uncertain input, start a fallback turn, or steer or
interrupt to simulate delivery. Validation, abort and capacity failures before provider entry keep
their existing errors. A provider-invoked failure can carry `AgentProviderDelegatedOperationError`
with `operation: 'send_execution_input'`; preserve that evidence and close conservatively. Aborting
an entered wait or reaching a deadline does not prove non-delivery or release native ownership.
Runtime receipt observation and owned-input draining each have a 30-second bound; reaching either
bound is a failure boundary, never evidence of successful native cleanup.

Every supported descriptor declares text-only input, `delivery`, `consumptionReporting`, and
`limits.maxOutstandingMessages`, `maxMessagesPerExecution` and `maxBufferedBytes`. Positive limits
may lower the SDK ceilings of **2 outstanding messages, 16 entered messages per execution and
1,048,576 buffered UTF-8 envelope bytes**. Canonical turn-content limits also apply to each message.
The separate session-generation ID census retains at most 4,096 IDs and 1 MiB of ID bytes; settled
IDs cannot be reused. Resume and branch start fresh ownership and never replay input. There is no
durable message deduplication service.

Admission fails before provider entry on a reserved, terminal or stale execution, a schema-bound
execution, an unsettled turn/session human request, or an unresolved human response. Use ordinary
`startTurn()` when idle. Supported mappings must attribute every native command and owned producer,
hold logical terminality until input observations and producers settle, and establish fresh idle
before reuse. Unknown commands/background producers fail closed. Close must initiate native
quiescence before joining entered sends, callbacks and readers; cleanup retries never replay input.

### Public unsupported boundary and exact private qualification

No public native provider in the ten-package release supports execution input. Public ACP/Grok
adapters remain absent/unsupported; there is no public Claude execution constructor or Grok input
selection. Stable ACP `schema-v1.23.0` negotiation, vendor metadata and extension advertisements
grant no input capability. Grok Build `1.0.67` has native input facilities, but its inspected behavior
did not establish authoritative input-to-command attribution, ownership of autonomous wake work,
or reusable-session quiescence. Queue acknowledgements and echoed text do not close those gaps.
Independent Grok `1.0.62` structured-output/history selections and other history peers stay unchanged.

The installed public proof runs the unchanged five-case neutral teaching example with explicitly
synthetic evidence. Separately, actual packed ACP constructors pass six unsupported cases with a
synthetic serialized peer: generic ACP, Grok input advertisements and the selected Grok `1.0.62`
structured-output mapping, each under borrowed and owned connections. They preserve the original
turn/reader, dispatch zero native input requests and join cleanup. These checks establish API and
unsupported behavior, not positive native input support.

Positive native qualification is limited to the private controlled Claude SDK `0.3.309` / Code
`2.1.309` diagnostic composition on Linux x86_64 / Node `24.18.0`, using the installed public runtime.
Seventeen scripted-model native rows cover receipts, attribution, races, background ownership,
interruption, close and cleanup. The admitted background path requires an exact root-command →
tool → task/run → notification-result chain, actual tool exit, complete producer settlement and a
fresh idle observation. Unknown or foreign producers remain failures. One separately bounded live
Sonnet 5.5 API-key run admitted one update while the single fixed Bash fixture was held. After the
fixture was released and exited, consumption was attributed on the original execution; its sole
reader completed with the requested updated label. The run used two model requests and one tool
launch. Compliance is that run's observation, not an API guarantee. This tuple does not
qualify subscription authentication, a public Claude provider, arbitrary tools, production Hostd,
fleet deployment or billing. Claude structured output's `.269` pair and history's `.306` pair retain
their independent qualification.

## Generate objects through the explicit runtime entrypoint

Import `generateObject`, `AgentGenerationError` and `AgentGenerationCleanupError` from
**`@agen-ai/agent-runtime/generation`**. The ordinary runtime root does not export this helper.
Use `createAgentOutputDefinition` from the protocol root or `/structured-output` for a neutral
schema plus a local decoder; use `zodOutput` only through `@agen-ai/agent-protocol/zod` for explicit
Zod authoring. Type inference comes from the decoder's successful result or the actual Zod schema,
not an unchecked `generateObject<T>()` assertion.

Start with the executable [title example](examples/generate-title.ts) and the
[object-generation walkthrough](README.md#generate-a-typed-object). The example takes a
host-selected validated instance, creates one fresh session, runs one turn, and saves the typed
title only after its owned reader and session close. The caller continues to own instance/registry
disposal, credentials, tool/sandbox policy, title persistence and the decision to generate a title.
The helper places the schema at the provider's declared lifetime boundary automatically.

The portable `agenai.output-schema.v1` profile is a finite JSON Schema draft 2020-12 subset.
Root and nested objects are closed and every property is required; represent absence explicitly
with nullable values. Supported constraints include neutral string `minLength`/`maxLength`,
homogeneous arrays with `minItems`/`maxItems`, string enums and inclusive numeric bounds.
General unions, references, patterns, formats, defaults and arbitrary JSON Schema are unsupported.
Schemas and results each have a maximum 16,384-byte serialized UTF-8 size, with separate structural
limits and potentially smaller provider ceilings. See the
[protocol README](packages/agent-protocol/README.md) for the complete keyword and limit contract.

Decoders validate the same JSON value; they cannot transform, trim, coerce, default, remove
properties or substitute a different value. The returned data is deeply frozen. The Zod helper
uses exact `zod@4.4.3` and rejects transforms, refinements, defaults, coercion, optional fields,
string length checks and array length checks. Zod string bounds use UTF-16 units, while JSON
Schema uses code points; array checks can carry conditions that cannot be translated faithfully.
Use neutral schema bounds or an explicit local validation-only decoder for those cases. A local
decoder can reject values more narrowly, but it never changes the native schema implicitly.

`timeoutMs` defaults to five minutes, allows positive integers up to one hour, and yields to an
earlier turn deadline. Supply a caller `signal` and signal-aware callbacks. Missing `onRequest`
causes unexpected turn approvals or other requests to fail as `interaction_required`; opening
questions use the separate early `session.interactions` context. Neither the schema nor the helper
disables tools or grants native authority. Configure an appropriately restricted instance.

Only successful native execution with a locally validated authoritative value returns an object.
Handle `AgentGenerationError.code` and its bounded reason/issues/receipt when present; preserve
existing validation, contract and caller-abort errors. On `AgentGenerationCleanupError`, retain
`retryCleanup()` and any primary error/result until cleanup succeeds. Failed opening may retain
its original provider cleanup error instead. Cleanup has a separate fresh 30-second observation
bound and starts native close before joining entered work. A result retained on a cleanup error
does not establish successful closure. Retry cleanup only; there is no automatic generation,
answer, repair or uncertain-operation replay. Successful shape validation does not establish
factual correctness or completion of every invocation. Native validation attempts remain owned
by the provider and do not establish a backend call count or billing ceiling.

## Update execution adapters for Agent Protocol V13

Update producers and consumers together. Current validators reject V12 live envelopes; do not
change an old record's version field to make it pass. Historical decoders preserve their exact
stored versions and are not a live compatibility mode.

Every `AgentCapabilities.turns` declaration now requires `structuredOutput`. An adapter without a
qualified native mapping must explicitly declare:

```ts
structuredOutput: { kind: 'unsupported' }
```

Supported declarations require all of `kind: 'supported'`, `mechanism: 'native'`,
`schemaProfile: 'agenai.output-schema.v1'`, `scope: 'turn' | 'session'`, bounded
`maxSchemaBytes`/`maxOutputBytes`, `resume: false` and `branch: false`. Support means an exact
configured native mapping, accepted profile and schema lifetime; a provider name, prompt, tool
argument schema or unrecognized ACP metadata does not establish it.

`AgentProviderStartTurnInput` and `AgentTurnRunInput` accept optional
`output: { kind: 'json_schema', schema }`. Create-session input also accepts that request for a
provider whose capability declares session scope. Place the request at exactly one boundary:

| Declared scope | Opening and turn behavior |
| --- | --- |
| `turn` | Omit output on create; supply it on a selected turn. Later turns can use a different schema or omit output for ordinary text. |
| `session` | Supply output at fresh create. Every turn inherits the immutable schema; turn-level overrides, including an explicitly supplied `output: undefined`, are rejected. Create another session to change or remove it. |

Structured resume and branch are unsupported. Ordinary no-output sessions retain their existing
capability-governed lifecycle. `generateObject` owns its output/signal placement, provider-start
observer, binding observer and single output reader; do not put those reserved fields into its
`session`/`turn` arguments or install a second reader. An optional `onOutput` observes its reader.

Every `turn.completed` payload now requires **`structuredOutput`**, independently of `outcome`:

| Variant | Meaning |
| --- | --- |
| `{ kind: 'not_requested' }` | No structured output was requested. Include it on ordinary completions, including failed/canceled/expired turns. |
| `{ kind: 'json', value }` | An authoritative JSON object is available and locally valid. Allowed only with `outcome: 'completed'`. |
| `{ kind: 'unavailable', reason, ... }` | Structured output was requested but a valid object is unavailable. Native execution can still have completed successfully. Only `schema_mismatch` may additionally carry bounded `issues`. |

Unavailable reasons are `refused`, `incomplete`, `missing_output`, `invalid_json`, `schema_mismatch`,
`output_limit_exceeded`, `native_retries_exhausted` and `provider_error`. Preserve native outcome
separately. Runtime validates the candidate against the admitted schema and byte/structural limits;
prose output cannot substitute for a missing candidate. A generation helper returns only after
both successful execution and valid structured output, then successful decoding and cleanup.

### Exact native support and private source consequences

The shipped public provider is `@agen-ai/provider-acp`. Generic ACP defaults to unsupported.
Enable only the inspected Grok Build 1.0.62 mapping through
`structuredOutputMapping: { mapping: 'grok-build-1.0.62-structured-output-v1' }`. It uses stable
ACP `schema-v1.23.0`, checks the initialized native identity and advertises turn scope. The exact
installed `0.4.4` Linux x86_64 / Node 24.18.0 composition with `grok-4.3`, low reasoning and xAI
API-key authentication returned the shipped title example, a richer object, a changed schema and
ordinary text afterward, with independent process/session/reader closure evidence. Inspect the
[provider README](packages/provider-acp/README.md) for constructor and mapping details.

Codex app-server 0.163.0 has per-turn native-schema proof through the private diagnostic adapter.
Claude SDK 0.3.269 / Code 2.1.269 has immutable query-schema proof through a separate private
diagnostic composition. Neither is a public provider constructor or a production Hostd
qualification. Claude execution's `.269` pair is distinct from history's `.306` pair below.
OpenCode V2 2.1.2, Cursor SDK 1.0.40 and unselected generic ACP remain unsupported for structured
execution and reject these requests before native work. Their saved-history capabilities do not
grant execution support.

The private monorepo advances current Workspace Host Protocol source to V26, with catalog V18
and embedded Agent Protocol V13, while preserving immutable V25/Agent12 recovery readers and
stored evidence. Private member chat and managed delegation reject structured-output requests;
ordinary `not_requested` completions project into their unchanged member/store contracts.
This private source transition does not deploy a service, migrate a production database or activate
a fleet. Public publication and private deployment remain separate operations.

## Construct a history source explicitly

The root exposes plain contracts/parsers and `createAgentHistory({ source, driver, limits?,
management? })` for a preconstructed custom driver. The deliberate `/zod` entrypoint exposes schemas.
Provider imports remain inert even when optional peers are absent. Acquisition and identity checks
occur at explicit construction or operation boundaries.

| Entrypoint / constructors | Qualified native inputs | Source scope and main view |
| --- | --- | --- |
| `/claude`: `createClaudeHistory` | Agent SDK 0.3.306; Code 2.1.306 baseline | Explicit configuration home; project/worktree policy or all projects; `retained_chain`. |
| `/codex`: `createCodexHistoryProcess`, borrowed `createCodexHistory` | App-server 0.163.0 | Explicit native home or initialized connection; project/all projects and chosen catalog policy/source kinds; `retained_chain`. |
| `/opencode`: `createOpenCodeHistory` | OpenCode runtime/client 2.1.2 | Supplied server and exact directory in its namespace; `retained_chain`. |
| `/cursor`: `createCursorHistory` | Cursor SDK 1.0.40 | Existing SDK JSONL/SQLite store and exact project; `current_checkpoint`, terminal run views `stored_updates`. |
| `/grok`: `createGrokHistoryProcess`, borrowed `createGrokHistory` | Grok Build 1.0.62 | Exact selected native project; surviving-branch `stored_updates`. |
| `/acp`: `createAcpHistory` | Stable ACP `schema-v1.23.0` | Initialized caller-owned connection, project/all projects; negotiated catalog only. |

See the [history package README](packages/agent-history/README.md) for complete constructor arguments,
optional peers, executable checks and resource policies. Native evidence is specific to Linux x86_64
and Node 24.18.0. The portable root supports Node >=22; Cursor construction requires Node >=22.13.
Version/digest checks identify qualified inputs rather than authenticating a publisher.

Cursor IDE and legacy CLI stores remain unqualified. Cursor Cloud has no shipped constructor:
metadata was reachable, but the sampled retained terminal stream returned HTTP 410 without events.
A local SDK checkpoint is not a cloud transcript reader. Generic ACP's negotiated list support does
not imply independent saved lookup/transcript/search or qualified deletion effects. No private-file
parser, legacy-cloud fallback, prompt or live-session load is used to fill those gaps.

## Consume capabilities and coverage

Every port independently declares `status: 'supported'` with a descriptor and callable methods, or
`status: 'unsupported'` with a reason. Narrow `catalog`, `lookup`, `transcript`, `views`, both search
ports and each management port before invocation. A listed conversation does not imply a readable
transcript, and supported capability is separate from the caller's application authority.

Assign a non-secret `sourceId` and configuration `generation`. Change generation when the native
root, account, server or effective scope changes. Preserve each native reference's exact source.
Pass a `nextCursor` only to the same history instance, operation, conversation/view and query,
including filters/order. Reopening starts a new traversal. Short and empty pages can still have
continuations; follow them within your own retention bound.

Qualified traversals are live and expose observation time, view and omissions. Retained chains,
current checkpoints and stored updates have different coverage. End of traversal never establishes
full lifetime history or recovery of deleted/precompaction content. Codex cold-index discovery can
omit readable-by-ID threads; Cursor checkpoint-only runs can have no replay events. Historical
native anchors are preserved where available and are not fabricated SDK turn IDs. Tools,
instructions and attachment references remain inert; reads do not fetch or execute them.

Metadata and content search are separate. Codex provides case-sensitive literal title matching;
OpenCode preserves SQL-LIKE title wildcards and ASCII case behavior. Grok supplies native metadata
filtering and ranked title/user-prompt content search, with its native omissions, query semantics,
window limits, snippets and estimates. Claude, Cursor and generic ACP have no such search ports.
The SDK builds no index and does not scan transcripts to emulate missing search.

## Accept mutation effects and retain cleanup

Management defaults disabled. Select each supported operation through `management`, then supply
`acceptEffects` exactly matching the offered `scope`, `descendants`, `active` and `atomicity`.
Project-scoped root admission does not restrict a native cascade's cross-project descendants.
Caller quiescence covers the affected subtree and other writers; preflight is not an atomic lock.

Well-formed mutations return `applied`, `not_applied` or `outcome_unknown`. Preserve valid native
receipts even when later cleanup fails. After uncertain native dispatch, never replay automatically:
further mutation is fenced while reads remain available; inspect native state and reopen deliberately.
A late receipt cannot rewrite an already returned unknown outcome. Grok rename/delete qualify only
the explicitly selected owned, unauthenticated, networkless, caller-quiescent local composition.
Borrowed or authenticated local/remote Grok effects remain unqualified.

Read-only ports do not promise filesystem immutability. The source descriptor discloses native
initialization, migration, index or auxiliary-file effects: Cursor SQLite and Codex can write native
storage; OpenCode/borrowed sources have unknown effects. Owned Grok reads use read-only sessions
mounts and scratch native indexes. The package does not add an SDK shadow archive or automatic
user-store migration fallback.

Cancellation releases the caller wait while entered native work retains admission until settlement.
Always close the source in `finally`. Close stops new work, aborts entered work, initiates owned
disposal and joins actual settlement. If cleanup fails, retain `AgentHistoryCleanupError` and its
`retryCleanup()` owner until it succeeds. Borrowed connections and supplied servers remain owned
by the caller; native stores are never scratch cleanup targets.

## Run the public examples

From the matching built `v0.4.4` checkout:

```sh
pnpm examples:history
```

The [history walkthrough](examples/history/README.md) supplies a credentialless synthetic source,
the reusable `browseHistory(history, options)` helper and a separate explicitly configured Claude
CLI. The helper preserves pages/coverage and closes its source. Its structural summary excludes
IDs, titles, text, paths and cursors; the reusable result retains actual records for the caller.
Browsing requires no runtime session or execution turn.

MS009 compiled and executed the unchanged examples from eight temporary development-version
0.4.3 archives across eight isolated compositions. That proof did not publish history and does not
identify the newly packed 0.4.4 bytes. The earlier history/generation candidate separately passed a clean matching
eight-package 0.4.4 installed-consumer check, including the history and generation examples.
Retained history qualification does not establish backend authentication, billing, arbitrary
stores/platforms or private Hostd deployment; the structured execution tuple above has its own
scope. The published ten-package release retains its own archive, provenance and registry-consumer
identities. [RELEASING.md](RELEASING.md) records completed setup for all ten package names and
preserves separate authorization for future publication, trust changes and promotion.

Selective exports accept `{ kind: 'files', paths }` for streamed exact regular files or
`{ kind: 'subtree', path }` for one directory and its descendants. Subtrees preserve their
workspace-relative root in every output path; use `{ kind: 'workspace' }` explicitly for the full
tree. Docker checks stable non-symlink ancestors and requests only the selected target after
compute removal. No fallback downloads and filters the full workspace.

### Dataset attachments, quota requirements and recovery v2

Docker can explicitly attach pre-existing Linux dataset images with `datasets: [{ name, imageDigest, subpath? }]`. The fixed guest target is `/datasets/<name>` and is read-only. This option requires stable Engine 29.1.4 or newer and the admitted containerd/overlayfs image-store profile; omitted datasets retain baseline admission. Images remain borrowed and survive cleanup. Workspace imports/exports still target the private writable workspace. Native Mac dataset proof remains pending.

`policy.workspaceDiskQuota` input omission becomes `{ kind: 'not_requested' }`; effective policy now uses that object instead of the old `'unsupported'` string. `{ kind: 'required', bytes, accounting: 'allocated_blocks' }` expresses an application requirement and throws before driver reservation with current unsupported backends. No universal disk quota is introduced.

Recovery records now require format `agenai.sandbox-recovery.v2` and a mandatory `configurationDigest`. Update custom drivers and persisted-record schemas together. Docker uses `engine-1.52-v4-<profile>` and binds normalized profile/user/workload-image/dataset configuration separately from request policy. Version 1 records are rejected before reconciliation; clean up still-owned older resources using their original compatible controller before upgrading. Do not rewrite a legacy record into v2 or treat borrowed dataset images as deletion authority.
