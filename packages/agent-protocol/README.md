# `@agen-ai/agent-protocol`

`@agen-ai/agent-protocol` is the provider-neutral data contract for coding-agent runtimes. It
defines opaque identifiers, sessions, turns, approval and elicitation requests, technical
capabilities, typed operations, safe configuration and managed-content inventories, integration
observations, effective harness content and package catalogs, environment observations, account-quota observations, operational failures and recovery hints, collaboration lifecycles, generated resources, portable
artifact descriptors, and provider-observed events. The package does not define a transport or
execution runtime.
The coordinated release is `0.4.3` and uses Agent Protocol V12, including exact request
unavailability and session decisions, forms and plan reviews. Published `0.4.1` retains V11;
`0.4.0` retains V10. Source versioning does not establish registry publication.
Keep all installed SDK packages at one coordinated version. The [0.4.2 migration
guide](../../MIGRATING-TO-0.4.2.md) covers V12 envelopes, tagged session responses and
the separate ownership of request eligibility, entered receipts and continuation output.

## Ownership boundary

The protocol deliberately has no concept of a tenant, SaaS product, database row, assigned actor,
host lease, persistence sequence, member visibility, billing rule, or storage backend. Opaque IDs
are correlation values supplied by the caller; they are never authorization credentials.

Use `@agen-ai/agent-runtime` for the process-local driver and adapter SPI. A product control plane
is responsible for authorization, scheduling, persistence, audit attribution, and mapping its own
identities to protocol IDs.

`capabilities.turns.steer` is only the provider's technical ability to accept canonical input into
the currently running turn. It does not describe, authorize, or implement future-turn queueing;
that product concern belongs to the caller's control plane.

Account-quota observations describe the allowance state reported by the account that funds a
provider connection. They do not identify that account, authorize a caller, decide whether a turn
may run, or represent AgenAI billing. `sourceId`, `poolId`, and `windowId` are opaque correlation
values. A quota observation with a known zero or an unknown reset remains valid; unavailable states
carry no fabricated windows or hints.

## Entrypoints

- `@agen-ai/agent-protocol` exports the complete plain API.
- `/sessions`, `/session-interactions`, `/turns`, `/requests`, `/events`, `/capabilities`, `/artifacts`, `/operations`,
  `/configuration`, `/managed-content`, `/integrations`, `/collaboration`, `/resources`, and
  `/account-quota`, `/effective-content`, `/commands`, `/extensions`, and `/environment` are focused plain entrypoints.
- `/zod` is the only entrypoint that exposes Zod schemas.
- `/json-schema` exposes deterministic draft 2020-12 schema artifacts.

Ordinary entrypoints expose plain TypeScript types, constants, parsers, and validator-neutral
issues. Their declarations do not expose Zod.

## Protocol-only example

```ts
import {
  parseAgentEvent,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentEvent,
} from '@agen-ai/agent-protocol';

const event: AgentEvent = parseAgentEvent({
  protocolVersion: 12,
  type: 'content.delta',
  sessionId: parseAgentSessionId('external-session:42'),
  turnId: parseAgentTurnId('external-turn:9'),
  occurredAt: '2026-08-03T20:00:00.000Z',
  payload: {
    itemId: 'assistant-message:1',
    streamKind: 'assistant_text',
    delta: 'Hello from a provider.',
  },
});

const roundTripped = parseAgentEvent(JSON.parse(JSON.stringify(event)));
```

Serialized values carry `protocolVersion: 12`; TypeScript API names remain unsuffixed. Unknown
fields and unsupported protocol versions are rejected.

Item snapshots are a closed union keyed by `itemKind`. Common identity and lifecycle fields are
shared, while commands, file changes, managed tools, web/computer activity, image views, and
reviews expose only their bounded semantic `details`. Context-compaction items require neutral
details describing the trigger, optional before/after occupancy, duration, and bounded summary
preview. Message, reasoning, plan, and unknown items have no details. Review details are required
and distinguish an entered target from an exited report. There is no metadata or provider-native
attribute bag; source evidence belongs outside the portable event. File-change producers can use
`compareStringsByUnicodeCodePoint` to emit the canonical path ordering required by the protocol
across both BMP and supplementary Unicode characters.

