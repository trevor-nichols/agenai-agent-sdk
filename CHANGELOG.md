# Changelog

All notable changes to the coordinated AgenAI Agent SDK package set are recorded here. The three
packages always ship together at one version during beta.

## 0.3.1 - 2026-09-12

This coordinated patch release preserves Agent Protocol V9 and the complete public API shipped in
`0.3.0`. The `beta` and `latest` npm tags select the same `0.3.1` release.

### Changed

- Clarify that authentication and credential selection are adapter-owned. The public SDK neither
  requires API keys nor prefers them over provider-supported subscription or interactive login.
- Advance all three package manifests and packed dependency ranges together to `0.3.1` without
  adding provider-native account, credential, terminal, or product authorization contracts.
- Refresh the governed public projection, repository checks, and packed external-consumer proof
  for the coordinated patch release.

See [MIGRATING-TO-0.3.1.md](MIGRATING-TO-0.3.1.md) for the compatibility and release checklist.

## 0.3.0 - 2026-09-10

This coordinated release advances all three packages from Agent Protocol V8 to V9. The `beta`
and `latest` npm tags select the same `0.3.0` release.

### Added

- Add effective environment observations with bounded `content`, `commands`, `extensions`, and
  `integrations` domains. Each domain reports unsupported, not initialized, unavailable, partial,
  or complete state with scoped evidence, catalog revision, and observation time.
- Add focused plain entrypoints for `/effective-content`, `/commands`, `/extensions`, and
  `/environment`, plus parsers and the explicit `/zod` and `/json-schema` surfaces for the new
  contracts.
- Add capability-bound instance discovery and session observation ports. Each port explicitly
  declares `unsupported`, `read`, or `read_and_watch`; supported ports declare the domains they
  observe, and reads and invalidations echo the caller-supplied environment identity.
- Add selected `content_reference` turn input parts carrying environment, catalog, content, and
  content revisions. Add capability fields for reference count, argument support, and prompt or
  argument text formats.
- Add Apps or connector integration descriptors alongside MCP descriptors in the shared
  integrations catalog. Extension descriptors can reference exact contributed content, command,
  and integration catalog generations.

### Changed

- Require serialized protocol values and capability declarations to carry `protocolVersion: 9`.
  V8 values are rejected at the live boundary; the public parser has no compatibility mode.
- Require every materialized instance to expose `environment`, using `{ kind: "unsupported" }`
  when discovery is unavailable. Require every provider session to expose its matching
  environment observation port.
- Enforce canonical absolute discovery working directories, validated configuration, exact
  environment identity echoing, declared domain matching, caller and owner cancellation, and
  sequential watch pulls with bounded native iterator cleanup.
- Keep `managedContent` as caller-managed content and `effectiveContent` as native harness
  evidence. Effective inventory does not authorize a selected reference or provider operation;
  the product host supplies current visibility and execution authority.
- Keep all three package versions coordinated at `0.3.0`. Account-quota observations remain an
  instance-scoped public port outside session events and execution admission.

### Removed

- Remove the standalone provider-session `integrations` observation port. MCP servers and Apps or
  connectors are now reported through the environment integration catalog.
- Remove Agent Protocol V8 parsing and compatibility behavior at the public boundary.

Provider-native adapters, credentials, process management, native identifiers, and private host
or transport protocols remain outside the public package set. Update adapter implementations with
[MIGRATING-TO-0.3.md](MIGRATING-TO-0.3.md) before using this release.

## 0.2.5 - 2026-09-08

This coordinated release preserves Agent Protocol V8 and introduces account-quota snapshot
schema version 1 outside session events.

### Added

- Add the validator-neutral `/account-quota` entrypoint with bounded snapshots, quota windows,
  allowance states, source identity, and original observation timestamps.
- Add instance-scoped quota query and observation ports with caller and instance cancellation,
  validated snapshots, sequential observation, and iterator cleanup.
- Extend fake-provider, conformance, generated-schema, and packed-consumer coverage for quota.

### Changed

- Require `accountQuota` on every materialized provider instance. Providers without support must
  explicitly return `{ kind: "unsupported" }` with no handlers.
- Advance validation, protocol, and runtime packages together to `0.2.5`; the validation API and
  public Agent Protocol V8 event version remain unchanged.

See [MIGRATING-TO-0.2.5.md](MIGRATING-TO-0.2.5.md) before upgrading driver implementations.

## 0.2.4 - 2026-09-05

This coordinated patch release preserves Agent Protocol V8 and advances all three packages
together.

### Changed

- Require every runtime operation invocation to provide a caller-owned `observationTurnId` for
  exact session and turn correlation.
- Require providers to await the optional operation `onOutput` observer for each emitted output,
  preserving host admission backpressure before the operation result settles.

### Fixed

- Validate operation-scoped progress, context, compaction, operation, resource, warning, error,
  and diagnostic observations through the same stateful session authority used by turn output.
