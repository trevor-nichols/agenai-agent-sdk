# Consumer-owned Grok ACP files

This example composes public `@agen-ai/sandbox` live files with the public
`@agen-ai/acp-transport` custom client. It adds no provider implementation,
vendor dependency, host filesystem access or product session identifiers to
the sandbox package. `createSandboxAcpIntegration(sandbox)` still returns an
empty host-facility object. The native qualification selects Grok Build
1.0.62 and the transport's explicit modern stable `schema-v1.23.0` profile,
matching that native version's separately recorded public qualification.

`createSandboxGrokClient` is a small filesystem assembly with a required
consumer-owned `onSessionUpdate` observer. It delivers each complete,
schema-validated core update unchanged. The observer must bound any work or
storage it owns and preserve notification-handler failures. Consumers needing
permission callbacks construct the transport directly with
`createSandboxAcpFileScope`, its `transportLimits` and its `handlers`. Add a
consumer-owned `session/request_permission` handler that validates the exact
offered menu and chooses one offered once-only action. A permission response
does not grant filesystem authority. The example never turns remembered
permissions into a file grant or advertises host terminal facilities.
The assembly explicitly selects ACP's standard unknown-extension policy:
unregistered underscore notifications are ignored under the transport's
existing bounds and gain no feature or effect authority. Consumers retaining
all raw wire evidence install their own bounded stream observation before
constructing the transport, as the earlier scripted native campaign did.
Host-originated requests use the explicit `sandbox-grok:` request-ID prefix,
separating their IDs from this native tuple's numeric reverse requests.
The transport retains its collision guards. Native request IDs and their
correlated responses are never rewritten. Its prefix validation also
requires the request-ID budget to hold the prefix plus its reserved numeric
suffix; the assembly therefore needs at least a 29-byte ID budget.

## Admission and lifetime

Construct a scope from the exact ready `Sandbox` and an explicit
`{ kind: "read_only" }` or `{ kind: "read_write" }` grant. The scope captures
that owner's files handle and guest workspace. It has one native session
binding, no rebinding operation and one current turn lease. Create another
scope for another sandbox generation; never reuse an old closure or its
native IDs after finalization.

Pass `files.capabilities` as `clientCapabilities` in ACP initialization. After
the real `session/new` response, validate and bind its native `sessionId` with
`files.bindSession(nativeSessionId)`. Open the turn lease before dispatching
`session/prompt`, and close it when that native prompt settles. A request's
native session must exactly match the binding and a live turn must exist.
Old or foreign IDs, a closed turn, absent write authority and a sandbox that
is no longer ready reject before file dispatch. File operations serialize
through a bounded queue because the sandbox admits one live file operation.
ACP file requests carry a native session ID and no native turn ID. The lease
therefore governs admission during the current turn; it cannot prove the
historical turn of a same-session frame emitted only after a later turn
opens. The consumer must keep one native prompt owner and establish the
selected native composition's producer quiescence between turns. Draining
entered requests alone does not prove that no future frame can arrive.

```ts
const files = createSandboxAcpFileScope({
  sandbox,
  grant: { kind: "read_write" },
  budgets: {
    maxResponseFrameBytes: 1024 * 1024,
    maxRequestIdBytes: 128,
    maxReadBytes: 8 * 1024 * 1024,
    maxWriteBytes: 1024 * 1024,
    writeChunkBytes: request.policy.transfers.chunkBytes,
  },
});
const client = createAcpClient({
  ...streams,
  schemaChannel: "stable",
  schemaProfile: "schema-v1.23.0",
  unknownExtensionPolicy: "standard",
  outboundRequestIdPrefix: "sandbox-grok:",
  limits: files.transportLimits,
  notificationHandlers: { "session/update": observeTheCompleteNativeUpdate },
  reverseRequestHandlers: {
    ...files.handlers,
    "session/request_permission": selectAnExactOfferedOnceOnlyAction,
  },
});
// Initialize, create and validate the native session before binding its ID.
const session = files.bindSession(nativeSessionId);
const turn = session.openTurn();
try {
  await client.request("session/prompt", nativePrompt, { lifetime: "until_settled" });
} finally {
  await turn.close();
}
```

