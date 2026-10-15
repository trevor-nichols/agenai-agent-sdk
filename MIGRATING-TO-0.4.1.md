# Migrating to 0.4.1

`0.4.1` is the coordinated published release for all seven SDK packages. The earlier `0.4.0`
release remains available unchanged. Keep the complete package family at one version when
installing, building or packing it. Application rollout remains a separate operation. Upgrading from `0.3.1` also requires [MIGRATING-TO-0.4.md](MIGRATING-TO-0.4.md).

This update adds a bounded session-lifetime decision channel. A setup question can be offered
during session opening, remain answerable after opening returns and settle without starting a
model turn. The same release advances Agent Protocol to V11 for explicit approval
consequences. Continuously owned turn output and execution-owned request resolution retain their
ownership and delivery contracts. The new channel does not add interactive materialization,
authentication elicitation or a durable interaction store.

## Use V11 approval consequences

Update serialized protocol envelopes to `protocolVersion: 11`. The current parser rejects V10
and older values; retained historical data needs its historical owner's decoder. Managed store
contract 3 and SQLite format 3 remain unchanged.

Every `AgentApprovalOption` now requires a `consequence`. Move precise `persistence` and `scope`
fields into `{ kind: 'scoped', persistence, scope }`; the old flat fields are rejected. An option
with provider-managed remembrance instead declares `kind: 'provider_managed_remembrance'`,
`duration: { kind: 'unknown' }`, `applicability: { kind: 'unknown' }` and a bounded `explanation`.
Present those unknowns and the explanation without inventing a precise permission lifetime.
Show every offered option's decision and consequence together, including options with the same
immediate decision. Return the caller's exact selected `optionId`; keep denial with remembrance,
once-only denial and cancellation distinct. A future request remains a new decision even after a
remembered answer, because the SDK does not maintain or replay permission rules.

Supported approval capabilities require `providerManagedRemembrance`. Set it to false and retain
a nonempty readonly tuple of precise `modes` when the adapter offers only scoped choices. True
allows remembered choices and a bounded precise-mode array, including an empty array for a
remembered-only adapter. The validated runtime checks each offered consequence against that
capability before presentation.

