// A case's execution result applies only to that case/platform/order. These owners keep
// source contracts, installed negatives and separately selected native regressions distinct.
export const concurrencyProofOwners = Object.freeze({
  L06: Object.freeze({ source: ['packages/ai/sandbox-docker/tests/desktop-coordinator-effects.test.ts',
    'packages/ai/sandbox-docker/tests/desktop-coordinator-projection.test.ts'],
  installed: ['scripts/development/agent-sandbox-qualification/platform/coordinator-lifecycle.mjs'],
  native: ['joint-ab', 'joint-ba', 'staged-ab', 'staged-ba'],
  limitation: 'The public workflow overlaps a registered member effect with original peer work; complete caller/exclusion negatives remain the named source and installed owners.' }),
  D04: Object.freeze({ native: ['foreign-endpoint', 'foreign-network-sdk-labels'],
    additionalNativeRow: 'restricted-https',
    limitation: 'Bridge/IPAM, host/socket/proxy drift and replaced identities require their separately selected restricted-https/native rows and source adversarial schedules; the two concurrency mutations do not imply those results.' }),
  D05: Object.freeze({ native: ['control-loss-filesystem', 'control-loss-route_observer', 'control-loss-egress_broker',
    'control-loss-egress_relay', 'lease-expiry-two-active'], additionalNativeRow: 'restricted-https',
  limitation: 'Malformed/overflowing observations and host/socket/proxy replacement remain distinct decoder/control and restricted-https owner proofs.' }),
  F03: Object.freeze({ native: ['persist-creating', 'persist-identified', 'persist-running', 'persist-destroyed'],
    limitation: 'Caller checkpoint rejection is the native row. Canonical publication and member/queue/tombstone/journal/observation exhaustion belong to exact SDK source/installed boundary proofs; no native exhaustion result is implied.' }),
  F07: Object.freeze({ installed: ['scripts/development/agent-sandbox-qualification/platform/coordinator-lifecycle.mjs'],
    source: ['packages/ai/sandbox-docker/tests/desktop-coordinator-recovery.test.ts'],
    additionalNativeTool: 'scripts/development/agent-sandbox-qualification/platform/coordinator-recovery/controller.mjs',
    limitation: 'Fresh original-generation cleanup does not establish rejection of all changed Engine/configuration/profile/generation/path, missing checkpoints or same-name replacements. Each negative needs its named owner result and selected native conflict evidence.' }),
});