The values above are consumer choices. They are not universal file-size or
execution-duration limits. Supply the transfer chunk bound from the same
parsed sandbox request that created the owner. A chunk bound greater than
the owning request's actual bound is a caller configuration error, even if
it fits the public maximum.

Closing a turn revokes it and aborts its entered requests synchronously. Its
promise joins the callbacks and each transport `context.settled`, including
the actual response write. No next turn opens until that join settles.
`context.settled` must never be awaited inside its own reverse handler.

For whole-scope cleanup, first call `files.revoke()`, then settle both
`client.dispose()` and `files.close()` with `Promise.allSettled`, then call
the original owner's `sandbox.stop()`. Preserve every failure and retry the
original sandbox cleanup owner if needed. A blocked response write may need
transport disposal to settle; do not await scope draining before starting
transport disposal. Destroy or export the stopped workspace only under the
original owner's ordinary lifecycle contract. Ending a native prompt or
its output iterator alone does not prove sandbox cleanup completed.

## Paths, text and response bytes

Requests require guest absolute paths beneath the captured workspace plus
one canonical relative regular-file path. Root-only paths, sibling prefix
matches, repeated separators, dot traversal and unsupported path syntax
reject. The adapter never opens a controller path. Lower-level live file
operations retain their no-follow, no-cross-mount and unsupported-type
rules; enabling symlink-preserving tree transfer does not change callbacks.

Reads validate strict UTF-8 across the entire scanned file, including bytes
before and after selected lines and incomplete terminal code points. The
streaming decoder preserves an initial BOM. Line selection is one-based,
with omitted `line` equal to one; `limit: 0` returns empty text after the
same full-file validation. Selection has the behavior of
`text.split("\n").slice(line - 1, line - 1 + limit).join("\n")`, omitting the
slice end when `limit` is absent. CR bytes remain intact, empty lines and
the final empty line are preserved when selected, and starting beyond EOF
returns empty text. The binary SDK remains binary.

`maxReadBytes` bounds cumulative bytes scanned, including excluded lines.
`maxResponseFrameBytes` bounds the full JSON-RPC success envelope containing
the exact current request ID and escaped `result.content`. Incremental
accounting bounds retained text and final serialization independently
checks the complete supported envelope. The ACP transport defines a frame
limit excluding its one-byte LF delimiter; its outbound queue accounts for
the envelope **plus** that delimiter. The constructor ensures every admitted
ID leaves room for the fixed correlated error envelope; the transport
independently rejects overlong IDs and remains the last framing guard.

`maxWriteBytes` bounds the UTF-8 payload and rejects unpaired UTF-16
surrogates. It is not a whole-process memory bound. Queued source envelopes
are bounded by transport frame size and request concurrency, the current
read retains at most its response-sized selected text, the current write
owns its bounded UTF-8 payload, and transport output staging has its own
`maxOutboundBufferedBytes`. Account for those independent bounds together.
`maxReadBytes` does not cause an entire scanned source file to be retained.

## Write facts and finalization

Before entering a write, the adapter admits the complete `{ result: {} }`
acknowledgement envelope. It writes bounded byte chunks through
`files.writeFile(..., { mode: "replace" })`. Replacement is atomic name
publication with the SDK's observed mode behavior; it does not promise
inode preservation, compare-and-swap or power-loss durability.

Only a completed published receipt with the exact byte count and a still
live request returns a clean acknowledgement. A published changed result,
an unknown result or a publication racing revocation fences the whole
scope. `SandboxAcpFileError.writeObservation` retains the actual receipt,
including nullable confirmed bytes; `files.close()` reports that retained
failure after draining. A write promise rejecting after dispatch retains
its original cause and also fences. Synchronous admission rejection and
explicit no-effect receipts do not invent an uncertain publication.

Neither a native error nor cancellation proves no write occurred. The
example never retries, replays or undoes a write automatically. Keep the
original sandbox owner and its stop/export obligations after every error.
Native write telemetry is not final artifact evidence.

## Verification owner

