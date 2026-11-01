import assert from 'node:assert/strict';
import { failure } from '../../coordinator/evidence.mjs';

// Worker requests settle in arrival order, except those sent from inside an entered coordinator effect. Their
// receipts sit on the SDK's critical path, while an ordered request can wait for an observation that needs that
// same effect to settle. Checkpoints are therefore recorded and answered on arrival; effect phases are answered on
// arrival and recorded in order. Each ordered request still sees exactly the member checkpoints received before it.
export function createWorkerRequests({ maximumMessages, members, recordCheckpoint, handle, reply, fail }) {
  let ordered = Promise.resolve(), count = 0;
  const admitted = (message) => {
    assert(message && Number.isSafeInteger(message.id) && ++count <= maximumMessages,
      'Original worker control protocol exceeded its bounded request census.');
  };
  return {
    get count() { return count; },
    // The IPC listener must never throw: an uncaught exception would end the supervisor that owns cleanup.
    receive(message) {
      try {
        admitted(message);
        if (message.kind === 'checkpoint') {
          let outcome = { value: undefined };
          try { recordCheckpoint(message.value); } catch (error) { fail(error); outcome = { failure: failure(error) }; }
          reply(message.id, outcome);
          return;
        }
        const snapshot = { ...members() }, acknowledged = message.kind === 'effect_phase';
        // An effect phase is recorded after its receipt, so its detail states that bound.
        const value = acknowledged ? { ...message.value, acknowledged: { requestId: message.id, at: new Date().toISOString() } } : message.value;
        ordered = ordered.then(async () => {
          let outcome;
          try { outcome = { value: await handle(message.kind, value, snapshot, message.id) }; }
          catch (error) { fail(error); outcome = { failure: failure(error) }; }
          if (!acknowledged) reply(message.id, outcome);
        }).catch(fail);
        if (acknowledged) reply(message.id, { value: undefined });
      } catch (error) { fail(error); }
    },
    enqueue(task) { ordered = ordered.then(task).catch(fail); },
    settled() { return ordered; },
  };
}