- Reject mismatched observation identity, undeclared output, invalid lifecycle transitions, and
  output emitted after operation settlement before it can cross the public runtime boundary.

See [MIGRATING-TO-0.2.4.md](MIGRATING-TO-0.2.4.md) for the required operation-call and adapter
changes.

## 0.2.3 - 2026-09-04

This coordinated beta release is published under both the `beta` and `latest` npm tags.

### Added

- Add closed capability and inventory contracts for selectable configuration, typed operations,
  managed content, managed MCP observations, collaboration lifecycles, generated resources, and
  structured image input.
- Add matching provider-session ports for listing and applying configuration, listing and invoking
  operations, observing managed content and integrations, controlling collaboration, and retrieving
  generated resources.
- Add bounded elicitation fields, richer approval choices, provider source evidence, process
  boundaries, context usage and compaction semantics, and neutral resource/artifact correlation.
- Expand the deterministic fake provider and reusable conformance suite across the V8 surface.

### Changed

- Advance every serialized protocol value from Agent Protocol V7 to V8 as a direct hard cut.
- Replace the former `interactionExtensions` booleans with independently constrained,
  discriminated capability domains and strict capability-to-port validation.
- Preserve stream backpressure through terminal or exactly-one-pending-request boundaries and make
  incomplete turns or request continuations render a validated session unusable.
- Require explicit provider-execution-start observation for mutating operations so hosts can
  distinguish definitive pre-delegation failures from uncertain post-start delivery.

### Fixed

- Commit provider execution start only after the host observer succeeds, preserving durable-journal
  failures as pre-delegation errors without poisoning a reusable session.
- Reject stale revisions, conflicting invocation identities, invalid lifecycle transitions,
  unoffered request choices, and capability/result mismatches before they cross the provider SPI.

### Removed

- Remove Agent Protocol V7 parsing and every compatibility reader, alias, or dual-protocol runtime
  surface.
- Remove the generic boolean interaction-extension catalog and provider-native escape-hatch shape.

See [MIGRATING-TO-0.2.3.md](MIGRATING-TO-0.2.3.md) for the coordinated V7-to-V8 upgrade sequence.

## 0.2.2 - 2026-08-31

This coordinated patch release is published under both the `beta` and `latest` npm tags.

### Fixed

- Reject terminal, regressed, or rebound item and plan subjects before an approval can reach a
  waiting boundary or provider delegation, while preserving prior in-progress evidence across an
  `unknown` status update.
- Reset materialization-scoped context usage at an explicit provider process boundary without
  weakening logical-session monotonicity.
- Accept approval prompts up to the protocol's 4,000-character limit across generated and runtime
  validation surfaces.
- Enforce uniqueness and canonical ordering directly in the exported standalone approval
  capability schema.
- Resume partial coordinated releases only when existing packages carry exact provenance from the
  original immutable release tag or its guarded recovery run.

## 0.2.1 - 2026-08-30

This coordinated patch release is published under both the `beta` and `latest` npm tags.

### Fixed

- Preserve cumulative context counters across later usage samples that omit individual fields, so
  a subsequent regression cannot bypass materialization-scoped monotonicity validation.
- Accept the protocol-safe `unknown` compaction trigger when a provider supports compaction while
  continuing to reject unadvertised known triggers and all compaction from unsupported providers.
- Permit neutral cancellation after an approval request expires while continuing to reject expired
  option selections before provider delegation.

## 0.2.0 - 2026-08-29

This coordinated release is published under both the `beta` and `latest` npm tags.

### Added

- Agent Protocol V7 context-usage events with bounded occupancy, measurement scope, optional
  cumulative counters, and compaction pressure.
- Required neutral details for context-compaction items, including bounded trigger, token,
  duration, and summary-preview facts.
- Item-correlated and proposed-plan-correlated approval requests.
- Typed approval choices with exact decision, persistence, and neutral scope semantics.
- Approval capabilities that advertise exact persistence/scope combinations.
- Stateful runtime validation for context monotonicity and post-compaction occupancy changes.
- Refusal-before-delegation validation for stale, expired, mismatched, and unoffered approval
  resolutions.

### Changed

- All serialized protocol values now require `protocolVersion: 7`.
- Approval resolutions select an offered `optionId` or use the explicit canceled disposition.
- The approval capability is now a supported/unsupported discriminated union rather than a
  boolean.
- `AgentCapabilities` now requires the `context.usage` and `context.compaction` capability object.
- `@agen-ai/validation`, `@agen-ai/agent-protocol`, and `@agen-ai/agent-runtime` advance together
  from `0.1.0` to `0.2.0`.

### Removed

- Agent Protocol V6 parsing and compatibility behavior.
- Boolean approval capability declarations and boolean approval decisions.
- Uncorrelated approval subjects.

See [MIGRATING-TO-0.2.md](MIGRATING-TO-0.2.md) for exact replacement examples and rollout order.

## 0.1.0 - 2026-08-03

- Initial public beta release of the validation, protocol, and runtime package family.
