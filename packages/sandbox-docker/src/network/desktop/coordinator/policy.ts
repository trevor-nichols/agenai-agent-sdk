import { coordinatorDigest, COORDINATOR_JOURNAL_LIMITS } from './journal/schema.js';

export const DESKTOP_COORDINATOR_PROTOCOL = 'agenai.desktop-coordinator.v1';
export const DESKTOP_COORDINATOR_POLICY = Object.freeze({
  revision: 'desktop-coordination-v1', projection: 'desktop-member-projection-v1',
  pool: '10.240.0.0/24', prefixLength: 28, candidates: 16,
  heartbeatMs: 1_000, leaseTimeoutMs: 60_000, pollIntervalMs: 1_000,
  commandTimeoutMs: 5_000, observationTimeoutMs: 10_000,
  transitionTimeoutMs: 30_000, authorityFreshnessMs: 45_000,
  observationBytes: 16 * 1024 ** 2, rawBracketBytes: 24 * 1024 ** 2,
  normalizedObservations: 2, journal: COORDINATOR_JOURNAL_LIMITS,
});

export const DESKTOP_COORDINATOR_POLICY_DIGEST = coordinatorDigest(
  'agenai.desktop-coordinator.policy.v1', JSON.stringify(DESKTOP_COORDINATOR_POLICY),
);
