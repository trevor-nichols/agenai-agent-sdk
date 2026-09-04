# Changelog

All notable changes to the coordinated AgenAI Agent SDK package set are recorded here. The three
packages always ship together at one version during beta.

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