`tests/filesystem.test.ts` is the primary owner of these consumer adapter
contracts. It runs the real public ACP transport against memory streams
and an explicit byte-store fake, checking exact emitted frames, file
effects, line/UTF-8 behavior, queue revocation, actual response-write drain
and retained uncertain/publication receipts. It needs no network, process
launch or filesystem writes. Run it from an independent packed consumer:

```sh
node --import tsx --test examples/sandbox/grok/tests/*.test.ts
```

That hermetic proof does not qualify a native binary, real authentication,
paid inference, billing or a consumer application. The earlier native
campaign drives the actual selected Grok executable and guest children
with scripted local model responses and records its exact tuple.

The first native attempt exposed a missing `session/update` observer:
the transport correctly closed with `acp_notification_handler_missing`.
Both supported pinned schema profiles accepted the exact retained command
catalog, including its nullable inputs and metadata. No parser or native
field was changed to resolve that failure. The assembly's regression
replays unmodified initialization, session creation and command-catalog
frames from that attempt, checks complete observer delivery, and exercises
a separately labelled synthetic configuration continuation. Selecting the
modern profile aligns the recorded 1.0.62 tuple; it is not evidence that the
older schema rejected those retained frames.

The second native attempt exposed independent numeric request-ID overlap:
host prompt ID `5` was still pending when the native process sent filesystem
request ID `5`. The retained failure was
`acp_request_id_direction_collision`. Selecting the transport's existing
host request-ID prefix fixes this composition while preserving native IDs,
the once-only handlers and complete response-envelope accounting. Its
regression keeps the captured concurrent request payloads, makes only
explicit synthetic earlier prompt completions to reach the fifth request,
and reads actual bytes from the in-memory guest port. Counterfactual peer
responses echo the newly selected host IDs; none of those synthetic replies
is presented as additional native evidence.

## Explicit xAI API-key launch

