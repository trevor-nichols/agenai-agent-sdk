# Migrating to 0.3.0

Upgrade `@agen-ai/validation`, `@agen-ai/agent-protocol`, and `@agen-ai/agent-runtime` together.
Version `0.3.0` is a direct hard cut from Agent Protocol V8 to V9. The `latest` and `beta` npm tags
select the same release. Provider adapters must be rebuilt against the V9 contracts before they can
use the new package set.

The public SDK contains the protocol and runtime contracts only. Provider-native adapters,
credentials, process management, and native identifiers stay in their private integration. Private
host or transport protocols are outside the public package set and are not part of this release.

## Breaking changes at a glance

| Area | 0.2.5 | 0.3.0 |
| --- | --- | --- |
| Serialized protocol discriminator | `protocolVersion: 8` | `protocolVersion: 9` |
| Materialized instance | `accountQuota` was required | Add required `environment` discovery port |
| Provider session | Standalone `integrations` observation port | Add required `environment` observation port |
| Environment inventory | No shared effective harness snapshot | Add revisioned `content`, `commands`, `extensions`, and `integrations` domains |
| Turn input | Text and image parts | Add selected `content_reference` parts |
| Input capability | Text and image limits | Add content-reference count, argument, and text-format limits |

## Update all three package versions

Use one version for the validation, protocol, and runtime packages:

```sh
pnpm add @agen-ai/validation@0.3.0 @agen-ai/agent-protocol@0.3.0 @agen-ai/agent-runtime@0.3.0
```

Keep the `accountQuota` field introduced in 0.2.5. This release does not move quota into the
conversation or environment snapshot, and quota remains outside turn execution and authorization.

## Move serialized values to Agent Protocol V9

Change every serialized protocol discriminator from `8` to `9`:

```ts
import { parseAgentEvent } from "@agen-ai/agent-protocol";

const event = parseAgentEvent({
  protocolVersion: 9,
  // Keep the rest of the V9 event fields from the provider output contract.
  type: "turn.started",
  sessionId: "external-session:42",
  turnId: "external-turn:9",
  occurredAt: "2026-08-03T20:00:00.000Z",
  payload: {},
});
```

Use the V9 parsers and schemas throughout the adapter. V8 values are rejected at the live
boundary; there is one current parser and no V8 compatibility reader. The environment and quota
namespaces each retain their own schema version `1`, which is separate from `protocolVersion`.

The example above shows the discriminator change only. A real event must still satisfy the exact
V9 event type and payload schema. When a provider reports an event, use the corresponding typed
V9 output contract rather than forwarding a native event object.

## Add environment capability declarations

`AgentCapabilities` now requires an `environment` capability with separate instance and session
scopes. A provider with no environment support must declare both scopes as unsupported:

```ts
import type {
  AgentCapabilities,
  AgentOperationInputCapability,
} from "@agen-ai/agent-protocol";

const environment: AgentCapabilities["environment"] = {
  instance: { kind: "unsupported" },
  session: { kind: "unsupported" },
};

const input: AgentOperationInputCapability = {
  text: true,
  images: { kind: "unsupported" },
  contentReferences: { kind: "unsupported" },
};
```

Add these values to the existing capabilities object. A supported scope uses one of the following
exact declarations and must list at least one domain:

```ts
const environmentCapability: AgentCapabilities["environment"] = {
  instance: { kind: "read_and_watch", domains: ["content", "commands"] },
  session: { kind: "read", domains: ["content"] },
};
```

The runtime requires the corresponding port kind and domain list to match the capability exactly,
including domain order. Capability declarations describe technical possibility only. They do not
publish an inventory or authorize an actor.

## Add the instance and session environment ports

Every `MaterializedAgentProviderInstance` must now include `environment`. Use the explicit
unsupported value when the instance cannot discover a workspace:

```ts
import type { MaterializedAgentProviderInstance } from "@agen-ai/agent-runtime";

const noDiscovery: MaterializedAgentProviderInstance["environment"] = {
  kind: "unsupported",
};
```

Add `environment: noDiscovery` to the object returned by `createInstance`, alongside the existing
`accountQuota`, adapter, readiness, and disposal fields.

Every `AgentProviderSession` must now include `environment`. Use the matching observation type when
the provider has no session observation:

```ts
import type { AgentProviderSession } from "@agen-ai/agent-runtime";

const noSessionObservation: AgentProviderSession["environment"] = {
  kind: "unsupported",
};
```

A supported instance discovery port has exactly one of these shapes:

- `{ kind: "read", domains, readEnvironment }`
- `{ kind: "read_and_watch", domains, readEnvironment, watchEnvironment }`

A supported session observation port has the same two shapes. `readEnvironment` receives a required
`signal` and `environmentId`. Instance discovery also receives the canonical absolute
`workingDirectory` and validated session `configuration`. `watchEnvironment` receives the scoped
watch input and returns an `AsyncIterable` of environment invalidations. The runtime rejects extra
handlers, missing handlers, mismatched domains, invalid paths, and snapshots or invalidations that
do not echo the requested environment identity.

Remove `integrations` from the object returned as an `AgentProviderSession`. MCP and connector
observations now arrive through the session environment snapshot. Keep the existing
`capabilities.integrations` technical limits for the integration entries a provider can report.

