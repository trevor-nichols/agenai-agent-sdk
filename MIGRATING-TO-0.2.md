# Migrating from 0.1.0 to 0.2.0

Version `0.2.0` is a coordinated beta release of all three packages and implements Agent Protocol
V7. It is intentionally incompatible with the V6 wire values in `0.1.0`. Upgrade the validation,
protocol, and runtime packages together; do not mix package versions or add a V6 fallback.

## API change report

| Area | 0.1.0 / V6 | 0.2.0 / V7 |
| --- | --- | --- |
| Protocol discriminator | `protocolVersion: 6` | `protocolVersion: 7` |
| Approval capability | Boolean | `{ kind: "unsupported" }` or exact supported modes |
| Approval subject | Descriptive subject | Live `itemId` or exact proposed-plan `artifactId` |
| Approval choices | Implicit allow/deny | Bounded typed `options` with stable `optionId` |
| Approval resolution | Boolean decision | Selected offered `optionId` or canceled disposition |
| Context capability | Absent | Required usage and compaction discriminants |
| Context usage | Absent | `context.usage.updated` with bounded neutral facts |
| Compaction item | No semantic details | Required bounded neutral `details` |
| Runtime validation | Structural request matching | Stateful correlation, expiry, option, and usage ordering |

The ordinary public entrypoints remain validator-neutral. The explicit `/zod` entrypoints remain
the only surfaces that expose Zod, and `/json-schema` continues to publish deterministic Draft
2020-12 artifacts.

## Capability replacement

Replace the V6 boolean approval declaration and add the required context declarations:

```ts
const capabilities = parseAgentCapabilities({
  protocolVersion: 7,
  // Other technical capabilities are unchanged here.
  requests: {
    approval: {
      kind: "supported",
      modes: [
        { persistence: "once", scopeKinds: ["exact_action"] },
      ],
    },
    elicitation: { kind: "unsupported" },
  },
  context: {
    usage: {
      kind: "supported",
      measurementScopes: ["materialization"],
      cumulativeFields: ["inputTokens", "outputTokens", "turns"],
    },
    compaction: {
      kind: "supported",
      triggers: ["automatic", "manual"],
      sameSessionContinuation: true,
    },
  },
});
```

Advertise only combinations the adapter can actually emit. If either feature is unavailable, use
its exact `{ kind: "unsupported" }` discriminant.

## Approval replacement

An approval request must identify the live item it gates (or the exact proposed-plan artifact) and
must enumerate every selectable outcome:

```ts
const request = parseAgentApprovalRequest({
  requestKind: "approval",
  requestId: "request:deploy",
  prompt: "Run this exact deployment command?",
  subject: {
    kind: "command",
    title: "Deploy the service",
    itemId: "item:deploy-command",
  },
  options: [
    {
      optionId: "approval:allow-once",
      label: "Allow once",
      decision: "approved",
      persistence: "once",
      scope: { kind: "exact_action" },
    },
    {
      optionId: "approval:deny-once",
      label: "Deny",
      decision: "denied",
      persistence: "once",
      scope: { kind: "exact_action" },
    },
  ],
});

const resolution = parseAgentRequestResolutionFor(request, {
  requestKind: "approval",
  requestId: request.requestId,
  disposition: "selected",
  optionId: request.options[0].optionId,
});
```

The validated runtime rejects a mismatched request, expired request, or unoffered option before it
calls the provider continuation port. Do not translate a provider-native persistent rule into a
broader neutral scope than the advertised option describes.

## Context and compaction ordering

Emit `context.usage.updated` only for advertised scopes and cumulative fields. Cumulative counters
cannot decrease. Occupancy may decrease only after a completed `context_compaction` item, and the
first accepted sample after that completion consumes the decrease allowance. Do not emit identical
consecutive samples or any sample after `turn.completed`.

Compaction details contain neutral bounded facts only. Provider summaries, raw prompts, costs,
provider rule matchers, and native envelopes do not belong in protocol events.

## Upgrade sequence

1. Update all three package dependencies to `0.2.0` in one change.
2. Replace V6 capability and approval shapes and add explicit context capability declarations.
3. Emit V7 events and correlate approvals to the observed item or proposed plan before opening the
   request.
4. Resolve approvals with an offered option ID.
5. Run the provider conformance suite and all application tests.
6. Deploy producers and consumers as one coordinated cut. Do not retain a V6 reader or dual writer.

If a host persists protocol values, its persistence migration and retained-history policy are host
concerns outside this public SDK. The public protocol does not authorize rewriting historical data.
