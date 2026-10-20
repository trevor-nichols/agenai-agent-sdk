# @agen-ai/acp-transport

Bounded Agent Client Protocol (ACP) JSON-RPC transport for Node.js 22 and newer.
This optional AgenAI Agent SDK package connects a host to streams supplied by the
host. It validates messages against packaged, hash-pinned ACP schemas and owns
framing, correlation, reverse requests, deadlines and connection cleanup.

The coordinated release is `0.4.3`; published `0.4.1` keeps its original
archives and qualification. The package is ESM, MIT
licensed and side-effect-free on import, with exact Ajv `8.17.1` as its sole runtime
dependency. It is independent of the provider-neutral `@agen-ai/agent-protocol`
and `@agen-ai/agent-runtime` packages.

Keep installed SDK packages at one coordinated version. Exact reverse-request cancellation and
actual response-write settlement are transport facts; the provider maps them to V12 request
availability and independent delivery receipts. Controlled transport FIFO proof does not qualify
simultaneous vendor callbacks. See the [0.4.2 migration guide](../../MIGRATING-TO-0.4.2.md).

## Connect existing streams

The host supplies the agent's stdin, stdout and optional stderr streams. Process
creation, filesystem access, terminal execution, credentials and containment are
host responsibilities. Register only the reverse methods that the host supports,
and advertise those capabilities during initialization.

```ts
import {
  createAcpClient,
  createAcpStandardSessionOperations,
} from '@agen-ai/acp-transport/client';

const client = createAcpClient({
  stdin: agentInput,
  stdout: agentOutput,
  stderr: agentDiagnostics,
  schemaChannel: 'stable',
  schemaProfile: 'schema-v1.23.0',
  disposeTransport: closeOwnedConnection,
});

try {
  const operations = createAcpStandardSessionOperations(client);
  const initialization = await operations.initialize({
    protocolVersion: 1,
    clientInfo: { name: 'my-host', version: '1.0.0' },
    clientCapabilities: {},
  }, { timeoutMs: 10_000 });

  // Inspect the negotiated capabilities before selecting optional operations.
  const session = await operations.newSession({
    cwd: projectDirectory,
    mcpServers: [],
  }, { timeoutMs: 10_000 });
} finally {
  await client.dispose();
}
```

The root entrypoint additionally exports JSON/message parsers, schema validation,
bounded protocol limits, typed errors and explicit extension registration.
`./client` exports the client contracts and typed standard session invocations.
No internal file path is a supported import.

Transport errors and validated remote JSON-RPC errors retain their ACP meanings. Provider adapters
own translation into Agent Protocol V12 failures and any provider-owned retry observation; the
transport has no dependency on that protocol and grants no turn replay or quota authority.

An adapter migrating from a private transport import should use these public
entrypoints and retain its explicit schema selection. There is no compatibility
re-export for private import specifiers. Using the modern schema requires its own
negotiation and semantic mapping; renaming an import does not enable capabilities.

Notification and reverse-request handlers begin synchronously in received frame
order. Their returned promises settle independently, so a pending permission or
slow output consumer does not block correlated responses or cancellation. Hosts
must reserve bounded queue capacity during handler admission and retain that
reservation until processing completes.

Request deadlines and bounded shutdown drains keep Node's event loop alive until
the operation settles, including when the supplied streams have no active I/O
handles. Settlement clears the operation's timer. Always await `client.dispose()`
when the connection is no longer needed to reject pending requests and complete
bounded cleanup before releasing the owned transport.

Disposal stops new writes and rejects pending write promises promptly. An already-entered Node
write can settle afterward; the writer retains error/close observation until its callback succeeds
or its stream reports failure or closure. The configured shutdown drain bounds waiting for handler
promises, so transport closure alone does not prove arbitrary host callback work has stopped.
The supplied transport disposer and any provider/facility owners must quiesce their own producers
and retain cleanup ownership when that fails.

