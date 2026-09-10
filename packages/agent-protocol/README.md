# `@agen-ai/agent-protocol`

`@agen-ai/agent-protocol` is the provider-neutral data contract for coding-agent runtimes. It
defines opaque identifiers, sessions, turns, approval and elicitation requests, technical
capabilities, typed operations, safe configuration and managed-content inventories, integration
observations, effective harness content and package catalogs, environment observations, account-quota observations, collaboration lifecycles, generated resources, portable
artifact descriptors, and provider-observed events. The package does not define a transport or
execution runtime.

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
- `/sessions`, `/turns`, `/requests`, `/events`, `/capabilities`, `/artifacts`, `/operations`,
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
  protocolVersion: 9,
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

Serialized values carry `protocolVersion: 9`; TypeScript API names remain unsuffixed. Unknown
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

V9 approval requests correlate to one live item or exact proposed-plan artifact and provide a
bounded list of typed options. Every option declares its decision, persistence, and neutral scope;
resolutions select one offered `optionId` or explicitly cancel. Approval capabilities advertise
the exact persistence/scope combinations an adapter can emit. `context.usage.updated` reports
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

## Errors and trust

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

Agent Protocol V9 defines the coordinated SDK `0.3.0` contract shared by this package,
`@agen-ai/validation`, and `@agen-ai/agent-runtime`. Registry publication and dist-tag state are
release metadata outside this contract. The earlier public `0.2.5` release remains historical. All
three SDK packages must be released together. Protocol V9 is independent of private transport and
product persistence versions and directly replaces V8 at live boundaries. There is one current
parser. The environment and account-quota namespaces each use their own schema version 1.

The repository release proof builds and packs `@agen-ai/validation`, this package, and
`@agen-ai/agent-runtime`; rejects workspace-only or private references; then typechecks and runs a
consumer outside the monorepo:

From the public repository root, run `pnpm check` to execute the same packed-consumer proof.

That command does not publish. Registry publication, provenance submission, tags, and release
credentials require a separately authorized release.
