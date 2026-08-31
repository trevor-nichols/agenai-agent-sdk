# AgenAI Agent SDK

A provider-neutral TypeScript contract for hosting coding agents.

> Status: `0.2.2` with Agent Protocol V7. The `latest` and `beta` npm tags both select this release.

## Why this exists

Claude Code, Cursor, Codex, OpenCode, Grok, and custom agent CLIs all model sessions differently.
Their turn APIs, interaction requests, streaming output, capabilities, and shutdown behavior rarely
line up. A host that supports several agents can end up rebuilding the same lifecycle code for every
provider.

The AgenAI Agent SDK gives those providers one process-local interface to implement. A driver
materializes an instance, the instance exposes an adapter, and the adapter opens sessions. The host
works with the same validated session contract regardless of the native API behind it.

Provider-specific protocols, credentials, process management, and native session identifiers stay
inside the adapter. Product concerns such as users, workspaces, authorization, billing, persistence,
and scheduling stay in the host.

Write the host once. Adapt each agent once.

## Packages

| Package | Purpose |
| --- | --- |
| `@agen-ai/validation` | Validator-neutral issue data with an optional Zod 4 adapter. |
| `@agen-ai/agent-protocol` | Sessions, turns, requests, capabilities, events, artifacts, parsers, and schemas. |
| `@agen-ai/agent-runtime` | Drivers, instances, adapters, sessions, lifecycle validation, registry mechanics, and conformance tools. |

The dependency chain is intentionally narrow:

```text
@agen-ai/agent-runtime
  -> @agen-ai/agent-protocol
       -> @agen-ai/validation
       -> zod
```

## Install

Install the coordinated `0.2.2` release directly or through npm's default `latest` channel:

```sh
pnpm add @agen-ai/agent-runtime@0.2.2
```

The `beta` tag also selects `0.2.2` for repositories that adopted the prerelease channel. The
protocol and validation packages are installed automatically. Install them directly only when you
need their public APIs without the runtime.

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
and disposal. A session covers create, resume, branch, turns, interaction requests, steering,
interruption, and close according to the capabilities reported by its provider.

This is a service-provider interface, not a network protocol and not a lowest-common-denominator
wrapper. An adapter translates its native provider behavior at the boundary while keeping useful
provider mechanics intact.

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
typechecks all three packages, runs their tests, packs each package, and installs the tarballs into
a temporary project. Nothing is published by that command.

Package-specific API and lifecycle notes live in each package README:

- [`@agen-ai/validation`](packages/validation/README.md)
- [`@agen-ai/agent-protocol`](packages/agent-protocol/README.md)
- [`@agen-ai/agent-runtime`](packages/agent-runtime/README.md)

## What changed in 0.2.2

This patch tightens the validated runtime and deliberate Zod composition surface without changing
Agent Protocol V7. It preserves live approval correlation through provider status uncertainty,
rejects terminal or rebound approval subjects, resets materialization-scoped context usage at
explicit process boundaries, accepts the full protocol-sized approval prompt, and enforces
canonical approval capability lists in the standalone schema. See
[MIGRATING-TO-0.2.md](MIGRATING-TO-0.2.md) for the original breaking `0.1.0` migration and
[CHANGELOG.md](CHANGELOG.md) for complete release notes.

The SDK remains beta while external provider adapters prove the public surface. Minor releases may
contain breaking API changes during this beta period, and release notes will call out each one.

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