A reverse-request handler fulfills before its validated JSON-RPC response is serialized and written.
Successful local writing does not establish peer receipt: the transport tracks no acknowledgment
of a reverse response. A provider's canonical answer receipt must state its own acceptance boundary.

Each reverse handler receives `context.settled`, a nonrejecting promise that fulfills after that
handler and its actual response-write obligation settle. Register reservation release against it
when callback material must remain charged through writing. Do not await it inside the handler:
the transport must first receive the handler's result before it can write the response. The promise
also remains pending when disposal rejects an entered write early; an actual write callback or
stream termination must settle the underlying obligation. Fulfillment observes completion, not
successful delivery or peer acceptance, and does not authorize answer replay.

Requests can set `onResponseReceived` to admit a validated result or remote error
synchronously before the request promise settles and before the next frame is
delivered. This lets a session order its terminal marker behind preceding updates.
The hook performs bounded admission and returns immediately. Local aborts,
timeouts, write failures and invalid responses do not invoke it. A throwing hook
rejects the request and closes the connection; remote errors retain the same
`AcpRemoteError` instance through the hook and promise rejection.

## Protocol contract

The packaged profiles are upstream `v0.11.4` and `schema-v1.23.0`, both using
ACP wire protocol version `1`. Client `schemaProfile` defaults to `v0.11.4` so
existing hosts retain the exact legacy method/schema contract. Select
`schemaProfile: 'schema-v1.23.0'` explicitly for the newer stable v1 schema.

`v0.11.4` supports explicit `stable` or `unstable` channels; `schema-v1.23.0`
supports only `stable`. Unknown profiles/channels and unsupported combinations
fail during construction before stream subscriptions or writes. The schema
validator also defaults to legacy stable:

```ts
import { createAcpSchemaValidator } from '@agen-ai/acp-transport';

const legacy = createAcpSchemaValidator();
const selected = createAcpSchemaValidator('stable', 'schema-v1.23.0');
selected.validate('agent', 'session/delete', 'request', { sessionId: 'session-1' });
```

The root's existing `ACP_SCHEMA_RELEASE`, `ACP_STABLE_PROTOCOL` and
`ACP_UNSTABLE_PROTOCOL` exports retain their legacy meanings. Version-specific
`ACP_V1_23_0_*` metadata describes the new stable profile. Initialization rejects
wire versions other than `1`; that version does not identify a schema profile or
prove optional peer capabilities. Standard invocation helpers validate protocol
structure; hosts still inspect negotiated capabilities and own session state.

The newer stable profile adds session resume/close/delete, logout, elicitation,
boolean configuration and usage updates. It uses `elicitation/create` and
`elicitation/complete`; these are distinct from the legacy unstable elicitation
methods. Protocol-level `$/cancel_request` is available under legacy unstable and
newer stable, and is rejected under legacy stable. Cancel notifications remain
separate from proof of native settlement. ACP v2 and newer unstable definitions
are not enabled by selecting this profile.

The transport bounds frame bytes, JSON complexity, outstanding requests, reverse
request and notification concurrency, notification rate, outbound buffering and
retained stderr. An excess concurrent reverse request receives a correlated limit refusal; admitted
callbacks remain active. Frame or outbound-buffer overflow closes the connection. These admission
bounds prevent unbounded accumulation. Handlers must preserve their own semantic ordering
and output backpressure. Notification delivery alone does not provide a durable
event journal or a provider-neutral turn state machine.

Request cancellation or timeout does not prove that the peer stopped execution.
`onRequestDispatch` receives the exact allocated `requestId` at the boundary immediately
before the first write, allowing request-scoped reverse traffic to be correlated before
the peer can respond. A callback that aborts or rejects admission prevents the request
write. This local dispatch callback
does not acknowledge native execution or durable completion. Hosts decide when an
uncertain operation makes their session unusable. Outbound extension methods and
supported inbound extension handlers require explicit registration with
parameter/result validation.

## Extension interoperability