An approved answer or a delivered receipt does not prove that a provider persisted a remembered
rule. Exact offered-option selection, once-only answer entry, continuous output ownership and
uncertain-delivery fencing retain their contracts. The SDK adds no permission database, answer
cache or revoke API. The optional ACP provider defaults to once-only scoped turn choices. To opt
in, pass `permissionMapping` to either provider constructor. Select a qualified built-in profile or
`declared-complete-consequences-v1` with exact initialized peer identity and complete ordered menu
signatures, attesting that every choice has only the represented effects. A mismatch is unsupported;
labels never establish a lifetime or matching scope. See the
[provider mapping contract](packages/provider-acp/README.md#remembered-tool-approvals) for bounds,
error behavior, an example declaration and exact native qualification limits. The core-only
[`examples/remembered-approvals.ts`](examples/remembered-approvals.ts) demonstrates presentation,
exact-ID selection, independent answer receipts and the original output reader; the optional
[`examples/remembered-approvals-acp.ts`](examples/remembered-approvals-acp.ts) additionally checks
correlated controlled ACP replies. Both are synthetic and make no native persistence claim.

## Install the handler before opening

Inspect `adapter.sessionInteractions` before supplying a handler. An omitted declaration means
`{ kind: 'unsupported' }`. A supported declaration names exact `openingOperations`,
`requestKinds: ['decision']` and `producerOwnership: 'exclusive'`. Generic adapters can declare
create, resume or branch only when they implement and qualify that operation. Support for one
operation does not imply another.

Given your existing validated `adapter` and typed create input, install the context in the exact
input passed to opening:

```ts
import type { AgentRequestId } from '@agen-ai/agent-protocol';
import type {
  AgentProviderCreateSessionInput,
  AgentSessionInteraction,
} from '@agen-ai/agent-runtime';

const pending = new Map<AgentRequestId, AgentSessionInteraction>();
const openingInput: AgentProviderCreateSessionInput = {
  ...createInput,
  interactions: {
    onRequest(interaction) {
      pending.set(interaction.request.requestId, interaction);
      void interaction.terminal.then(() => {
        pending.delete(interaction.request.requestId);
      });
      // Present the retained handle through your host UI or decision policy.
    },
  },
};
const session = await adapter.createSession(openingInput);
// The session can return while a question in pending is still answerable.
```

The complete credentialless [lifecycle example](examples/lifecycle-interactions.ts) materializes
a consumer-owned adapter, observes a pending question after opening, selects its offered decline
choice, observes delivery and terminality, then joins cleanup without invoking `startTurn`:

```sh
pnpm build
pnpm examples:lifecycle-interactions
```

The callback receives one exact `AgentSessionInteraction` with a parsed `request`, a presentation
`signal`, a `terminal` promise and a bound `respond` function. Retain that handle for later UI work;
the host does not need to wait for a human answer before opening can return. Signal-aware async
callbacks are also allowed and remain owned until their actual completion. Returning from a
callback does not answer its question, and opening return does not withdraw it. The host must
register the handler before admission; attaching an observer after opening cannot recover a
missed native question.

The opening signal controls opening until the validated session adopts its owner. Aborting it
before return stops eligibility and initiates opening cleanup, including a candidate that arrives
late. After successful adoption, the opening signal is detached from the decision lifetime.
Use the bound interaction signal for UI lifetime and `session.close()` for session shutdown.

## Preserve the no-handler path

Existing adapters can omit `sessionInteractions`, and existing callers can omit `interactions`.
That ordinary path keeps its existing behavior:

```ts
const session = await adapter.createSession(createInput);
```

Supplying an interaction context for an unsupported operation rejects with
`session_interactions_unsupported` before adapter delegation. A handler is not a request to enable
an unadvertised native feature. The explicitly selected ACP mapping below requires a handler on
every create input; it rejects a missing handler before native session opening. Unselected ACP
providers retain their ordinary noninteractive opening behavior.

## Present scope and use the bound receipt

The neutral protocol types are `AgentSessionDecisionRequest`, `AgentSessionDecisionChoice`,
`AgentSessionDecisionConsequence` and `AgentSessionDecisionResponse`, with root parsers including
`parseAgentSessionDecisionRequest` and `parseAgentSessionDecisionResponseFor`. Deliberate Zod
composition uses the existing explicit `/zod` entrypoint. Ordinary public contracts remain plain
types and parser results.

Present the title, descriptions, exact workspace target, expiry and every offered choice. The
current consequence union distinguishes a persistent provider-managed workspace grant from a
decline that leaves configuration gated. A grant covers the workspace, including future
configuration, and may affect sibling or later sessions sharing that provider profile. Detected
configuration categories do not narrow its authority. A decline does not revoke an existing
grant or promise a persisted denial. A grant choice does not establish immediate loading or
successful persistence; the SDK has no remembered-grant implementation.

Answer through the retained handle using an offered `choiceId`. The response contains only that
choice and an optional caller-owned signal; the handle already binds request and session identity.
For example, after your host obtains the user's selected choice:

```ts
const response = parseAgentSessionDecisionResponseFor(interaction.request, {
  choiceId: selectedChoiceId,
});
const receipt = await interaction.respond({ ...response, signal: responseSignal });
```

The result uses the existing `AgentRequestResolutionResult` union:

| Receipt | Meaning and host action |
| --- | --- |
| `delivered` | The adapter accepted the canonical choice. The handle becomes `answered`; native acknowledgment, loading and persistent effect need separate evidence. |
| `rejected`, `requestState: 'pending'` | This attempt did not deliver and the question remains eligible. A fresh valid choice may be submitted after the active attempt ends. |
| `rejected`, `requestState: 'unavailable'` | The question is no longer eligible. Retire its UI and do not replay its answer. |
| `delivery_uncertain` | Delivery after provider entry cannot be confirmed. Preserve that receipt, fence further mutation, close the unusable session and never replay the original choice. |

Invalid input, an unoffered choice and a response signal already aborted before provider entry
throw before delegation. Concurrent submissions cannot both enter the provider; an active-answer
refusal does not authorize another concurrent submission. A failure or response timeout after
provider entry produces uncertainty, even if the underlying work later settles. Later observations
must not upgrade the returned uncertain receipt into confirmed delivery or authorize replay.

Observe `interaction.terminal` for `answered`, `rejected`, `delivery_uncertain`, `withdrawn`,
`expired`, `session_closed` or `failed`. The signal ends presentation and answer eligibility;
terminality does not prove callback completion, native effect or process cleanup. Expiry, callback
failure and producer/protocol failure stop the owner and initiate cleanup. An uncertain response
fences session mutation while preserving cleanup ownership. Opening failure cannot be repaired by
starting a turn to flush a setup answer.

## Bound retained work

Use `interactions.limits` for explicitly bounded integer overrides. Unknown fields, nonintegers
and out-of-range values fail before admission. Provider expiry is capped by the request timeout.

| Limit | Default | Allowed override |
| --- | --- | --- |
| `maxRetainedRequests` | 8 | 1-32 |
| `maxRetainedBytes` | 524,288 bytes | 65,536-2,097,152 bytes |
| `requestTimeoutMs` | 300,000 | 1,000-1,800,000 |
| `responseTimeoutMs` | 30,000 | 1,000-120,000 |
| `cleanupTimeoutMs` | 30,000 | 1,000-120,000 |

The protocol also caps a serialized request at 65,536 UTF-8 bytes, a response at 1,024 bytes and
choices at 16. The workspace path is capped at 4,096 UTF-8 bytes and runtime admission requires a
canonical absolute path. Retention includes actual callback, response and provider-terminal work;
a visible terminal alone does not release capacity while those owners remain entered. A cleanup
deadline bounds observation of the wait, not the underlying cleanup operation or resource ownership.

## Select the Node mapping deliberately

Ordinary core use needs no ACP or Linux dependency. The optional Node provider admits only this
initial native lifecycle mapping:

```ts
const driver = createNodeAcpProviderDriver({
  providerKey: 'approved-native-provider',
  executionBoundary: host.executionBoundary,
  sessionInteractions: { mapping: 'grok-folder-trust-v1' },
  launch: {
    executable: approvedAbsoluteNativeExecutable,
    args: ['agent', '--no-leader', 'stdio'],
    cwd: ownedAbsoluteWorkspace,
    env: approvedExplicitEnvironment,
  },
});
```

Import `createNodeAcpProviderDriver` from `@agen-ai/provider-acp/node`. The host supplies and retains
`host`, the approved executable, workspace and environment; the launcher never inherits
`process.env`. The selection requires a genuine direct native executable and exact no-leader
arguments. It rejects a missing `executionBoundary` during constructor admission, before
materialization can launch a target. This is an opt-in mapping, not a feature inferred from a
provider name, method label or the standard unknown-extension policy.

| Phase and request kind | Initial selected mapping |
| --- | --- |
| Materialization/readiness interaction | Unsupported. |
| Create workspace `decision` | Supported with an early handler and exclusive execution owner; the request may remain pending after opening. |
| Resume or branch | Unsupported with the selected profile. |
| Outside-turn forms or authentication | Unsupported. |
| Root injected or shared ACP connections | Unsupported for this mapping. |

The public `NodeAcpExecutionBoundary` port synchronously reserves fresh inert ownership. A
reservation starts once, owns the workload before target execution and releases only after
fencing startup, terminating and joining every descendant and closing streams. Descendants can
create new process groups or sessions; the default POSIX process-group launcher alone cannot
satisfy this broader ownership promise. Failed release remains callable for retry.

The maintained [Linux reference](examples/execution/linux/README.md) and its
[public-port declaration](examples/execution/linux/boundary.d.mts) provide a working host
composition outside the published package. Read its required cgroup v2, user systemd, Bubblewrap,
mount, network and resource contracts before constructing it. Retain the host before `start()` so
a rejected startup still has a cleanup owner. Its controlled qualification tuple is Linux x64,
Node `24.18.0`, systemd `259.5` and Bubblewrap `0.11.1`; it is not a universally portable or built-in
containment mechanism. Host networking explicitly shares the host network and abstract Unix socket
namespace and requires the reference's documented prerequisites.

## Retain startup and opening cleanup

Close starts native quiescence before joining entered callbacks, responses and host bindings.
After successful session cleanup, dispose the registry and then the external execution host.
Keep workspaces, profiles and installation references owned until their native users have stopped.
An aborted signal, answered request, returned cancellation or elapsed timeout cannot establish
that condition.

For a failed opening, use
`isAgentProviderSessionCleanupErrorFor(error, originalOpeningInput)` against the exact input object
you passed. A matching `AgentProviderSessionCleanupError` owns callable `retryCleanup()` and must
remain retained until success. Its binding-specific subclass remains compatible. If a returned
session's close rejects, retain that session and any returned cleanup handle and retry the same
owner. Do not dispose dependent resources while an actual cleanup attempt can still commit.

Failure can occur before a registry exists. The Node boundary retains failed acquisition or
initialization cleanup in `NodeAcpExecutionCleanupError`; registry materialization preserves that
exact error as `AgentProviderRegistryError.cause`:

```ts
import { AgentProviderRegistryError } from '@agen-ai/agent-runtime';
import { isNodeAcpExecutionCleanupError } from '@agen-ai/provider-acp/node';

const candidate = error instanceof AgentProviderRegistryError ? error.cause : error;
if (isNodeAcpExecutionCleanupError(candidate)) {
  // Retain candidate and its external host; retry this exact owner until it succeeds.
  await candidate.retryCleanup();
}
```

If retry rejects, keep the same error and host callable for another attempt. Retrying cleanup
does not restart the target, rematerialize a provider or replay a decision. These process-local
handles and trusted diagnostics are not serializable recovery records or model-visible tool data.

## Separate qualification from source checks

### SDK03 remembered turn choices

Final native fixture qualification used the selected Grok edit mapping and exact installed
seven-package `0.4.1`/V11 artifacts with genuine Grok Build `1.0.50` (`c58f321264ba`). In one
public/native session, two once-only edits each asked; a remembered edit asked and was followed by
an exact repeat and neighboring owned-file edit without another request. An uncovered terminal
action still asked. Exact native answers were delivered once for gated actions, and all six actual
fixture effects occurred while the original SDK execution owned its output.

A second attempt reopened verified retained owned state with both a new native process and a new
native session. The edit asked again and performed its effect after once-only approval. That
combined change does not isolate a lifetime boundary. Duration and applicability stay unknown;
general path matching, separate projects/profiles, remembered denial, terminal remembrance and
revocation are not qualified.

The genuine executable ran with an isolated loopback model fixture, without real account
credentials or paid/backend inference. Each SDK close was followed by an independently empty
checkpoint of the same workload cgroup while the controller was alive, before registry/host
disposal and with no earlier external intervention. See the
[provider qualification record](packages/provider-acp/README.md#qualified-remembered-edit-scope-sdk03)
for exact native/runtime, report and seven archive identities. Version `0.4.1` alone cannot establish
equivalence to those artifacts. Controlled examples, actual native effects and independent cleanup
are separate evidence.

### SDK02 session-lifetime decisions

The earlier SDK02 native qualification used its retained installed `0.4.1`/Agent Protocol V10
packages with Grok Build `1.0.50`
(`c58f321264ba`), executable SHA-256
`c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5`, direct
`agent --no-leader stdio`, selected `grok-folder-trust-v1`, modern stable ACP `schema-v1.23.0`,
API-key authentication, Linux x86_64 kernel `7.0.0-38-generic` and Node `24.18.0`. It used the
recorded Linux reference and frozen dependency/toolchain/network inputs, with whole-service limits
of 64 tasks, 512 MiB and 180 seconds. Its bounded prompt-free scenarios are not general model-turn
resource sizing evidence.

Grant, decline and pending-close each observed a native-generated question still live after
opening. Grant produced a delivered bound response and separately observed vendor-file grant.
Decline produced a delivered bound response and no grant; it does not attest a hidden native
acknowledgment or persisted denial. Pending-close answered nothing, settled as `session_closed`
and rejected a stale grant as unavailable. Each successful SDK close had an independently empty
checkpoint for the same physical workload cgroup while the consumer remained alive, followed by
host retirement without external intervention.

Native wire correlation and prompt-frame counts remain unobserved. Zero SDK turn invocations
comes from the frozen consumer source; separate controlled peers establish correlated wire
responses and no-prompt behavior. Controlled reference proof, packed fixtures and the generic
lifecycle example prove their own behavior and inputs. They cannot substitute for authenticated
native evidence. The native consumer froze `fast-uri@3.1.8`; the standalone source keeps its
`fast-uri@3.1.0` override. Documentation and later packing can change archive identities, so new
tarballs are not the retained native-qualified archives merely because their version is `0.4.1`.
This earlier folder-trust proof does not establish SDK03 remembered turn behavior or V11 artifact
identity; the two features and their exact proof sets remain separate.

Revalidate the exact native executable, mapping, account route, runtime, execution owner and
dependency inputs before relying on another composition. Source `pnpm check` and the packed
consumer do not publish packages, integrate a consumer application, enable private execution or
qualify other builds, platforms, shared owners, interactive materialization, outside-turn forms or
authentication, native durable recovery or SDK-managed remembered permissions.
