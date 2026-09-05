# `@agen-ai/agent-protocol`

`@agen-ai/agent-protocol` is the provider-neutral data contract for coding-agent runtimes. It
defines opaque identifiers, sessions, turns, approval and elicitation requests, technical
capabilities, typed operations, safe configuration and managed-content inventories, integration
observations, collaboration lifecycles, generated resources, portable artifact descriptors, and
provider-observed events. The package does not define a transport or execution runtime.

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

## Entrypoints

- `@agen-ai/agent-protocol` exports the complete plain API.
- `/sessions`, `/turns`, `/requests`, `/events`, `/capabilities`, `/artifacts`, `/operations`,
  `/configuration`, `/managed-content`, `/integrations`, `/collaboration`, and `/resources` are
  focused plain entrypoints.
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
  protocolVersion: 8,
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

Serialized values carry `protocolVersion: 8`; TypeScript API names remain unsuffixed. Unknown
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

V8 approval requests correlate to one live item or exact proposed-plan artifact and provide a
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
and an artifact reference only when the resource is available. None of these domains has a generic
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

## Versioning and release

The package is at `0.2.4` while the public API is still being proven with external adapters.
Pre-1.0 releases may include breaking changes during this beta period, and every such change is
called out in the release notes. Protocol V8 is independent of any host transport or product
persistence version. It directly replaces V7 in source; there is no compatibility parser, alias,
or extension reader.

The repository release proof builds and packs `@agen-ai/validation`, this package, and
`@agen-ai/agent-runtime`; rejects workspace-only or private references; then typechecks and runs a
consumer outside the monorepo:

From the public repository root, run `pnpm check` to execute the same packed-consumer proof.

That command does not publish. Registry publication, provenance submission, tags, and release
credentials require a separately authorized release.