## Separate managed content from effective harness content

`managedContent` and `effectiveContent` have different ownership and meaning:

- `managedContent` remains the caller-managed inventory used for distribution and product workflows.
- `effectiveContent` is the selected native harness observation. Its descriptors keep registration,
  enablement, user invocation, and model callability as separate facts, including explicit unknown
  values.
- `commands` is the effective command catalog.
- `extensions` describes installed packages and exact references to contributed content, commands,
  or integrations.
- `integrations` contains both MCP server descriptors and Apps or connector descriptors.

Use the focused plain entrypoints when a consumer needs one domain:

```ts
import { parseAgentEnvironmentSnapshot } from "@agen-ai/agent-protocol/environment";
import { parseAgentEffectiveContentCatalog } from "@agen-ai/agent-protocol/effective-content";
import { parseAgentExtensionCatalog } from "@agen-ai/agent-protocol/extensions";
import { parseAgentCommandCatalog } from "@agen-ai/agent-protocol/commands";
```

The plain entrypoints expose types, constants, parsers, and validator-neutral issues. Zod schemas are
available only from `@agen-ai/agent-protocol/zod`; deterministic JSON Schema artifacts are available
from `@agen-ai/agent-protocol/json-schema`. A successful empty catalog means the provider observed no
entries. A failed, unavailable, or partial read must retain its explicit state and reasons.

The runtime port types and validators are available from `@agen-ai/agent-runtime/environment` and
are also re-exported by `@agen-ai/agent-runtime`.

## Add content-reference input support

If the provider accepts selected effective content, add a supported `contentReferences` capability
inside `capabilities.input` and, when steering is supported, inside `capabilities.turns.steer.input`:

```ts
import type { AgentOperationInputCapability } from "@agen-ai/agent-protocol";

const contentReferences: AgentOperationInputCapability["contentReferences"] = {
  kind: "supported",
  maxReferences: 4,
  arguments: true,
  textFormats: {
    prompt: "single_line",
    arguments: "literal_single_line",
  },
};
```

A selected part carries all of the revisions needed for product admission. Construct opaque IDs
through the public parsers and validate the complete turn input with the existing turn parser:

```ts
import {
  parseAgentEnvironmentId,
  parseAgentEffectiveContentId,
  parseAgentTurnInputContent,
} from "@agen-ai/agent-protocol";

const input = parseAgentTurnInputContent({
  parts: [
    { type: "text", text: "Use the selected skill." },
    {
      type: "content_reference",
      environmentId: parseAgentEnvironmentId("environment:workspace"),
      environmentRevision: 7,
      contentCatalogRevision: 12,
      contentId: parseAgentEffectiveContentId("skill:review"),
      contentRevision: 3,
      arguments: "Focus on tests and release notes.",
    },
  ],
});
```

The protocol accepts at most 16 content references per turn, rejects duplicate `(environmentId,
contentId)` identities, bounds each `arguments` value to 4 KiB of UTF-8, and includes reference
bytes in the existing turn-input envelope. `single_line` rejects Unicode control, format, line
separator, and paragraph separator characters. `literal_single_line` adds `$`, `@`, backtick, and
leading-slash restrictions. These text rules apply when the input contains a content reference.

The protocol parser validates shape and bounds. The runtime validates the provider's declared input
capability. The product host must still check current environment identity, catalog revision,
content revision, visibility, registration, enablement, invocation posture, and its immutable
execution lease immediately before delegation. A content reference is not embedded native skill
text and must not be converted into a slash-prefixed ordinary turn.

## Adopt scoped cancellation and watch behavior

Every environment read and watch receives a caller-owned `AbortSignal`. The validated runtime
combines it with the materialized-instance or provider-session lifetime. Aborting either scope
cancels pending work and prevents late snapshots or invalidations from reaching the caller. Providers
must honor the signal and release native resources.

Watch consumers must pull sequentially. Concurrent `next()` calls are rejected. Aborting a watch,
calling its iterator `return()`, normal completion, instance disposal, or session close all attempt
native iterator cleanup. The validated runtime bounds that cleanup to 1,000 milliseconds and observes
late native rejections. Providers should use a pull-based async iterator and treat the signal as the
lifetime of the native watcher.

The optional `onProviderExecutionStarted` observer is available on reads, after runtime prechecks and
immediately before candidate-provider delegation. It is not included in watch input. A read that
returns an environment metadata error does not by itself invalidate the provider session; callers
should retain the explicit unavailable or partial observation and decide product behavior separately.

## Validate and release

Update provider adapter fixtures, fake providers, and conformance calls for the required environment
fields and V9 capabilities. Run the packed-consumer proof from the public repository root:

```sh
pnpm check
```

The check generates and verifies plain contract surfaces and JSON Schema, builds and typechecks all
three packages, runs their tests, packs the packages, and typechecks a consumer outside the
workspace. It does not publish. Run `runAgentProviderConformance` from
`@agen-ai/agent-runtime/testing` against each provider adapter before release.

The public release contains no built-in Codex, Claude, or other provider adapter. Keep those
implementations and all provider-native evidence in their owning integration and update them against
this migration guide.
