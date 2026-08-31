# Changelog

All notable changes to the coordinated AgenAI Agent SDK package set are recorded here. The three
packages always ship together at one version during beta.

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
