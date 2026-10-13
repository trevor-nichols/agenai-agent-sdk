import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcpProviderDriver, type AcpHostAuthenticationTerminalLease, type AcpHostTerminalLease, type AcpHostUrlInteractionLease } from '../src/index.js';
import { createHostPeer, fixtureDeferred, hostDefinition, hostProviderKey, hostSessionContext } from './node-fixtures/host-peer.js';

for (const facility of ['terminal', 'url', 'authentication'] as const) {
  test(`${facility} retains pending acquisition and failed late cleanup until disposal succeeds`, { timeout: 3_000 }, async (t) => {
    const peer = createHostPeer({ protocolVersion: 1, authMethods: [
      { id: 'browser', name: 'Browser' }, { type: 'terminal', id: 'login', name: 'Login' },
    ] });
    peer.handle((frame) => frame.method === 'authenticate');
    const entered = fixtureDeferred<AbortSignal>();
    const delivered = fixtureDeferred<AcpHostTerminalLease & AcpHostUrlInteractionLease & AcpHostAuthenticationTerminalLease>();
    let failRelease = true;
    let releases = 0;
    let acquisitions = 0;
    const lease = {
      decision: new Promise<'accept'>(() => {}), exited: new Promise<{ exitCode: number }>(() => {}),
      output: () => ({ output: '', truncated: false }), waitForExit: () => new Promise<{ exitCode: number }>(() => {}), kill() {},
      release() { releases += 1; if (failRelease) throw new Error('temporary host cleanup failure'); },
    };
    const acquire = (input: { readonly signal: AbortSignal }) => {
      acquisitions += 1; entered.resolve(input.signal); return delivered.promise;
    };
    const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease,
      limits: { hostOperationTimeoutMs: 30, authenticationTimeoutMs: 60, maxHostTerminals: 1 },
      authentication: { browser: { methodId: 'browser' }, terminal: { methodId: 'login' } },
      host: { createTerminal: acquire, url: acquire, authenticateInTerminal: acquire },
    }).materialize(hostDefinition);
    t.after(async () => { failRelease = false; delivered.resolve(lease); await instance.dispose(); peer.destroy(); });
    if (facility === 'terminal') {
      await instance.adapter.createSession(hostSessionContext());
      void peer.request('terminal/create', { sessionId: 'native-session', command: '/approved/tool' });
    } else {
      assert.equal(instance.adapter.authentication.kind, 'supported');
      if (instance.adapter.authentication.kind !== 'supported') return;
      const progress = instance.adapter.authentication.start({ attemptId: 'auth:late', flow: facility === 'url' ? 'browser' : 'terminal' })[Symbol.asyncIterator]();
      await progress.next();
      t.after(async () => { await progress.return?.(); });
      if (facility === 'url') {
        const request = await peer.wait((frame) => frame.method === 'authenticate');
        void peer.request('elicitation/create', { requestId: request.id!, mode: 'url', message: 'Authorize',
          elicitationId: 'late-url', url: 'https://login.example.invalid/' });
      }
    }
    const signal = await entered.promise;
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    if (facility === 'terminal') {
      assert.ok((await peer.request('terminal/create', { sessionId: 'native-session', command: '/approved/tool' })).error);
      assert.equal(acquisitions, 1, 'an unsettled acquisition must continue to consume capacity');
    }
    await assert.rejects(async () => instance.dispose(), AggregateError, 'pending acquisition cannot be reported as disposed');
    delivered.resolve(lease);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(releases >= 1, 'late delivery must initiate cleanup');
    await assert.rejects(async () => instance.dispose(), AggregateError, 'unsuccessful cleanup must remain owned');
    const failedAttempts = releases;
    failRelease = false;
    await instance.dispose();
    assert.equal(releases, failedAttempts + 1);
    await instance.dispose();
    assert.equal(releases, failedAttempts + 1, 'successful disposal must be idempotent');
  });
}