[`reserveSandboxGrok`](launch.ts) adds the selected Grok Build `1.0.62`
(`1474f9cbdd91`) API-key route. It accepts a closed explicit
`credential: { kind: 'api_key', value }` and exact
`guestExecutable: '/opt/agenai/native/grok'`. Only that key enters `XAI_API_KEY`.
It neither reads host environment credentials nor accepts a caller environment, endpoint,
saved-login object or auth-provider program. The secret-free `preflight` reports fixed
provider/version/transport, source kind, native destination and candidate HTTPS endpoints;
`nativeQualification` and `endpointEvidence` retain static labels from the historical predecessor.
They do not attest caller images or authentication. The [0.4.6 follow-up](../HANDOFF.md#credential-reuse-native-campaigns-2026-10-28)
separately records the direct API-key file task and cancellation after observed native entry on
its exact Linux x64 and Desktop native arm64 inputs, with explicit Engine 404 cleanup evidence.

Prepare and independently verify an immutable Linux image with the matching native
executable/platform/digest and complete runtime closure before constructing the sandbox.
Install these two nonsecret source assets read-only at exactly these guest paths:

| Source asset | Prepared guest path |
| --- | --- |
| [`guest/launch-grok.sh`](guest/launch-grok.sh) | `/opt/agenai/examples/grok/launch-grok.sh` |
| [`guest/config.toml`](guest/config.toml) | `/opt/agenai/examples/grok/config.toml` |

The image must provide `/bin/sh`, POSIX `id`, `mkdir`, `cat`, `chmod` and shell `pwd`/`umask`,
plus the real executable at `/opt/agenai/native/grok`. Start with a new private ephemeral
`/home/sandbox` and workspace `/workspace/work`. No managed credential/model configuration,
foreign native imports, host HOME or saved sessions may be present. The abstract `Sandbox`
has no image attestation API; these are the caller's preparation/admission obligations.

The process recipe invokes the fixed shell asset without caller shell arguments. Under the
one reserved process, it refuses root or an existing `GROK_HOME`, creates
`$HOME/grok` with mode 0700, copies the exact nonsecret config with mode 0600, restores the previous
umask, then `exec`s the native executable with
`agent --no-leader --model grok-build-0.1 stdio`. Native stdin remains ACP and is untouched by
preparation. No gateway, secret config text, runtime controller callback or second reservation
is involved. Preparation failures leave cleanup with the same sandbox owner.

The config fixes `[model."grok-build-0.1"]` to `env_key = "XAI_API_KEY"`,
`api_backend = "chat_completions"` and `base_url = "https://api.x.ai/v1"`.
There is no `api_key` or `auth_provider_command`. Fresh home removes the saved-session
competitor; the explicit per-model env binding selects this key ahead of a general fallback.
Updates, telemetry, trace upload, auto-wake, Claude/Cursor imports and unneeded native
integrations are disabled by fixed environment/config. Neither recipe nor assets accept
arbitrary config or endpoint replacement.

```ts
import { runSandboxGrokTurn, SandboxGrokRunError } from './grok/index.js';

try {
  const result = await runSandboxGrokTurn(sandbox, {
    launch: { credential: { kind: 'api_key', value: selectedKey },
      guestExecutable: '/opt/agenai/native/grok' },
    task: nonsecretTask,
    grant: { kind: 'read_write' },
    budgets: { maxResponseFrameBytes: 1024 * 1024, maxRequestIdBytes: 128,
      maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024, writeChunkBytes: 64 * 1024 },
    onSessionUpdate: boundedSensitiveUpdateObserver,
    // Implement this caller policy against the exact current action and intended task.
    allowPermission: explicitlyApproveCurrentToolCall,
    signal,
  });
  // The whole sandbox has stopped. Verify the exact expected exported artifact separately.
  await exportAndVerifyExpectedArtifacts(sandbox);
} catch (error) {
  if (error instanceof SandboxGrokRunError) await error.retryCleanup();
  throw error;
} finally {
  await sandbox.stop();
  await sandbox.destroy();
}
```

The callback and artifact-verification functions above are explicit caller policy. Use the
[stopped-tree directory helper](../filesystem.ts) or `sandbox.exportTree` for selected artifacts.
Choose file chunks consistent with the owning sandbox's transfer policy. Retain the original
owner if stop/destruction fails. A stop reason or native exit alone does not prove task success,
key validity or billing route. The caller owns explicit egress and spend limits.

[`runSandboxGrokTurn`](run.ts) is a concrete single-turn lifecycle using the original custom
ACP assembly. It retains stable `schema-v1.23.0`, standard unknown-extension policy,
`sandbox-grok:` host IDs, one ACP stdout/stderr owner and the existing bounded file scope.
The native version and selected session model are checked before the prompt. File access
requires the explicit supported live-file grant. A permission can select only the one current
offered `allow_once` option after the caller's synchronous policy approves; it never selects
persistent approval, another session's request or a request outside the active turn. It caps
permission selections at sixteen and update deliveries at 4,096, in addition to transport and
sandbox byte/concurrency/deadline bounds. Raw native payloads and diagnostics remain sensitive;
its returned observation contains no transcript. The callback must not print secrets or retain
unbounded output.

Every entered update observer must settle successfully before the recipe returns success. A
synchronous throw or asynchronous rejection remains an execution failure even when the prompt's
terminal response arrived first. An observer that outlives bounded shutdown leaves cleanup pending;
retain `SandboxGrokRunError.retryCleanup()` to join its eventual settlement without replaying the turn.

Cancellation revokes file/permission admission and stops the same reservation; no credential or
prompt replay occurs. Cleanup starts transport disposal, file callback draining and original
reservation stop together, retaining retry ownership on failure. A live-file write that failed
with a possible effect fails the turn as `execution_failed` (or `cancelled`) after its callbacks
drain; it is not a cleanup failure, so `retryCleanup()` succeeds once transport disposal and the
original reservation stop settle. Stop must settle before export;
storage destruction remains caller-owned. Explicit ready sandboxes used without a turn deadline
need a caller cancellation decision; the example adds no business timeout.

The chosen HTTPS/443 destinations are `api.x.ai` routes `/v1/chat/completions`, `/v1/models` and
`/v1/api-key`. These preflight facts do not configure an egress allowlist. Native endpoint and
credential revision qualification remain separate. Browser/device sign-in, subscription import,
host `auth.json`, OIDC configuration and an external auth-provider command are unsupported here.