Approval requests correlate to one live item or exact proposed-plan artifact and provide a
bounded list of typed options. Every option declares its decision and a closed `consequence`.
`scoped` contains precise `persistence` and `scope`; `provider_managed_remembrance` contains explicit
unknown duration and applicability and a required bounded explanation. Flat persistence/scope
fields are rejected in V12. Neither approval nor a delivered answer proves the provider wrote a rule.
Resolutions select one exact offered `optionId` or explicitly cancel. Supported approval capability
requires `providerManagedRemembrance`: false requires a nonempty readonly precise-mode tuple; true
allows a bounded readonly array, including empty for a remembered-only provider. Scoped options
must fit an exact declared mode; remembered options require the true capability. The SDK owns no
permission database, answer cache, pattern editor, provider payload bag, or revoke API.

Consumers should present each offered decision and consequence together. Several options can have
the same immediate decision and different consequences, so selecting the first `approved` option
cannot express a person's choice reliably. Return the exact selected `optionId`; keep deny-once,
deny-and-remember, and explicit cancellation distinct. Show the remembered option's explanation
and unknown duration/applicability without converting observed provider behavior into a session,
workspace, path-pattern, or permanent grant.

`context.usage.updated` reports
bounded occupancy and optional monotonic cumulative counters for an advertised session or
materialization measurement scope.

Capabilities state technical possibility only. Dynamic operations, configuration fields, managed
content, and integrations are separate bounded, revisioned catalogs; capability declarations do
not carry inventory or authority. Operation and configuration input is correlated to the exact
offered revision and typed field definition. Collaboration exposes canonical graph identity and
lifecycle state without provider handles. Generated resources expose portable publication state
and an artifact reference only when the resource is available. Account-quota windows keep period,
measurement, applicability, allowance, and observation timestamps separate so a provider cannot
collapse unrelated pools into one percentage. Quantity units remain distinct from exact money,
which uses integer minor units with an explicit scale. None of these domains has a generic
extension or metadata bag.

## Request lifecycle and session interactions

`request.unavailable` is a turn event with the existing session, turn and timestamp envelope.
Its strict payload contains the exact `requestId` and a reason: `withdrawn`, `expired` or
`unknown`. Each reason requires authoritative unavailability of that exact native callback;
`expired` describes a provider observation. The event ends answer eligibility. It does not
complete the execution or rewrite an entered response's delivery receipt. Runtime validation
owns once-only retirement, original execution correlation and same-session request-ID uniqueness.

`AgentSessionRequest` is a closed union of `decision`, `form` and `plan_review` descriptors
outside a model turn. Each carries `requestId`, `sessionId`, a title, optional description,
explicit offered choices and optional `expiresAt`. That expiry is only a provider-reported fact;
the host's effective deadline is a separate runtime observation. Descriptors have no `turnId`,
provider-native request ID, metadata bag or transport correlation field. The root and focused
`@agen-ai/agent-protocol/session-interactions` entrypoints expose plain types and parsers.
Only `/zod` exposes schemas. The `/json-schema` registry contains 35 deterministic contracts,
including request/response schemas for each session kind and their complete unions.

A workspace decision preserves its exact target and grant/decline consequences. A workspace
`grant` is provider-managed, persistent and may affect other sessions; it covers the workspace
rather than only the categories detected when the question was created. A `decline` leaves
configuration gated without promising revocation, persisted denial or suppression of future
questions. Present the target and consequences before applying a decision policy. V12 responses
are tagged: `parseAgentSessionDecisionResponseFor(request, { kind: 'decision', choiceId })`.
The earlier untagged `{ choiceId }` argument is rejected.

Forms reuse the exact `AgentElicitationField` and `AgentElicitationAnswer` semantics from turn
elicitation. A form offers exactly one `submit` action and optionally one `cancel` action, with
unique choice IDs and distinct actions. Submitted responses carry `answers`; canceled responses
carry no answers. Required fields, kinds, declared select values, custom-choice permission and
selection limits are checked against the offered descriptor. Cancellation is an explicit offered
human action and is never synthesized by timeout or cleanup.

Plan reviews contain the complete actual offered text in an immutable `AgentSessionPlanSnapshot`,
with a neutral `planId`, exact `revision`, title and `plain_text` or `markdown` content. They do
not dereference paths or URLs. Each offered action is `approve`, `revise` or `abandon`, with unique
choice IDs and distinct actions; a mapping must offer the action explicitly. Every response
identifies the exact plan and revision. Only revision responses carry nonblank `feedback`.
Content changes require a fresh revision and request ID. These identities grant no execution
or replay authority.

