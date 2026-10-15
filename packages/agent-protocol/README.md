# `@agen-ai/agent-protocol`

`@agen-ai/agent-protocol` is the provider-neutral data contract for coding-agent runtimes. It
defines opaque identifiers, sessions, turns, approval and elicitation requests, technical
capabilities, typed operations, safe configuration and managed-content inventories, integration
observations, effective harness content and package catalogs, environment observations, account-quota observations, operational failures and recovery hints, collaboration lifecycles, generated resources, portable
artifact descriptors, and provider-observed events. The package does not define a transport or
execution runtime.
The coordinated source version is unpublished `0.4.1` and uses Agent Protocol V11. The published
release remains `0.4.0` with V10. The source candidate also includes session-decision data.

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
  protocolVersion: 11,
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

Serialized values carry `protocolVersion: 11`; TypeScript API names remain unsuffixed. Unknown
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
fields are rejected in V11. Neither approval nor a delivered answer proves the provider wrote a rule.
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

## Session-decision data

`AgentSessionDecisionRequest` describes a bounded decision outside any model turn. It carries
`requestId`, `sessionId`, a title, optional description, a workspace target, `expiresAt` and
one to sixteen uniquely identified choices. It has no `turnId`, provider-native request ID,
open metadata bag or transport correlation field. Use the root entrypoint or the focused
`@agen-ai/agent-protocol/session-interactions` entrypoint for its plain types and parsers.
Only `/zod` exposes the corresponding schemas; the deterministic JSON Schema surface retains
the same portable data boundary.

Every choice describes its consequence. A workspace `grant` is provider-managed, persistent
and may affect other sessions; it authorizes the workspace rather than only the categories
detected when the question was created. A `decline` leaves configuration gated and does not
promise revocation of existing trust, persisted denial or suppression of future questions.
Hosts must present the target and consequences before applying their decision policy.
Descriptions and opaque IDs are data, not execution authority.

`parseAgentSessionDecisionResponseFor(request, { choiceId })` validates that the response
selects a choice offered by that exact request. The response has no free-form answer or
caller-supplied request/session correlation. Actual response authority belongs to the runtime's
bound `AgentSessionInteraction.respond` capability. The protocol defines portable data;
callback lifetime, deadlines, delivery receipts, terminal settlement and cleanup are documented
by [`@agen-ai/agent-runtime`](../agent-runtime/README.md#session-lifetime-interactions).

| Portable bound | Maximum |
| --- | --- |
| Serialized request | 65,536 UTF-8 bytes |
| Serialized response | 1,024 UTF-8 bytes |
| Offered choices | 16, with unique IDs |
| Choice ID | 128 UTF-8 bytes |
| Request title and choice label | 120 characters |
| Request description | 4,000 characters |
| Choice description | 1,000 characters |
| Workspace target path | 4,096 UTF-8 bytes |

Throwing parsers and `safeParse...` variants use the existing validator-neutral issue contract.
Unknown fields, duplicate choice IDs and unsupported consequence shapes reject. These values
remain separate from turn approval/elicitation data and introduce no protocol-version change.

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

Agent Protocol V11 defines the contract shared by this package, `@agen-ai/validation`, and
`@agen-ai/agent-runtime`. The coordinated source SDK is unpublished `0.4.1`; the published
release is `0.4.0` with V10. Registry publication and dist-tag state are
release metadata outside this contract. The earlier public `0.3.0` and `0.3.1` releases remain historical.
The complete seven-package public release inventory must use one coordinated source version. Protocol V11 is
independent of private transport and product
persistence versions and directly replaces V10 at live boundaries. There is one current parser. V10
and older serialized data require the historical owner's frozen decoder and are rejected by the live V11 parser. The
environment and account-quota namespaces each use their own schema version 1.

The repository release proof builds and packs `@agen-ai/validation`, this package, and
`@agen-ai/agent-runtime`; rejects workspace-only or private references; then typechecks and runs a
consumer outside the monorepo:

From the public repository root, run `pnpm check` to execute the same packed-consumer proof.

That command does not publish. Registry publication, provenance submission, tags, and release
credentials require a separately authorized release.
