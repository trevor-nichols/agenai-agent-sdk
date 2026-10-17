# @agen-ai/provider-acp

An optional provider for the AgenAI coding-agent runtime. It translates the stable
Agent Client Protocol wire version 1 into the existing Agent Protocol V12 session
API. The coordinated published release is `0.4.2`; published `0.4.1` qualification remains
historical evidence for its exact V11 artifacts.
The package is ESM, MIT licensed, side-effect-free on import and requires Node.js
22 or newer. It depends only on the public transport, runtime and protocol packages;
the core packages remain independent of ACP.

The provider pins the transport's `schema-v1.23.0` stable profile. It translates
ACP into current V12 capabilities and rejects unsupported semantics explicitly.
Connection negotiation, configured host facilities, and mapping policy fix one
capability envelope per instance; every later connection must match it.

Tool approvals default to once-only scoped consequences. Both constructors accept an explicit
`permissionMapping` selection for completely described provider-managed remembered choices.
Native option labels or kinds alone never establish their consequences. See
[Remembered tool approvals](#remembered-tool-approvals) for mapping admission and qualification limits.

## Unknown extensions

Both `createAcpProviderDriver` and `createNodeAcpProviderDriver` default to
`unknownExtensionPolicy: 'standard'`. This deliberately changes the public
provider default in `0.4.0`. Direct transport clients
continue to default to `'reject'`. AgenAI's controlled private Hostd composition
explicitly selects `'reject'`; public interoperability does not change that policy.

Standard handling discards otherwise unregistered underscore notifications after
the transport's envelope, size and notification-rate checks. An unsupported
underscore request receives a correlated `-32601` response without invoking a
host callback. Core methods, exact registered extensions and protocol controls
keep their existing validation; malformed registered payloads and unknown `$/`
controls still fail the connection. Ignoring an optional message such as
`_x.ai/mcp/servers_updated` establishes no MCP tool exposure or feature support.
Discarded notifications produce no neutral event or effect authority. Request
errors remain within the existing outbound byte/backpressure budget and retain
their IDs until writing finishes; all other transport/provider bounds remain
unchanged. Required vendor features still need an explicit supported mapping.

Set `unknownExtensionPolicy: 'reject'` on either provider constructor to retain
strict handling on every connection, including authentication reconnects and
native resume. Only `undefined` selects the default; other values outside
`'standard'` and `'reject'` throw `TypeError` before connection acquisition or
process launch. The constructor captures the resolved policy, so later mutation
of its options cannot change it. The policy is host composition and is absent
from the closed, empty serialized `driverConfiguration`. Changing policy needs
a fresh driver and materialization; uncertain native work must not be retried
under a different policy.

## Capability matrix

| Surface | Supported behavior and requirements |
| --- | --- |
| Turns and requests | Default text turns, streamed assistant/reasoning text, tool progress, cancellation and once-only exact-action permissions by default, with opt-in complete remembered-choice mappings. One execution retains the original native prompt across request waits and answers. |
| Resume | Exact persisted binding using advertised `session/resume`, otherwise advertised `session/load`. Load history is bounded and suppressed from new-turn output. No automatic recreation after failure. |
| Configuration | Managed by default. Explicit `configuration: 'selectable'` maps observed boolean/select catalogs, with a session-mode fallback when config options are absent. Unknown metadata differs from observed empty metadata. |
| Forms | Canonical boolean/single-select/multi-select forms that fit V12 constraints. An intent stage preserves decline separately from cancel, followed by answers on the same native waiter. Explicit host form facilities can handle broader native forms. |
| Images | Inline base64 PNG/JPEG/WebP only when the peer advertises image input, within image and total turn budgets. No implicit local-file read or URL fetch. |
| Plans | Complete replacements of observed turn plans. A mode called “plan” does not establish enforced planning behavior or approval authority. |
| File changes | Partial structured observations from native tool diffs. Canonical paths contained by the working directory become sorted relative display paths without filesystem reads. Unfinished tools remain unknown at ordinary turn completion. No final workspace diff or Review artifact is inferred. |
| Commands | Session catalogs and invalidations from `available_commands_update`. Missing metadata remains uninitialized; an observed empty list is available and empty. |
| Authentication | Explicit method-to-flow selection and host interaction facilities. Agent methods retain the authenticated connection; terminal methods require a host facility and fresh verified initialization afterward. |
| Files and terminals | Explicit host callbacks, correlated to the bound native session. Terminal support requires the complete output/wait/kill/release lifecycle; embedded terminal transcript references remain unsupported. |
| MCP setup | Static host-approved `mcpServers` and optional owned `sessionMcpBinding` factory for creation/resume. HTTP/SSE require advertised peer support. Configuration is not observed tool exposure. |
| Session decisions | Opt-in `grok-folder-trust-v1` on the Node constructor, with a required host execution boundary and handler registered before create. This outside-turn mapping has its own exact support and qualification scope below. |

Through-turn branching, same-turn steering, enforced plan mode, persistent
SDK-owned tool-approval grants, context usage/compaction, account quota, effective skill/rule
inventory, collaboration, generated resources and artifact publication remain
unsupported. ACP usage counters can decrease without confirmed compaction and
cannot satisfy V12's context continuity contract. Unsupported media output fails
explicitly rather than disappearing from an otherwise successful transcript.
Embedded terminal references also fail explicitly: a mutable, possibly truncated
terminal snapshot does not provide an ordered append-only transcript. Agents can
use terminal RPCs and emit their observed output as ordinary text/tool content.

ACP administration (list/delete/logout/import) has no portable provider API in
this release. Host-owned integrations may use the transport directly with their
own authorization and native lifecycle policy. No capability grants authority
over other conversations or account state.

## Operational failures and uncertainty

The provider maps supported standard `schema-v1.23.0` prompt errors into V12 `AgentError` values.
Standard `-32000` reports `authentication` with an `authenticate` user-action hint; `-32602` reports
`invalid_request`; `-32603` reports `provider`; standard parse/request/method errors report `protocol`.
Other remote codes remain `unknown` with unknown recovery. Mapping uses the standard error code,
without copying remote messages, arbitrary data or xAI-specific meanings into a canonical failure.
Generic ACP does not infer rate limits or exhausted allowance from vendor code `-32003`, and its
account-quota capability remains unsupported.

A validated prompt error response establishes a failed terminal result. A lost response, process loss,
or unconfirmed cancellation after dispatch does not establish that result; preserve uncertainty and
close the unusable session without replaying its prompt. Operational classification cannot override
native settlement or cleanup ownership. The provider does not infer `runtime.retrying` from an RPC
failure, add a retry loop or enable a vendor retry extension. A future faithful mapping still needs
explicit native evidence and turn correlation.

## Explicit Node process launch

Import process construction through the exact `/node` entrypoint. Supply an
absolute executable and working directory. Arguments are literal strings and
spawning always uses `shell: false`. Only the supplied environment is passed to
the child; the current process environment is never inherited.

```ts
import {
  parseAgentConfigurationRevisionId,
  parseAgentInstanceId,
  parseAgentProviderKey,
  parseAgentSessionId,
  parseAgentTurnId,
} from '@agen-ai/agent-protocol';
import {
  createAgentProviderRegistry,
  isAgentProviderSessionCleanupErrorFor,
  type AgentProviderCreateSessionInput,
  type AgentProviderSession,
} from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';

const providerKey = parseAgentProviderKey('my-acp-agent');
const instanceId = parseAgentInstanceId('my-agent:primary');
const driver = createNodeAcpProviderDriver({
  providerKey,
  launch: {
    executable: '/opt/my-agent/bin/agent',
    args: ['--acp'],
    cwd: '/work/project',
    env: { HOME: '/work/agent-home', PATH: '/usr/bin:/bin' },
  },
});
const registry = await createAgentProviderRegistry({
  drivers: [driver],
  definitions: [{ providerKey, instanceId, driverConfiguration: {} }],
});
const instance = registry.requireInstance(instanceId);
const openingInput: AgentProviderCreateSessionInput = {
  sessionId: parseAgentSessionId('session:example'),
  workingDirectory: '/work/project',
  configuration: {
    kind: 'managed',
    revision: parseAgentConfigurationRevisionId('configuration:1'),
  },
  onBindingCreated(binding) {
    // Persist this exact opaque binding before proceeding with application work.
    console.log(binding);
  },
};
let session: AgentProviderSession | undefined;
let retainedOpeningCleanup = false;
try {
  try {
    session = await instance.adapter.createSession(openingInput);
  } catch (error) {
    retainedOpeningCleanup = isAgentProviderSessionCleanupErrorFor(error, openingInput);
    throw error;
  }
  const execution = session.startTurn({
    turnId: parseAgentTurnId('turn:example'),
    interactionMode: 'default',
    parts: [{ type: 'text', text: 'Explain this project.' }],
  });
  for await (const output of execution.outputs) {
    console.log(output);
  }
} finally {
  if (!retainedOpeningCleanup) {
    await session?.close({ reason: 'shutdown' });
    await registry.dispose();
  }
}
```

An exact failed-opening cleanup receipt keeps the registry owned. Retain the receipt and call its
`retryCleanup()` before disposing the registry. A failed session close likewise skips registry
disposal; retain that session and retry its cleanup before releasing dependent owners.

The registry validates instance, adapter, capability, and canonical output
contracts. `startTurn` reserves one execution; its native prompt starts lazily
when `execution.outputs` is first consumed. Keep one output consumer through
actual terminal settlement. Requests are installed before `request.opened`, so
an answer can be sent immediately from that event with
`await execution.resolveRequest({ resolution })`, independently of the next
output pull. One canonical request is offered at a time; additional bounded
native callbacks retain FIFO order while unrelated output continues.
The immediate `await` above is appropriate once the answer is already available. If a person must
choose it, enqueue the exact request to a separately owned, signal-aware handler and keep pulling
outputs; join that handler after initiating cancellation and close. The public
[live-output example](../../examples/live-request-output.ts) demonstrates the ownership without
native launch or credentials, and the [migration guide](../../MIGRATING-TO-0.4.md) shows before/after code.

The response Promise reports `delivered`, `rejected` with `requestState` of
`pending` or `unavailable`, or `delivery_uncertain`. For ACP, `delivered` means the
exact still-live local callback accepted the answer, or the canonical form flow
accepted its intent step. An intent receipt does not await the fields answer.
The later JSON-RPC write has no peer acknowledgment; delivery does not establish
wire receipt or model consumption. A later transport failure belongs to the
original execution's output and cannot revoke an accepted response or authorize
its replay. Local input/correlation and pre-abort failures reject with their
precise errors. Do not retry an uncertain response or prompt.
Only `rejected/pending` preserves the exact response's eligibility for a fresh valid answer.
`rejected/unavailable` removes it without completing the original execution. Request expiry,
accepted interruption and observed terminality fence later answers; an older waiting observation
never restores that eligibility. Close starts native cancellation before joining response work.
If cleanup fails, retain the session or exact opening-cleanup receipt and its dependent registry/MCP
resources until the owned retry succeeds.

The `startTurn` signal and deadline govern the entire native prompt, including
time spent waiting for permission or a form answer. Keep them valid through
terminal settlement. `execution.resolveRequest` has its own operation signal,
which does not replace the original prompt lifetime. Await each output
destination's acknowledgement before advancing the iterator. Persist the exact
opaque binding before application work; a display log is not durable session
storage.

To launch a registry installation, first acquire an exact installation reference
and resolve its verified recipe through `@agen-ai/acp-registry/node`. Pass the
absolute executable, literal arguments and approved environment to this same
constructor. Retain that reference until every session and owned process has
successfully closed. Startup or disposal failure does not authorize releasing it;
the host must retain ownership and establish native-process quiescence.

## Injected connections and ownership

The root entrypoint exports `createAcpProviderDriver`. Its constructor accepts
`providerKey`, `createConnection`, and optional `limits`, `configuration`,
`authentication`, `host`, `mcpServers`, `sessionMcpBinding`, and `permissionMapping`. The connection factory receives the public
`instanceId` and an initialization `signal`. Return fresh, exclusive Node
`stdout`, `stdin`, and optional `stderr` streams for every invocation, with one of:

- `{ ownership: 'owned', stdout, stdin, stderr?, release }`: the provider invokes
  the lease's idempotent release callback when it closes the connection.
  Concurrent cleanup is coalesced, successful release is retained, and failed
  cleanup can be explicitly retried through session or registry disposal.
- `{ ownership: 'borrowed', stdout, stdin, stderr? }`: the provider removes its
  stream listeners on close and leaves stream destruction to the caller.

The factory owns acquisition work until it returns a lease and must honor its
abort signal. Initialization has one deadline covering acquisition and the
initialize request. If an uncooperative factory delivers an owned lease after
that deadline, the provider invokes its release callback asynchronously; callers
remain responsible for factory work that never returns a lease. A release
callback owns only the resources of its own lease.

Materialization eagerly initializes one connection and reserves it for the
first session. Later sessions acquire fresh connections, verify the same frozen
initialization envelope, then create their own native session. Driver
configuration is strictly `{}`; launch and connection authority belong to the
driver constructor. The built-in `/node` launcher supports POSIX systems and creates
a separate process group for each connection. Closing a session or instance sends
`SIGTERM` to that group, then escalates to `SIGKILL` if necessary. Each phase waits
up to `shutdownTimeoutMs`; successful cleanup requires both group disappearance and
closed child streams, including when the leader exited first or descendants closed
their streams. Failed cleanup remains available for explicit retry.

This process-group ownership is not a sandbox: descendants that deliberately leave
the group require host-provided OS containment. The host must reap exited children.
The built-in launcher rejects Windows before spawning with
`acp_provider_process_platform_unsupported`. Windows hosts can use
`createAcpProviderDriver` with an owned connection factory backed by their own process
supervisor, such as a Windows Job Object; the SDK does not supply a native Windows
process-tree launcher in `0.4.0`.

## Remembered tool approvals

`permissionMapping` is constructor configuration on both `createAcpProviderDriver` and
`createNodeAcpProviderDriver`. It is captured when the driver is created and is absent from the
empty serialized `driverConfiguration`. Omission or `{ mapping: 'once-only-v1' }` retains the
conservative once-only subset of each menu and advertises `providerManagedRemembrance: false`.
A remembered-only native menu is unsupported under that default.

For a peer whose complete permission behavior you have inspected and qualified, declare its exact
initialized identity and complete ordered menus:

```ts
import type { AcpPermissionMappingSelection } from '@agen-ai/provider-acp';

const permissionMapping = {
  mapping: 'declared-complete-consequences-v1',
  agentInfo: { name: 'example-agent', version: '1.2.3' },
  menus: [{
    toolKind: 'edit',
    options: [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'remember-allow', kind: 'allow_always' },
      { optionId: 'deny-once', kind: 'reject_once' },
      { optionId: 'remember-deny', kind: 'reject_always' },
    ],
  }],
} as const satisfies AcpPermissionMappingSelection;
```

Pass that value with your ordinary connection or Node launch options. The example identities are
illustrative. Selecting this mapping is your attestation that every listed option has only its
current allow/deny decision and once-only or provider-managed remembered consequence. A choice
that also changes mode, clears context or grants another authority needs a different complete
mapping; this API cannot discover hidden effects or authenticate the implementation from its name.

Declarations contain 1–16 menus, each with 1–16 options. Native IDs must be canonical strings of
1–256 characters and unique within each menu. Menu signatures must be unique. Peer names are
bounded to 256 characters and versions to 160; edge whitespace and control/format characters are
rejected. Tool kinds use the pinned ACP standard vocabulary. Selection uses exact identity, tool
kind and the complete ordered ID/kind list; native labels are display data. There are no predicates,
regular expressions, native payload bags or custom mapping callbacks.

The capability reflects the selected declarations. Remembered-only menus advertise no precise
modes and `providerManagedRemembrance: true`; combined menus advertise once/exact-action as well.
A remembered option has the neutral label “Allow and remember” or “Deny and remember” and an
explanation that duration and future matching are unspecified. Native wording is omitted from its
optional description. An offered choice never promises that a provider actually saved a rule.

The SDK keeps distinct offered IDs, including several options with the same immediate decision.
Resolve one exact public option ID on the original execution. The live callback returns its exact
original native ID once. Deny-once, deny-and-remember and cancellation remain distinct. Continue
reading the original execution outputs through terminal settlement; a delivery receipt establishes
local callback acceptance, not native persistence, later matching or successful tool execution.

Malformed constructor selection throws `TypeError` before acquisition. A selected peer identity
mismatch fails initialization with `acp_permission_profile_mismatch`; retain any failed cleanup
owner as usual. Declared menu mismatches or unqualified option/request metadata fail with
`acp_permission_consequence_unsupported`. Duplicate IDs are rejected across the entire native menu
before any filtering. Invalid menu size fails with `acp_permission_options_invalid`. The default's
remembered-only refusal remains `acp_permission_persistence_unsupported`.

The built-in `{ mapping: 'grok-build-1.0.50-edit-remembrance-v1' }` selects the narrowly inspected
Grok Build 1.0.50 edit behavior. Its peer must report `_meta.agentVersion: '1.0.50'`. It recognizes
only the inspected `SearchReplace` edit input with `replace_all: false` and the ordered native menu
`allow-edits-session`/`allow_always`, `allow-once`/`allow_once`, `reject-once`/`reject_once`.
Other action categories retain the once-only subset with an explicit warning on the original
output stream; unsupported remembered-only menus fail. Native terminal remembrance and remembered
denial are not qualified by this edit profile. Duration and applicability remain unknown despite
native wording or observed same-session behavior.

The selected constructor and your host-owned installation/launch attest to the exact inspected
native executable; the reported version does not authenticate its bytes. The inspected candidate
is Linux x86_64 Grok Build 1.0.50 (`c58f321264ba`), SHA-256
`c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5`, launched with
`agent --no-leader stdio`. Controlled mapping tests prove exact reply behavior; the installed
native fixture proof below separately establishes the selected edits' actual effects and cleanup.

This turn-level selection is independent of session-lifetime folder trust, host filesystem/terminal
facilities and unknown-extension policy. It creates no SDK permission database, automatic answer
cache, revoke operation or private Workspaces execution authority.

### Qualified remembered-edit scope (SDK03)

Two final native fixture attempts used the genuine executable above, the selected
`grok-build-1.0.50-edit-remembrance-v1` mapping, modern stable `schema-v1.23.0` and a matching
installed seven-package `0.4.1`/Agent Protocol V11 set. The recorded tuple is Linux x86_64 kernel
`7.0.0-38-generic`, Node `24.18.0`, pnpm `11.7.0`, systemd `259.5`, Bubblewrap `0.11.1` and owned
tmpfs state. An isolated loopback model fixture drove actual native tool calls without real account
credentials or paid/backend inference. The SDK owned the only ACP reader and responder; a passive
observer independently checked exact native choices and actual fixture effects.

The first attempt used one public/native session and six turns:

| Turn | Observed request and effect |
| --- | --- |
| Once-only edit | One request; exact once-only native choice delivered once; edit performed. |
| Repeat after once-only | Asked again; exact once-only choice delivered once; edit performed. |
| Remembered edit | One request; exact remembered native choice delivered once; edit performed. |
| Exact repeat after remembrance | No new request; edit performed. |
| Neighboring owned file | No new request; edit performed. |
| Uncovered terminal action | Asked again; effect occurred after its exact once-only approval. |

The second attempt reopened the verified retained owned state with both a fresh native process
and a distinct native session. Its first edit asked again and performed the expected edit after
one exact once-only answer. This combined restart/new-session observation does not isolate the
effect of either change or define a general expiry or storage contract. Same-process second-session
behavior was observed only in separate native discovery, outside this installed Node composition.

For both attempts, successful public `session.close()` preceded an independent empty checkpoint
of the same physical workload cgroup while the controller remained alive, before registry or host
disposal. No earlier external cleanup intervention or OOM kill occurred. Native effects, answer
correlation and SDK cleanup were checked independently.

The exact retained report SHA-256 identities are
`4ea3ea5b9fac16761b32919ac476ec9b4621f2e99434c441d9eefadb469c5a6b` (six-turn attempt) and
`bd93b95c3fdba51b0f7f03eaea0393e796a4626298eaedb2a9ebf1ce9bb36730` (retained-state restart).
The native-used package archives have these SHA-256 identities:

| Package at `0.4.1` | Native-used archive SHA-256 |
| --- | --- |
| `@agen-ai/validation` | `84d97191d2175be1c7d83e86a007157b80c303088b94be0c05ec6961e2a41729` |
| `@agen-ai/agent-protocol` | `5a647b2fa504ec3175d58075f503f5e9e435186ec0e8c0758e74ea37741ad192` |
| `@agen-ai/agent-runtime` | `81dc5ed8940d96bc5f3ae3f0fdb2ad862af87a087e57032db41995a29dacf4b4` |
| `@agen-ai/agent-orchestration` | `914ad78cdac3ee6af1fe6a7d8522e5c216a3de670816462a082f5c0bde0988fa` |
| `@agen-ai/acp-transport` | `81314926f24fa428e910c0256671add61f525cac036d5b2841185a7c3e953894` |
| `@agen-ai/provider-acp` | `2a68df821134fc0af48ab850c1a48ad33be74b8e42e64a6d916bfe2eb84acf6a` |
| `@agen-ai/acp-registry` | `ab317cc347bf53dcd0045aff4a6d74cb429fc6781c336ea6ed128ced13bdaa07` |

Later documentation or packing can change archive bytes; the same version is not an identity
check. Reuse of this evidence requires comparison of the exact installed dependency closure,
runtime/declaration members, mapping and host composition. The earlier SDK02 folder-trust proof
below used different `0.4.1`/V10 artifacts and establishes a separate session-lifetime behavior.

Duration and applicability remain unknown. This fixture proof does not qualify arbitrary path
matching, separate projects/profiles, remembered denial, terminal remembrance, revocation,
worktree/account/distributed behavior, real-model inference or other native/runtime pairings.
It does not publish packages, integrate a consumer application or enable private execution.

## Session-lifetime folder decisions

The `0.4.1` release includes the opt-in mapping on
`createNodeAcpProviderDriver`:
`sessionInteractions: { mapping: 'grok-folder-trust-v1' }`. Supply an explicit
`executionBoundary` at construction and the generic `interactions.onRequest`
handler on each `createSession` input before opening. Materialization itself
remains noninteractive. The mapping is absent by default, and ordinary standard
unknown-extension handling never enables it implicitly.

The selected launch arguments are exactly `['agent', '--no-leader', 'stdio']`.
The adapter exposes the exact `sessionInteractions.mappings` tuple
`{ openingOperation: 'create', requestKind: 'decision' }`, exclusive producer
ownership and, in current 0.4.2 source, `humanWait: ['bounded', 'until_withdrawn_or_closed']`. The handler receives a neutral workspace
decision and can keep its response capability after opening returns, before
any model turn. Use the generic
[runtime lifecycle](../agent-runtime/README.md#session-lifetime-interactions)
for presentation, exact offered choices, receipt handling and cleanup. The core
[runnable example](../../examples/lifecycle-interactions.ts) requires no ACP
dependency, native account or network.

| Phase or surface | Selected mapping support |
| --- | --- |
| Create a session with an early handler | Workspace decision may remain pending after opening returns. |
| Grant or decline the offered decision | One bound response, with a local delivery receipt separate from native effect. |
| Close while unanswered | Retires eligibility, joins the native producer and callback, and refuses a late response. |
| Interactive materialization | Unsupported; no materialization handler is added. |
| Resume or branch in this selected profile | Unsupported. Generic ACP resume remains a separate unselected capability. |
| Injected/shared root connections | Unsupported for this mapping; the Node-only execution boundary is required. |
| Session forms or authentication questions | Unsupported by this outside-turn decision mapping. Existing turn/form and adapter authentication APIs remain separate. |

The grant consequence covers current and future configuration for the workspace
and is provider-managed persistent trust that can affect other sessions using
that profile. Detected configuration categories do not narrow it. Decline leaves
configuration gated without revoking old grants or proving a persisted denial.
Do not expose native request IDs or use a parallel transport responder. Only
the offered neutral response capability may answer the request.

`delivered` establishes acceptance by the local provider handler. It does not
universally prove native receipt, loaded configuration or stored trust. An
entered delivery failure or timeout is uncertain and fences further mutation;
close without resending the choice. A request's terminal promise or aborted
presentation signal cannot replace full producer/callback cleanup. Retain the
session, opening cleanup receipt and dependent host/installation owners when
cleanup fails.

### Qualified session-lifetime scope (SDK02)

The earlier SDK02 native qualification covers Grok Build `1.0.50` (`c58f321264ba`),
executable SHA-256 `c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5`,
direct no-leader stdio, this selected mapping, modern stable `schema-v1.23.0`,
its retained installed public SDK `0.4.1`/Agent Protocol V10 artifacts, API-key authentication,
Linux x86_64 kernel
`7.0.0-38-generic`, Node `24.18.0`, and the exact retained reference,
toolchain, network and dependency inputs. It is local qualification, with no
package publication or consumer-repository integration implied. These exact earlier artifacts
are distinct from the SDK03 V11 remembered-edit artifacts above despite sharing version `0.4.1`.

Three separate native runs established grant, decline and pending close. Grant
additionally observed the vendor-written isolated workspace trust file. Decline
established local acceptance and absence of a grant; no further hidden native
acknowledgment was attested. Pending close sent no choice before close, joined
the handler and rejected the stale grant as unavailable. Each run independently
enrolled the genuine target and observed the same stable cgroup empty after SDK
close with the consumer alive, before registry or host disposal, without external
intervention. The trusted host was retired afterward.

Native wire reply correlation and prompt-frame counts remain unobserved. Zero
SDK turn invocations is a frozen-consumer-source claim. Separate installed
controlled peers prove exact wire correlation, no prompts and failure ownership;
the real Linux controlled lane proves descendant containment and negative
close-checkpoint behavior. Neither substitutes for native effect evidence.
The bounded native runs fit the reference's 64-task/512 MiB/180-second limits
for these setup scenarios only. They establish no general model-turn sizing,
other builds/platforms, browser login, native durable recovery, SDK-managed
remembered permissions or private execution support. The earlier failed native
ownership attempt remains unqualified.

The current V12 decision descriptor omits `expiresAt` because this native mapping reports no
provider-owned expiry. The bounded host timer remains a separate policy boundary;
`humanWait: { kind: 'until_withdrawn_or_closed' }` omits that human timer and
rejects an explicitly supplied `limits.requestTimeoutMs`. Initialization,
response observation, authentication and cleanup keep their finite bounds.
Responses require `{ kind: 'decision', choiceId }`. Generalized runtime terminal/deadline and
exact support declarations apply to this mapping: an answered terminal records
`{ kind: 'answered', response: { kind: 'decision', choiceId } }`, and host timeout records
`{ kind: 'expired', source: 'host_policy' }`. A validated consumer handle exposes the effective
`deadline` separately from the provider descriptor. Raw driver instances return candidate adapters
whose interaction callback receives `kind: 'direct'`; registry materialization installs the
validated consumer facade. Session forms, plan reviews and native continuations
remain unsupported by `grok-folder-trust-v1`. The retained SDK02 native evidence
above remains specific to its original finite waiting configuration.

## Restored plan requests in current 0.4.2 source

The Node constructor accepts a separate explicit selection:
`sessionInteractions: { mapping: 'grok-build-1.0.60-session-requests-v1' }`.
It requires an exclusive descendant-owning `executionBoundary`, exact direct
arguments `['agent', '--no-leader', 'stdio']`, modern stable ACP
`schema-v1.23.0`, and initialized native `_meta.agentVersion: '1.0.60'`.
The version observation is checked on every connection; it does not authenticate
an executable or its publisher. The host owns executable selection and byte verification.

This source mapping declares exactly `resume / plan_review` and
`resume / plan_review / after_open_return` continuation timing. It uses
`session/load` for the selected restoration. Install `interactions.onRequest`
and `nativeContinuations.onExecution` before resuming. The continuation handler
must begin pulling its sole `execution.outputs` iterator before an approval or
revision response can enter native work. A caller turn and a native continuation
share the same execution slot and continuous output validation.

The exact `_x.ai/exit_plan_mode` callback supplies a bounded complete plan
snapshot and three offered choices. Approval maps to `{ outcome: 'approved' }`;
revision maps to `{ outcome: 'cancelled', feedback }`; abandonment maps to
`{ outcome: 'abandoned' }` and needs no execution reservation. A revised response
must identify the offered plan revision and carry its bounded feedback. Missing
or null plan content cannot become a fabricated review snapshot.

Approval and revision continue the native request without sending
`session/prompt`. The existing session turn/queue owner accepts a fresh
`_x.ai/queue/changed.runningPromptId` beginning `plan-resume-`, correlates live
output to that exact prompt, and completes only on its matching
`_x.ai/session_notification` `turn_completed` update. Normal completion requires
`stop_reason: 'end_turn'` and observed live output. Exact `stop_reason: 'cancelled'`
uses the existing admitted cancellation reason to report `canceled`, or `expired`
for a timeout, including cancellation after promotion before any assistant output.
An unsolicited native `cancelled` terminal also reports `canceled`, without
asserting that a caller requested interruption.
The original execution reader retains that terminal and cleanup. The pinned
[Grok cancellation source](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/cancel.rs#L842)
emits this exact cancellation terminal; historical `interrupted` is not an active
cancellation alias. Errors and foreign prompt/session identities remain failures.

Historical replay, a generic interaction-resolved notification and the local
response receipt establish no continuation completion. Prompt identities observed
in historical or replayed queue, output and terminal channels remain retained
under the existing shared queue/state budget, preventing later reuse as a fresh
promotion. Repeated notifications for the already owned current prompt remain
valid and do not reserve the same identity twice. Wrong, reused or competing
identities fail the owned session. Ordinary caller turns remain available after
that execution and its reader settle.

The selected 1.0.60 mapping also isolates direct native child-session observations.
Only a root-channel `_x.ai/session_notification` `subagent_spawned` announcement
with exact parent, child and subagent identities records that relationship.
Announced child queue notifications, stable session updates and native terminal
observations are validated and discarded before parent metadata, output,
continuation prompt tracking or completion. Unknown extensions, tool text and
permission metadata cannot announce a child. Arbitrary foreign sessions,
conflicting identity reuse and nested child announcements fail the owned session.

Each retained relationship shares the existing session queue's count and byte
budget; each identity is bounded to 256 UTF-8 bytes. Exact repeated announcements
reserve no extra state. Relationships remain reserved until session stop because
a child's prompt terminal does not establish child-session retirement. Historical
relationships are replay-only and cannot become live; discarded load-time child
observations still consume the opening replay budget. This observation scope adds
no public collaboration capability or child permission, filesystem, terminal or
form authority. Parent-addressed permission requests retain their existing root
session routing, and child-addressed requests remain rejected.

For an announced live child with an exact attempt identity, this mapping recognizes
one ordered native permission cancellation sequence. The child's
`pending_interaction` must first identify a permission tool. Its exact root-routed
`session/request_permission` callback must then identify that child through
`toolCall._meta['x.ai/requestingSessionId']` and the same tool ID. A subsequent
child `interaction_resolved` followed by a root `subagent_finished` with the exact
child/subagent/attempt identities and `status: 'cancelled'` withdraws only that
original callback. The existing request owner queues `request.unavailable` for a
displayed request before rejecting its reverse callback with `-32800`; an unseen
queued callback is removed without publishing its ID. A child `turn_completed`
notification supplies no permission cancellation authority.

An `interaction_resolved` notification alone cannot establish withdrawal because
it also covers answered and failed interactions. If its exact callback has not
already accepted an answer, new answer entry waits for corroboration under the
existing finite `cancellationTimeoutMs`; duplicate observations do not refresh
that deadline. Missing or contradictory corroboration fails and quiesces the
owned session without manufacturing withdrawal. An already entered answer keeps
its original receipt. Native callback reservations remain retained until actual
transport settlement and entered host work finish. Child/tool census entries,
including retired identities and their possible answer-wait state, share the
session count and byte budgets until stop. Pre-admission, prior-turn and replayed
facts cannot attach to or withdraw a future callback. This mapping consumes
observed native facts; it adds no child cancellation command or child-addressed
request authority.

The selected lifecycle request queue retains at most
`min(maxPendingRequests, 16)` native turn callbacks and 1 MiB of request material,
within the existing shared session budget. Lower configured limits still win.
Queued, displayed, response-entered and canceled callbacks remain counted until
their actual transport settlement and any entered host callback finish. Generic
ACP compositions retain the existing configurable request ceiling of 1–256
and default 16; the selected request-material ceiling does not replace the
8 MiB default output budget.

Exact standard `$/cancel_request` disables only its correlated reverse callback.
A displayed turn request emits one `request.unavailable` with reason `withdrawn`
on its original execution before the next surviving FIFO request opens. A queued
canceled callback stays unseen. The protocol cancellation response is separate
from a human denial, and an already entered local delivery receipt keeps its
truth even if cancellation or a later write failure occurs. Output continues
through the original reader.

Both finite and `until_withdrawn_or_closed` human waiting are accepted for these
selected session requests. Actual provider expiry remains independent. This
mapping adds no create/branch session review, outside-turn form, remembered
approval, durable native recovery or private Hostd authority. Folder-trust
selection and its create-only restriction remain independent.

Controlled public-constructor and pipe-boundary proof establishes generic FIFO,
queued withdrawal, exact continuation admission and resource bounds. Final MS009
installed-native proof separately qualifies Grok Build 1.0.60 on Linux x86_64 /
Node 24.18.0 with modern stable `schema-v1.23.0`: exact active A withdrawal with
zero A answers, later B once-only delivery/effect, the original output terminal,
fresh retained approve/revise continuations with no caller prompt, and no-work
abandonment during its bounded observation. Each selected case independently
observes the original workload empty after first SDK close while the consumer
remains alive, before disposal.

That current Grok composition explicitly sets `GROK_AUTO_WAKE=0`,
`GROK_WORKER_THREADS=1`, `GROK_SUBAGENT_WORKER_THREADS=1` and
`GROK_GIX_STATUS_THREADS=1`. Automatic parent wake remains unqualified. Native
permission forwarding is observed to serialize; simultaneous live Grok callbacks
into the SDK FIFO queue remain unqualified under the user-accepted MS009 amendment.
Generic ACP FIFO and the separate Claude diagnostic's native FIFO proof do not
extend that Grok claim. The selected human-wait observation is 250 ms, which proves
that mapping's bounded observation rather than arbitrary native waiting duration.

The campaign uses isolated scripted model responses and a constant fake credential;
it qualifies no real backend authentication, inference or billing. The separate
Grok 1.0.50 remembered-edit regression retains its historical launch environment
and recorded task-limit warnings; it makes no capacity-headroom claim. Existing
Grok 1.0.50 qualification and the legacy `v0.11.4` transport profile retain their
original scope. The [0.4.2 migration guide](../../MIGRATING-TO-0.4.2.md) identifies
the executable examples, supported tuples and unsupported native paths.

## Reserved execution ownership

This surface is included in the `0.4.1` release.

The Node constructor also accepts an explicit `executionBoundary`. This host-owned
port is useful when native descendants can create their own sessions or process
groups. It is required when selecting
`sessionInteractions: { mapping: 'grok-folder-trust-v1' }`; omission fails at
constructor admission before materialization. The root injected constructor does
not accept this Node-only option. Ordinary unselected Node drivers keep the
process-group launcher described above.

Import the types from `@agen-ai/provider-acp/node`. A boundary synchronously
reserves one fresh, inert owner for each immutable launch recipe:

```ts
interface NodeAcpExecutionBoundary {
  reserve(input: NodeAcpExecutionInput): NodeAcpExecutionReservation;
}
```

The recipe contains the exact absolute executable, literal arguments, working
directory, explicit environment and `shutdownTimeoutMs`. `reserve` must acquire
no resources and start no asynchronous work. The SDK retains its bound `start`
and `release` methods before entering startup. `start(context)` establishes the
operating-system boundary before executing native code and returns ACP streams;
it receives the current initialization signal. `release()` must synchronously
fence further startup, initiate termination, and join entered startup, streams
and the complete descendant workload. It must work before, during and after
startup. Late startup results remain owned by that same reservation.

A supplied object is an ownership contract, not containment proof. The host must
prevent the workload from leaving its boundary or controlling its supervisor.
A changing PID list or killing one process group cannot establish that guarantee.
The standalone [Linux reference](../../examples/execution/linux/README.md) uses
explicit cgroup delegation and isolated supervisor controls. Its platform and
host prerequisites are separate from the portable SDK API; there is no automatic
privilege escalation or fallback to weaker ownership for the selected mapping.

For the qualified Linux composition, retain the external host before starting
it, then give its boundary to the Node driver. The host supplies the physical
installation, workspace and each writable profile/runtime/temp mount plus an
explicit native environment:

```ts
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import { createLinuxExecutionHost } from '../../examples/execution/linux/boundary.mjs';

const host = createLinuxExecutionHost({
  network: 'host',
  networkInputs: {
    resolver: '/etc/resolv.conf',
    hosts: '/etc/hosts',
    certificates: '/etc/ssl/certs',
  },
  mounts: [
    { path: installationRoot, writable: false },
    { path: workspaceRoot, writable: true },
    ...ownedProfileMounts,
  ],
});
await host.start();
const driver = createNodeAcpProviderDriver({
  providerKey,
  sessionInteractions: { mapping: 'grok-folder-trust-v1' },
  executionBoundary: host.executionBoundary,
  launch: { executable: approvedExecutable, args: ['agent', '--no-leader', 'stdio'],
    cwd: workspaceRoot, env: explicitNativeEnvironment, shutdownTimeoutMs: 2_000 },
});
```

Construct a registry with that driver and register the generic handler on
session opening. On success, close the session, dispose the registry, then
dispose the host. Retain the host if `start()` rejects. When qualifying cleanup,
keep the exact empty boundary for an independent checkpoint after SDK close
and before registry/host disposal. Networking and confinement remain explicit
host authority; the SDK does not create this Linux host automatically.

If initial materialization fails and cleanup remains incomplete, the `/node`
entrypoint exposes `NodeAcpExecutionCleanupError` and
`isNodeAcpExecutionCleanupError`. Through `createAgentProviderRegistry`, this
error remains the registry error's `cause`. Keep that original object and its
bound `retryCleanup()` callback until cleanup succeeds. Its `cause` preserves the
original startup failure and `cleanupError` records the failed cleanup attempt.
The callback retains the full acquired resource lifetime, including native work,
streams and entered provider callbacks. Serializing the error cannot preserve
this cleanup authority.

For example, a failed registry construction can be inspected without replacing
the callable owner:

```ts
import { AgentProviderRegistryError } from '@agen-ai/agent-runtime';
import { isNodeAcpExecutionCleanupError } from '@agen-ai/provider-acp/node';

if (error instanceof AgentProviderRegistryError && isNodeAcpExecutionCleanupError(error.cause)) {
  const retained = error.cause;
  await retained.retryCleanup();
  // Only now may the host release resources that depended on this native owner.
}
```

If this retry rejects, keep `retained` and the external host owned for explicit
recovery. A late cleanup success cannot change the original opening failure or
authorize another native action. Host intervention during qualification keeps
the original verdict failed even if recovery eventually succeeds.

Each cleanup attempt has one observation window of `2 * shutdownTimeoutMs`
(default four seconds, maximum sixty seconds). A timeout preserves actual pending
work. A retry gets a fresh observation window and joins the same work; it never
starts a second process or overlaps an unfinished release. Only a release that
actually settled with failure may be called again. A shorter runtime deadline
can return first while the same cleanup remains owned.

Once an instance exists, an unsuccessful session opening uses the existing exact
`AgentProviderSessionCleanupError` receipt. A returned session keeps its normal
`close` retry path. Retain the corresponding instance, registry and host supervisor
until all dependent cleanup succeeds. A successful session close establishes
native quiescence under the supplied owner's contract; independent qualification
must verify that the concrete owner fulfills it.

## Session-scoped MCP bindings

`sessionMcpBinding: { transport, create }` pairs a host-certified `http` or `sse` transport
with an owned factory. The provider declares runtime host-binding support only when that transport
was negotiated with the peer. The factory runs only when an opening carries a `hostBinding`, after
connection initialization and before native session creation or resume. Its trusted context carries
the instance/session IDs, working directory, opening operation, validated binding facade and an
acquisition signal. Parent identity never comes from a model tool argument.

An application using the optional orchestration package can compose its explicit bridge:

```ts
import { startDelegationMcpBridge } from "@agen-ai/agent-orchestration/mcp";

const sessionMcpBinding = {
  transport: "http" as const,
  async create({ hostBinding, signal }: import("@agen-ai/provider-acp").AcpSessionMcpBindingContext) {
    const bridge = await startDelegationMcpBridge({ binding: hostBinding, signal });
    return {
      mcpServers: [{ type: "http" as const, name: bridge.server.name, url: bridge.server.url,
        headers: Object.entries(bridge.server.headers).map(([name, value]) => ({ name, value })) }],
      release: bridge.release,
    };
  },
};
// Supply sessionMcpBinding to either ACP driver constructor.
```

Each opening needs a fresh binding and lease, including native resume. Dynamic entries must use the
declared transport and merge with static entries under the existing combined 32-server/512-KiB
limits. Duplicate names are rejected. The factory installs the binding's actual tools and
`tool_context` instructions; ACP does not claim a trusted system/developer instruction channel.
Neither the factory nor its transport may call the facade's `release`: the validated runtime owns
the original binding.

Factory rejection must leave no factory-owned producers. A partially acquired resource must remain
represented by an owned lease, including a lease delivered after cancellation. Closing quiesces
the native connection before releasing the MCP lease, then runtime closes the original binding.
`hostOperationTimeoutMs` bounds acquisition and cleanup waits without discarding the actual pending
factory or release promise. Pending or failed opening cleanup blocks new openings and authentication
changes until its retained responsibility is settled.
Failed opening cleanup retains an explicit retry receipt; failed or pending cleanup cannot be
treated as successful disposal. Ending a parent turn does not close its session binding or cancel
independently admitted children.

Advertising a transport and accepting a server list are configuration evidence. Qualify each real
agent/version separately with MCP initialization, tool discovery and an actual invocation. A peer
that accepts but never exposes tools is not qualified by this adapter. Configuration labels likewise
do not certify model, reasoning or fast-mode semantics: hosts must map exact selectable session
configuration, verify it before the first child prompt, and reject shared/global-only changes.

From the public SDK repository root, `pnpm examples:delegation:acp` runs a credentialless peer that
actually discovers and invokes the managed tools. It applies synthetic Standard/Max configuration
before the child prompt, lets the parent turn finish while the child waits for approval, and later
delivers the completion through another authorized parent turn. See `examples/delegation/README.md`
for the shared direct and qualified durable workflows. These fixtures do not qualify a real native
agent/version. Required vendor features still need an exact supported mapping, and explicit reject
policy can prevent session opening after successful initialization when the peer emits an
unregistered vendor extension. AgenAI Workspaces preferences and Hostd production rollout remain
separate product work.

In the standalone repository, the separate opt-in
[native qualification example](../../examples/delegation/native/README.md) documents the exact
Grok Build `1.0.50` (`c58f321264ba`) Linux x86_64 pairing qualified on 2026-10-11 with explicit API-key
authentication, `grok-4.3`, `Low` reasoning and verified request-default standard mapping. Final MS003
r6 direct and retained-installation reports record actual managed callbacks and once-only approvals,
real child-result consumption in a later parent turn, cancellation after provider start and closed
cleanup. Retained mode observes installer exit before a fresh worker reopens the verified store.
Those immutable version-1 reports use the prior continuation API; the current version-2 execution
reports require fresh installed qualification. Current hermetic checks establish synthetic behavior.
The review-applicability record preserves those reports and separately qualifies later preflight,
deadline and diagnostic-cleanup repairs. The locally authored catalog and transformed binary prove
exact artifact/launch identity, without authenticating a publisher or certifying backend billing.
This scope does not qualify browser login, durable native recovery, private Hostd/fleet execution,
other native pairings, releases or platforms. The qualified SQLite reference remains separate.

The 2026-10-10 Grok Build `1.0.34` session-opening failure on `_x.ai/mcp/servers_updated` remains
historical evidence under the then-strict policy; it involved no model prompt or paid inference.
The public standard default does not retroactively qualify that binary.

## Configuration and resume

Choose `configuration: 'selectable'` at driver construction to expose the existing
runtime configuration port. Preserve native defaults with this bootstrap input:

```ts
const configuration = {
  kind: 'selected' as const,
  revision: parseAgentConfigurationRevisionId('configuration:1'),
  catalogRevision: 1,
  selections: [],
};
```

This reserved input is not evidence of an empty catalog. Read `listConfiguration`, present its offered
fields/options, and submit its exact catalog and field revisions through
`applyConfigurationSelection`.

Native field/option IDs remain behind opaque public IDs. Group labels preserve
their context. Empty optional descriptions normalize to an omitted description;
identifiers, labels and metadata bounds remain validated. Changed mapped catalogs advance revisions;
duplicate observations do not. The provider checks the offered revision immediately before local
dispatch and requires an acknowledged result. ACP supplies no peer-side
compare-and-set, so this is not an atomic remote-state guarantee. A dispatched
selection with a failed, lost or unconfirmed result makes the session unusable;
close and rematerialize without automatically replaying the selection.

Persist the exact binding supplied by `onBindingCreated` and pass it to the
runtime's normal `resumeSession`. Resume restores that conversation, not a
requested history anchor or fabricated branch. Load replay has total byte/message
bounds and an opening deadline. Historical permission requests are rejected.

## Host facilities and authentication

The typed `host` object supplies optional `form`, `url`, `readTextFile`,
`writeTextFile`, `createTerminal`, and `authenticateInTerminal` callbacks. There
are no ambient filesystem, terminal, browser, credential or environment fallbacks.
Callbacks receive the instance, authorized interaction/session scope and abort
signal. The application must enforce workspace, network, executable and user
policy before performing the requested operation. Paths and commands are requests,
not authorization; these callbacks do not create a sandbox.

A URL facility presents consent before opening a URL and never prefetches it. Its
lease supplies the user's accept/decline/cancel decision, optional completion,
and idempotent release. Publishing a URL does not count as acceptance. Out-of-turn
form/URL interactions must match an exact active session-control or authentication
RPC ID. Unknown/completed IDs are rejected; prompts do not acquire this authority.

Enable authentication with an exact selection such as
`authentication: { browser: { methodId: 'advertised-method-id' } }` and the host
interactions required by that agent. Browser/device-code flows require an
agent-managed method. Terminal flows require an advertised terminal method and
`host.authenticateInTerminal`, which reproduces the host-configured invocation
with the method's arguments/environment under host policy. Terminal login does
not send `authenticate` RPC. Native method labels are not used to guess flows.

The provider does not copy credentials between connections. A confirmed
agent-managed login retains that exact idle connection for the next session.
Authentication changes are rejected while sessions are active. An interrupted
attempt after dispatch may leave external account state uncertain; the provider
retires the connection and does not retry login automatically.

File callbacks are independently advertised. Terminal support requires a complete
facility. Handles are scoped to their connection/session; unknown or cross-session
handles never reach host callbacks. Leases own their resources even when ACP
streams are borrowed. Idempotent `release` must terminate a running owned process.
Hosts must honor abort signals; late-acquired leases are released after cancellation.
Pending terminal, URL and authentication lease acquisitions remain owned and count
against facility capacity. Disposal waits within the host-operation deadline and
fails if acquisition or release is still unresolved. Failed releases remain owned
for an explicit disposal retry; a successful disposal never hides pending cleanup.
File reads receive an explicit `maxBytes` bound so the host can reject oversized
content before allocating it; the provider never silently truncates a file response.
Terminal handles belong to the session and may span turns. Interrupting a prompt
does not prove that every terminal exited; native release or session/connection
close ends that handle's ownership. The host retains control over its process policy.

## Form and media limits

Canonical forms preflight the whole schema before presenting a request. They
support at most 16 ordinary fields and 100 choices per selection. Free-text fields,
nested objects, numeric fields, defaults, patterns/formats, and constraints without
a V12 representation are rejected. Native free text permits blank/whitespace values
and measures length in Unicode code points; V12 text answers use nonblank/UTF-16
bounds. The provider does not narrow those native semantics silently. Enumerated
string values can map through opaque canonical selection IDs.
A required multi-select must require exactly one minimum selection; an optional
multi-select must allow zero. Unsupported shapes never produce a partial form.

The first stage offers “Provide answers” (or “Accept” for an empty form) and
“Decline”. Canceling either stage returns native cancel; decline returns native
decline. Submitting the answer stage returns native accept with validated content.
Both stages hold one native request, adding a user step without prompt replay.
Active session forms use canonical requests when they fit the supported subset.
An explicit `host.form` callback handles valid broader forms directly, including
blank text, Unicode code-point bounds, numeric bounds and defaults without
canonical conversion. Exactly correlated control/auth forms also use that host
facility. The provider validates the entire native schema and the host's returned
content; patterns/formats remain unsupported before any callback. Session forms
and URL interactions require an active prompt; historical replay or an idle
binding grants no interaction authority. Their host callbacks receive a turn
lifetime signal that ends on cancellation, settlement or close.

Image input allows at most 16 images, 375,000 decoded bytes per image and 750,000
decoded bytes total, subject to the stricter 1 MiB V12 turn-content bound. Declared
media type, dimensions, base64 encoding and byte counts are validated. The provider
does not decode pixels or publish generated bytes; hosts needing image-content
inspection must perform it before submitting input.

## Bounds and evidence

`limits` can override `maxQueuedMessages`, `maxQueuedBytes`,
`maxPendingRequests`, `maxHostTerminals`, `hostOperationTimeoutMs`,
`authenticationTimeoutMs`, `initializationTimeoutMs`, `promptTimeoutMs`, and
`cancellationTimeoutMs`. Defaults share a 128-entry, 8 MiB budget across queued
sources and retained current-turn item state, with output/control headroom
reserved inside that budget. Large bursts and turns with many retained items
can exhaust the same budget. Defaults allow 16 pending requests, 16 host terminals,
30 seconds for initialization or a host operation, 15 minutes for authentication,
30 minutes for a prompt, and 5 seconds for cancellation. Admission
reserves finite source capacity synchronously. Response and cancellation
processing remain independent of slow output consumers. Overflow, malformed
messages, process loss, or unconfirmed cancellation fail closed and require
closing the unusable session before rematerialization.

Readiness reports completed initialization and the reported agent version when
available. It does not prove authentication or inference. The Node launcher
does not install agents, load credentials, apply a sandbox, or grant production
execution authority. Those responsibilities belong to the application. Tests
use synthetic processes and streams; they do not qualify a native agent,
authenticated account, paid inference, or a production host.

The selected schema is stable `schema-v1.23.0` at upstream commit
`6d08f412a7a1370d3cc9a124e3be3d6acf92641e`, using ACP wire version 1.
The package version, schema release and native agent version are separate identities.
Qualify the exact native release, target, credentials, toolchain and confinement
policy before relying on native behavior; initialization alone is a narrower claim.

```sh
pnpm --filter @agen-ai/provider-acp build
pnpm --filter @agen-ai/provider-acp typecheck
pnpm --filter @agen-ai/provider-acp test
```
