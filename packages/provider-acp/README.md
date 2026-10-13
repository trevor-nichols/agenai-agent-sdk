# @agen-ai/provider-acp

An optional provider for the AgenAI coding-agent runtime. It translates the stable
Agent Client Protocol wire version 1 into the existing Agent Protocol V10 session
API at coordinated SDK version `0.4.0`.
The package is ESM, MIT licensed, side-effect-free on import and requires Node.js
22 or newer. It depends only on the public transport, runtime and protocol packages;
the core packages remain independent of ACP.

The provider pins the transport's `schema-v1.23.0` stable profile. It translates
ACP into existing V10 capabilities and rejects unsupported semantics explicitly.
Connection negotiation, configured host facilities, and mapping policy fix one
capability envelope per instance; every later connection must match it.

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
| Turns and requests | Default text turns, streamed assistant/reasoning text, tool progress, cancellation and once-only exact-action permissions. One execution retains the original native prompt across request waits and answers. |
| Resume | Exact persisted binding using advertised `session/resume`, otherwise advertised `session/load`. Load history is bounded and suppressed from new-turn output. No automatic recreation after failure. |
| Configuration | Managed by default. Explicit `configuration: 'selectable'` maps observed boolean/select catalogs, with a session-mode fallback when config options are absent. Unknown metadata differs from observed empty metadata. |
| Forms | Canonical boolean/single-select/multi-select forms that fit V10 constraints. An intent stage preserves decline separately from cancel, followed by answers on the same native waiter. Explicit host form facilities can handle broader native forms. |
| Images | Inline base64 PNG/JPEG/WebP only when the peer advertises image input, within image and total turn budgets. No implicit local-file read or URL fetch. |
| Plans | Complete replacements of observed turn plans. A mode called “plan” does not establish enforced planning behavior or approval authority. |
| File changes | Partial structured observations from native tool diffs. Canonical paths contained by the working directory become sorted relative display paths without filesystem reads. Unfinished tools remain unknown at ordinary turn completion. No final workspace diff or Review artifact is inferred. |
| Commands | Session catalogs and invalidations from `available_commands_update`. Missing metadata remains uninitialized; an observed empty list is available and empty. |
| Authentication | Explicit method-to-flow selection and host interaction facilities. Agent methods retain the authenticated connection; terminal methods require a host facility and fresh verified initialization afterward. |
| Files and terminals | Explicit host callbacks, correlated to the bound native session. Terminal support requires the complete output/wait/kill/release lifecycle; embedded terminal transcript references remain unsupported. |
| MCP setup | Static host-approved `mcpServers` and optional owned `sessionMcpBinding` factory for creation/resume. HTTP/SSE require advertised peer support. Configuration is not observed tool exposure. |

Through-turn branching, same-turn steering, enforced plan mode, persistent
permission grants, context usage/compaction, account quota, effective skill/rule
inventory, collaboration, generated resources and artifact publication remain
unsupported. ACP usage counters can decrease without confirmed compaction and
cannot satisfy V10's context continuity contract. Unsupported media output fails
explicitly rather than disappearing from an otherwise successful transcript.
Embedded terminal references also fail explicitly: a mutable, possibly truncated
terminal snapshot does not provide an ordered append-only transcript. Agents can
use terminal RPCs and emit their observed output as ordinary text/tool content.

ACP administration (list/delete/logout/import) has no portable provider API in
this release. Host-owned integrations may use the transport directly with their
own authorization and native lifecycle policy. No capability grants authority
over other conversations or account state.

## Operational failures and uncertainty

The provider maps supported standard `schema-v1.23.0` prompt errors into V10 `AgentError` values.
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
`authentication`, `host`, `mcpServers`, and `sessionMcpBinding`. The connection factory receives the public
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
a V10 representation are rejected. Native free text permits blank/whitespace values
and measures length in Unicode code points; V10 text answers use nonblank/UTF-16
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
decoded bytes total, subject to the stricter 1 MiB V10 turn-content bound. Declared
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
