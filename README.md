# AgenAI Agent SDK

A provider-neutral TypeScript contract for hosting coding agents.

> Status: `0.3.0` with Agent Protocol V9. The `latest` and `beta` npm tags both select this release.

## Why this exists

Claude Code, Cursor, Codex, OpenCode, Grok, and custom agent CLIs all model sessions differently.
Their turn APIs, interaction requests, streaming output, capabilities, and shutdown behavior rarely
line up. A host that supports several agents can end up rebuilding the same lifecycle code for every
provider.

The AgenAI Agent SDK gives those providers one process-local interface to implement. A driver
materializes an instance, the instance exposes an adapter, and the adapter opens sessions. The host
works with the same validated session contract regardless of the native API behind it.

Provider-specific protocols, credentials, process management, native session identifiers, and
provider adapters stay with the adapter owner. They are not shipped in these public packages.
Product concerns such as users, workspaces, authorization, billing, persistence, and scheduling
stay in the host.

Write the host once. Adapt each agent once.

## Packages

| Package | Purpose |
| --- | --- |
| `@agen-ai/validation` | Validator-neutral issue data with an optional Zod 4 adapter. |
| `@agen-ai/agent-protocol` | Sessions, turns, requests, capabilities, events, artifacts, environment catalogs, parsers, and schemas. |
| `@agen-ai/agent-runtime` | Drivers, instances, adapters, sessions, environment lifecycle validation, registry mechanics, and conformance tools. |

The dependency chain is intentionally narrow:

```text
@agen-ai/agent-runtime
  -> @agen-ai/agent-protocol
       -> @agen-ai/validation
       -> zod
```

## Install

Install the coordinated `0.3.0` release directly or through npm's `latest` channel:

```sh
pnpm add @agen-ai/agent-runtime@0.3.0
```

The `beta` tag also selects `0.3.0` for repositories that use the prerelease channel. The protocol
and validation packages are installed automatically. Install them directly when you need their
public APIs without the runtime:

```sh
pnpm add @agen-ai/validation@0.3.0 @agen-ai/agent-protocol@0.3.0
```

All three packages must use the same version. Agent Protocol V9 is a direct replacement for V8 at
the live boundary; the parser does not provide a V8 compatibility mode.

## Runtime shape

```text
host policy
    |
    v
driver -> materialized instance -> adapter -> provider session
                                      |
                                      +-> validated streaming output
```

The host selects and authorizes an instance before entering the SDK. The runtime validates the
materialized instance, capability declarations, adapter behavior, stream boundaries, readiness,
environment ports, and disposal. A session covers create, resume, branch, turns, interaction
requests, steering, interruption, environment observation, and close according to the capabilities
reported by its provider.

This is a service-provider interface, not a network protocol and not a lowest-common-denominator
wrapper. An adapter translates its native provider behavior at the boundary while keeping useful
provider mechanics inside the adapter.

## Environment and effective content

Agent Protocol V9 separates content a host manages from content a selected native harness actually
reports:

- `managedContent` is the caller-managed inventory used for distribution and product workflows.
- `effectiveContent` is the observed harness inventory, with separate registration, enablement,
  user-invocation, and model-callability facts.
- `commands` describes effective command entries.
- `extensions` describes installed packages and exact references to contributed content, commands,
  or integrations.
- `integrations` is a discriminated catalog for both MCP servers and Apps or connectors.

The environment snapshot composes those domains and distinguishes unsupported, not initialized,
unavailable, partial, and complete observations. Catalog revisions and observation timestamps are
descriptive evidence. They do not grant authorization or invocation authority.

Both runtime environment ports are explicit capability-matched variants: `unsupported`, `read`, or
`read_and_watch`. A materialized instance uses `environment` for workspace discovery. A provider
session uses `environment` for observations of its already bound session. Discovery requires the
host-selected environment ID, a canonical absolute working directory, and validated configuration;
session observation requires the bound environment ID. Supported ports declare their domains, and
the runtime rejects a port whose kind or domains disagree with the capability declaration.

## Selected content references

A turn can carry a selected effective-content reference instead of embedding native skill text or
forwarding a slash-prefixed command. The reference carries the environment revision, content
catalog revision, content identity, and content revision. The host must authorize the current
catalog entry and its immutable execution lease before provider delegation.

```ts
import {
  parseAgentEnvironmentId,
  parseAgentEffectiveContentId,
  type AgentContentReferenceInputPart,
} from "@agen-ai/agent-protocol";

const selectedSkill: AgentContentReferenceInputPart = {
  type: "content_reference",
  environmentId: parseAgentEnvironmentId("environment:workspace"),
  environmentRevision: 7,
  contentCatalogRevision: 12,
  contentId: parseAgentEffectiveContentId("skill:review"),
  contentRevision: 3,
  arguments: "Focus on tests and release notes.",
};
```

Providers advertise whether they accept content references, whether reference arguments are
supported, the maximum number of references, and the allowed prompt and argument text formats.
The protocol bounds a turn to 16 references and bounds each argument to 4 KiB of UTF-8. Runtime
validation applies the declared capability, while the product host remains responsible for current
catalog identity, visibility, and execution authority.

## Work from source

You need Node.js 22 or newer and pnpm 11.7.0.

```sh
git clone https://github.com/trevor-nichols/agenai-agent-sdk.git
cd agenai-agent-sdk
corepack enable
pnpm install
pnpm check
```

`pnpm check` validates repository metadata, checks generated protocol surfaces, builds and
typechecks all three packages, runs their tests, packs each package, and installs the tarballs into a
temporary project. Nothing is published by that command.

Package-specific API and lifecycle notes live in each package README:

- [`@agen-ai/validation`](packages/validation/README.md)
- [`@agen-ai/agent-protocol`](packages/agent-protocol/README.md)
- [`@agen-ai/agent-runtime`](packages/agent-runtime/README.md)

## What changed in 0.3.0

This coordinated release advances all three packages from Agent Protocol V8 to V9. It adds the
effective environment catalogs and scoped discovery or observation lifecycle, folds MCP and Apps
or connectors into one integration catalog, and adds capability-bound selected content references.
The former standalone session integrations observation port is removed. Materialized instances and
sessions must expose explicit environment ports, including an explicit unsupported value when the
provider has no environment support.

See [CHANGELOG.md](CHANGELOG.md) for the complete release notes and
[MIGRATING-TO-0.3.md](MIGRATING-TO-0.3.md) for the source changes required by provider adapter
implementations. Earlier migration guides cover [operation observations](MIGRATING-TO-0.2.4.md),
[the V7-to-V8 upgrade](MIGRATING-TO-0.2.3.md), and [the original 0.2.0 cut](MIGRATING-TO-0.2.md).

The SDK remains beta while external provider adapters prove the public surface. Pre-1.0 releases
may contain breaking API changes during this period, and release notes call out each one.

## Contributing

Issues and pull requests are welcome. AgenAI develops the SDK alongside private host code in a
private monorepo, which remains the source authority. Maintainers import accepted public changes
there, run the full integration suite, and export the canonical public result back to this
repository. Contributor authorship is preserved through that process.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, [RELEASING.md](RELEASING.md)
for the maintainer release process, and [SECURITY.md](SECURITY.md) for private vulnerability
reporting.

## License

MIT. See [LICENSE](LICENSE).