`parseAgentSessionResponseFor(request, response)` and the kind-specific helpers reject a wrong
kind, unoffered choice, mismatched action, invalid field answer and stale plan identity/revision.
Throwing parsers and their `safeParse...` counterparts use validator-neutral issues. Parsing
creates detached readonly snapshots and rejects unknown fields, cyclic material, accessors and
non-JSON values before invoking a getter. The nominal decision/form/review choice IDs, plan ID
and plan revision are distinct TypeScript types granted only after canonical string validation.

`AgentSessionAcceptedResponse` is the bounded accepted-response projection: it retains kind,
choice and action, plus plan identity/revision when applicable. It omits sensitive form answers
and revision feedback. Actual response authority belongs to the runtime's bound
`AgentSessionInteraction.respond` capability. Process-local callbacks, human-wait policy,
delivery receipts, terminal settlement and cleanup are documented by
[`@agen-ai/agent-runtime`](../agent-runtime/README.md#session-lifetime-interactions).

| Portable bound | Maximum |
| --- | --- |
| Every serialized session request | 65,536 UTF-8 bytes |
| Serialized decision response | 1,024 UTF-8 bytes |
| Serialized form or plan-review response | 65,536 UTF-8 bytes |
| Offered choices | 16, with unique IDs and distinct form/review actions |
| Choice ID, plan ID and plan revision | 128 UTF-8 bytes each |
| Request/plan title and choice label | 120 characters |
| Request description | 4,000 characters |
| Choice description | 1,000 characters |
| Workspace target path | 4,096 UTF-8 bytes |
| Form fields / options per select / text value | 16 / 100 / 4,000 characters |
| Complete plan text | 49,152 UTF-8 bytes within the request bound |
| Revision feedback | 4,000 characters and 16,384 UTF-8 bytes |

The JSON Schema artifacts name residual parser invariants, including serialized UTF-8 bytes,
identity/action uniqueness, exact offered-choice membership, form-field correlation and exact
plan/revision matching. Portable session opening, configuration and turn input do not carry
runtime human-wait policy or callbacks.

## Errors and trust

`AgentError` contains required `category`, stable `code`, safe `message`, tagged `recovery`, and
optional bounded `context`. The categories distinguish rate limiting, exhausted account quota,
turn budget, execution/context limits, authentication, permission, invalid input, provider overload,
transport, provider, protocol, internal, and unknown failures. Adapters classify from native evidence;
an HTTP 429 alone establishes rate limiting and does not establish exhausted account quota.

Recovery is one of `unknown`, `none`, `retry`, `wait_for_quota`, or `user_action`. `retry` may carry
an exactly reported `notBefore` timestamp. `user_action` names `authenticate`, `review_access`,
`change_configuration`, or `review_allowance`. `none` offers no applicable recovery for this operation.
These hints describe possible next steps; the application must assess execution certainty and effect
replay independently before starting more work. The protocol does not retry, schedule continuation,
switch accounts, or switch providers.

An operational failure is separate from terminal authority. `turn.completed` with outcome `failed`
requires an error; other terminal outcomes cannot carry one. A `runtime.error` observation does not
itself complete a turn, and a failed tool item does not by itself fail the turn. Contract violations,
uncertain dispatch and cleanup ownership retain their runtime semantics regardless of failure category.

`wait_for_quota` may carry an immutable `AgentFailureQuotaReference` identifying an existing source,
pool, window, and observation timestamp. Its optional `reset` uses the same `AgentAccountQuotaReset`
shape and preserves reported versus estimated precision. Reset evidence cannot be newer than the
referenced observation. Only `rate_limited` and `quota_exhausted` failures may carry a quota reference;
turn budget and execution limits do not acquire account-quota identity. Omitted quota or reset evidence
remains absent. The host must establish reference visibility and applicability to the selected binding;
historical references grant no eligibility after account or credential changes.

`runtime.retrying` reports provider-owned retry activity within an active turn. It requires
`owner: 'provider'`, the turn identity, and an `AgentError`. Its optional `attempt` is a positive,
one-based retry ordinal; `maxAttempts` is the positive maximum number of retries. Both exclude the
original attempt. When both are reported, `attempt` cannot exceed `maxAttempts`. Optional `delayMs`
is a nonnegative safe integer. Counters may repeat or restart across the provider's request/stream
retry domains within one turn, and missing native facts remain absent. A retry observation neither
completes a turn nor resolves a pending request; a later authoritative success completes the same turn.

V10 removes `AgentError.retryable` and `runtime.warning.payload.retryable`. Warnings retain only
bounded code, message, and optional context. Existing `AgentError`, `parseAgentError`, and
`safeParseAgentError` root imports remain available. Failure messages are bounded at 4,000 characters,
codes at 120 characters, context fields at 160 characters, and serialized failures at 32 KiB.
Context contains only optional `operation`, `component` and `status`; it cannot carry native payloads,
credentials or arbitrary attributes.
The `/json-schema` error artifact publishes structural constraints and names the residual semantic
invariants enforced by the ordinary parser, including quota applicability and reset observation order.

Throwing parsers raise `AgentProtocolValidationError`, a `TypeError` with stable, JSON-safe
`issues`. Each corresponding `safeParse...` function returns either parsed data or the same issue
array without throwing. Callers should branch on that public result or error class, not on Zod
classes or native issue objects.

Opaque identifiers provide correlation, not authorization. A host must authorize the actor,
select the provider instance, constrain the working directory, and map product identities before
constructing protocol input. Unknown fields are rejected; the protocol has no metadata escape
hatch for carrying authority or private provider evidence. Portable JSON objects also reject the
prototype-sensitive keys `__proto__`, `constructor`, and `prototype`; ordinary parsers and the
published JSON Schemas enforce the same rule. Plan-step and progress identifiers, diagnostic codes,
messages, and error context must contain non-whitespace content without surrounding whitespace so
validated protocol output remains canonical across transports and consumers.

## Effective environment values

`managedContent` describes content a caller manages and distributes. `effectiveContent` describes
what the selected harness reports for a workspace or session. Effective descriptors keep registration,
enablement, user invocation, and model callability separate; unknown facts are explicit. Optional
`agentDefinition` observations preserve primary/subagent mode and hidden state independently of
those execution facts. They apply only to agent-definition entries and never grant a spawn action. A package
belongs in `extensions` and references its contributed content, commands, and integrations. MCP
servers and Apps/connectors share the discriminated `integrations` catalog.

`AgentEnvironmentSnapshot` composes these bounded domains without copying their inventories. Each
domain distinguishes unsupported, not initialized, unavailable, partial, and complete observations.
Catalog revisions describe semantic content; observation timestamps never grant mutation authority.
The caller supplies an opaque environment identity. Hosts must scope that identity to their own
account, workspace, configuration, session, and authorization state.

A `content_reference` input part carries the environment and content catalog revisions plus the
selected content identity and revision. It is neither embedded skill text nor a slash command.
Providers advertise reference and argument support explicitly. The parser allows at most 16
references, bounds each argument at 4 KiB of UTF-8, rejects duplicate identities, and includes the
reference bytes in the existing input envelope. Product admission must still validate current
catalog identity, visibility, and execution authority before provider delegation.

Supported reference capabilities require `textFormats.prompt` and `textFormats.arguments`:
`unrestricted` adds no text restriction; `single_line` excludes Unicode control (Cc), format (Cf),
line separator (Zl), and paragraph separator (Zp) characters; `literal_single_line` also excludes
`$`, `@`, backticks, and a slash after leading whitespace. These constraints apply only when the
input contains a content reference and do not replace the ordinary input envelope or other
admission checks. `findAgentContentReferenceTextIssue` reports the affected field and format
without returning submitted text. `meetAgentContentReferenceTextFormat` retains the stricter
constraint when composing capabilities. Runtime and product admission must enforce both fields
before delegation; a composer can use the same pure functions to preserve and explain an invalid draft.

## Versioning and release

Agent Protocol V12 defines the contract shared by this package, `@agen-ai/validation`, and
`@agen-ai/agent-runtime`. The coordinated release is `0.4.3`; published `0.4.1` retains
V11 and `0.4.0` retains V10. Registry publication and dist-tag state are release metadata outside
this contract. Earlier public releases remain historical. The complete seven-package public
release inventory must use one coordinated source version.

Protocol V12 is independent of private transport and product persistence versions and replaces
V11 at live boundaries. There is one current parser. V11 and older serialized data require the
historical owner's frozen decoder and are rejected by the live V12 parser where versioned.
The environment and account-quota namespaces each retain their own schema version 1.

The repository release proof builds and packs the exact seven-package release set, rejects
workspace-only or private references, then typechecks and runs a consumer outside the monorepo.

From the public repository root, run `pnpm check` to execute the same packed-consumer proof.

That command does not publish. Registry publication, provenance submission, tags, and release
credentials require a separately authorized release.
