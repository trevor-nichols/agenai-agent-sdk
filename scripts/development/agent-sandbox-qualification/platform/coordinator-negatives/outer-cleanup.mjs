import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { failure } from '../coordinator/evidence.mjs';

export async function finishOuter({ proxy, observer, observerEntered, observerFallback, socketPath, report }) {
  assert(!report.originalChildEntered || report.originalGenerationClosed,
    'The original generation must acknowledge clean close before its observer/proxy can retire.');
  // idle() joins entered forwarding before reporting sticky capture failures.
  if (proxy) {
    try { await proxy.idle(); }
    catch (error) { report.evidenceFailures.push(failure(error)); }
  }
  if (observer) {
    report.kernelCleanup = await observer.assertAllEmpty();
    await observer.close();
    assert.equal(observer.record.observerRemoved, true);
  } else if (observerEntered) await observerFallback();
  if (proxy) {
    try { await proxy.close(); }
    catch (error) {
      // This exact public error occurs after close has joined work and removed its original socket.
      assert(error instanceof AggregateError && error.message === 'Trace forwarding work failed.',
        'Proxy close did not confirm physical retirement; retain its original owner.');
      await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
      const capacity = proxy.capacity();
      assert.equal(capacity.connections.current, 0); assert.equal(capacity.requests.current, 0);
      assert.equal(capacity.pendingRequests.current, 0); assert.equal(capacity.pendingRequests.retiring, 0);
      report.evidenceFailures.push(failure(error));
    }
  }
  report.cleanupComplete = true;
}
