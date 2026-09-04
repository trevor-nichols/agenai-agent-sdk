# Migrating from 0.2.2 to 0.2.3

Version `0.2.3` is a coordinated beta release of all three packages and implements Agent Protocol
V8. It intentionally replaces the V7 interaction-extension surface rather than preserving aliases,
fallback readers, or dual-protocol behavior. Upgrade the validation, protocol, and runtime packages
together.

## API change report

| Area | 0.2.2 / V7 | 0.2.3 / V8 |
| --- | --- | --- |
| Protocol discriminator | `protocolVersion: 7` | `protocolVersion: 8` |
| Native interactions | Generic extension booleans | Typed capability domains and catalogs |
| Provider operations | No normalized operation port | Catalog-backed typed invocation |
| Configuration | Session input only | Managed or selectable catalog with revisioned selection |
| MCP state | Provider-specific handling | Member-safe integration observations |
| Subagents | Provider-specific handling | Bounded collaboration graph and lifecycle controls |
| Generated output | Artifact descriptors | Artifact descriptors plus retrievable generated resources |
| Delegation evidence | Inferred around calls | Explicit provider-execution-start observation |
| Streaming boundary | Terminal output | Terminal output or exactly one pending request |

The ordinary public entrypoints remain validator-neutral. The explicit `/zod` entrypoints remain
the only surfaces that expose Zod, and `/json-schema` continues to publish deterministic Draft
2020-12 artifacts.

## Replace interaction-extension booleans

Delete `interactionExtensions`. Declare every V8 domain independently, using the exact
`{ kind: "unsupported" }` discriminant until the adapter implements the matching behavior:

```ts
const capabilities = parseAgentCapabilities({
  protocolVersion: 8,
  providerKey,
  sessions: {
    create: true,
    resume: false,
    branch: { kind: "unsupported" },
  },
  turns: {
    interactionModes: ["default"],
    interrupt: false,
    steer: { kind: "unsupported" },
  },
  requests: {
    approval: { kind: "unsupported" },
    elicitation: { kind: "unsupported" },
  },
  context: {
    usage: { kind: "unsupported" },
    compaction: { kind: "unsupported" },
  },
  input: {
    text: true,
    images: { kind: "unsupported" },
  },
  output: {
    streaming: true,
    plans: false,
    fileChanges: "none",
    artifactKinds: [],
  },
  configuration: { kind: "managed" },
  operations: { kind: "unsupported" },
  managedContent: { kind: "unsupported" },
  integrations: { kind: "unsupported" },
  collaboration: { kind: "unsupported" },
  generatedResources: { kind: "unsupported" },
  authentication: { kind: "unsupported" },
  versionReporting: false,
});
```

Advertising support is a runtime promise. A supported capability must have the corresponding
provider-session port and must honor its advertised kinds and bounds. Do not advertise native
provider functionality that the adapter cannot yet project through the neutral contract.

## Add capability-matched session ports

Every `AgentProviderSession` now carries explicit discriminated ports for configuration,
operations, managed content, integration observation, collaboration control, and generated-resource
access. Match each port to the capability declaration:

```ts
const session: AgentProviderSession = {
  binding,
  runTurn,
  resolveRequest,
  interruption: { kind: "unsupported" },
  steering: { kind: "unsupported" },
  configuration: { kind: "managed" },
  operations: { kind: "unsupported" },
  managedContent: { kind: "unsupported" },
  integrations: { kind: "unsupported" },
  collaboration: { kind: "unsupported" },
  generatedResources: { kind: "unsupported" },
  close,
};
```

When a domain is supported, implement only its typed port. Keep native commands, identifiers,
credentials, paths, and opaque envelopes inside the adapter.

## Preserve execution-start truth

Mutating provider operations accept an execution-start observer. Invoke it immediately before the
provider side effect. If the observer fails, preserve that failure as pre-delegation and do not call
the provider. Once the observer succeeds, a lost or interrupted result is delivery-uncertain; do
not report it as definitively not started.

This ordering lets a host durably journal the exact transition without inferring provider start
from control flow.

## Update streams and request continuations

A validated turn or request-continuation stream ends at one of two boundaries:

- a terminal turn event; or
- exactly one live pending request.

Preserve per-output backpressure. Do not read ahead, buffer an unbounded provider stream, or allow a
second request to become pending. If an accepted interruption ends an already-waiting turn without
a terminal event, close and rematerialize the validated session before further mutation.

## Upgrade sequence

1. Update `@agen-ai/validation`, `@agen-ai/agent-protocol`, and `@agen-ai/agent-runtime` to `0.2.3`
   in one change.
2. Change every serialized discriminator and fixture to `protocolVersion: 8`.
3. Replace `interactionExtensions` with all required V8 capability domains, initially marking
   unimplemented domains unsupported.
4. Add every capability-matched `AgentProviderSession` port, then enable support one domain at a
   time with its typed catalog and operation implementation.
5. Place the provider-execution-start observer at the exact side-effect boundary.
6. Update stream handling to stop at the terminal-or-one-pending-request boundary while preserving
   backpressure.
7. Run `runAgentProviderConformance` and all host integration tests.
8. Deploy producers and consumers as one coordinated cut. Do not retain a V7 reader, dual writer,
   or compatibility shim.

If a host persists protocol values, its persistence migration and retained-history policy are host
concerns outside this public SDK. The public protocol does not authorize rewriting historical data.