`CreateAcpClientOptions.unknownExtensionPolicy` accepts `'reject'` or `'standard'`.
The transport defaults to `'reject'`, preserving strict handling for existing
callers. The [public ACP provider constructors](../provider-acp/README.md#unknown-extensions)
select `'standard'` by default; a direct transport client must select it explicitly.
Use `'standard'` when connecting to a peer that can emit
optional extensions:

```ts
const client = createAcpClient({
  stdin: agentInput,
  stdout: agentOutput,
  schemaChannel: 'stable',
  schemaProfile: 'schema-v1.23.0',
  unknownExtensionPolicy: 'standard',
});
```

In standard mode, an unknown incoming method whose name starts with `_` has two
bounded outcomes. A notification is ignored; a request receives the correlated
JSON-RPC error `-32601` with the fixed message `Method not found`. Neither invokes
a host handler. Framing, JSON complexity, envelope validation and notification
rate limits still apply. Rejection responses share the existing outbound byte
budget, and their request IDs remain reserved until writing finishes, including
stream backpressure. Duplicate IDs and response collisions still fail the
connection.

An exact registration for the incoming message kind takes precedence and must
validate its parameters and any result. A registration for the opposite direction
or message kind does not authorize an incoming handler. Core methods,
`$/cancel_request`, malformed messages and unexpected responses retain their
profile-specific validation and failure behavior. Standard mode does not enable
outbound extension calls, change the selected schema, or certify a peer's optional
features. Required extensions still need explicit host support and semantic
mapping. Discarded notifications produce no provider-neutral events and grant
no tool, filesystem, terminal, authentication or other effect authority.

Frame or outbound-buffer admission failure closes the connection synchronously,
so a single received batch cannot enqueue further rejection work after overflow.
The `onFatalError` observer can therefore run during delivery of that batch.
Public `request()` and `notify()` operations continue to report write failures
through their returned promises. Await `dispose()` before releasing the owned
transport.

## Schema generation and licensing

`schema/v0.11.4/` and `schema/schema-v1.23.0/` contain exact pinned upstream inputs,
method metadata, provenance, Apache-2.0 licenses and derived method inventories.
The newer stable release is pinned to commit
`6d08f412a7a1370d3cc9a124e3be3d6acf92641e`; its source files match the release
assets byte for byte. Generation reads only package-owned inputs, checks fixed
hashes and derives both TypeScript/JSON inventories without network access. It
preserves the legacy inventory byte for byte.

| Profile | Pinned upstream commit | Schema channels |
| --- | --- | --- |
| `v0.11.4` | `e931357254ff44573294d5cee214a269e0cd6c54` | Stable and explicitly selected unstable |
| `schema-v1.23.0` | `6d08f412a7a1370d3cc9a124e3be3d6acf92641e` | Stable only |

The modern `schema.json` SHA-256 is
`3c17bd6385d90cf672d8a661fddc359d73422cf8b8ce6865213d25cfd4c0eca7`;
its `meta.json` SHA-256 is
`061edb6efa8fb2aa2792459a86ec7268de5fe665bba48b2ffe7939df01481f88`.
These hashes identify packaged inputs, without authenticating a native agent or
granting host execution permission. Valid schema messages can still request
unsupported or unauthorized effects; hosts must validate those separately.

From a source checkout, run `pnpm generate`, `pnpm check:generated`, `pnpm build`,
`pnpm typecheck` and `pnpm test` in this package. Published packages include compiled
JavaScript/declarations and the exact schema assets, without source maps, source
files, tests or build caches.

AgenAI transport code is [MIT licensed](LICENSE). The unmodified ACP schema inputs
retain their [Apache-2.0 license](schema/v0.11.4/LICENSE) and
[legacy source provenance](schema/v0.11.4/provenance.json). The new stable profile
retains the same [upstream license](schema/schema-v1.23.0/LICENSE) with its own
[immutable source provenance](schema/schema-v1.23.0/provenance.json).
