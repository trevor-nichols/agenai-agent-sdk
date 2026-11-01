import assert from 'node:assert/strict';

// A selected cut names the supervisor requests the worker still awaited. The supervisor binds exactly those
// observations, because the frozen worker's coordinator can no longer drive their native observer controls.
const cutKinds = new Set(['crash', 'lost_ack', 'lease_expiry']);

export function suspendWithOutstanding(report, outstanding, cut) {
  report.outstandingAtCut = outstanding;
  try { return cut(); }
  catch (error) {
    // A cut that never wrote its handoff suspended nothing, so it keeps no outstanding record.
    if (!report.handoff) delete report.outstandingAtCut;
    throw error;
  }
}

export function outstandingAtCut(selected, cutReport) {
  assert(cutKinds.has(selected.kind), 'Only a selected cut row may bind outstanding observations.');
  return cutReport.outstandingAtCut;
}
