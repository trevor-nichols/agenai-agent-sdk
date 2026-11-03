import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerDesktopRecoveryError } from '../src/node/desktopRecovery/contracts.js';
import type { DockerDesktopRecoveryController, DockerDesktopRecoveryControllerOptions, DockerDesktopRecoveryFailure } from '../src/node/desktopRecovery/contracts.js';
import { createDockerDesktopRecoveryController } from '../src/node/desktopRecovery/controller.js';
import { createDockerDesktopRouteAuthority } from '../src/node/desktopRouteAuthority.js';
import { parseRecoveryCanonical } from '../src/network/desktop/coordinator/administrativeRecovery/publication.js';
import { desktopRecoveryControllerFixture } from './fixtures/desktopRecoveryController.js';
import type { RecoveryControllerFault } from './fixtures/desktopRecoveryController.js';
import { desktopRouteAuthorityOptions } from './fixtures/desktopRouteAuthority.js';

const nativeProfileSkip = process.platform === 'darwin' && process.arch === 'arm64' ? false
  : 'Scripted public Desktop recovery campaign requires a Darwin arm64 controller.';

function snapshotState(owner: DockerDesktopRecoveryController) { return owner.state; }

function failure(owner: DockerDesktopRecoveryController, expected?: DockerDesktopRecoveryFailure) {
  return (cause: unknown) => {
    assert(cause instanceof DockerDesktopRecoveryError);
    assert.equal(cause.owner, owner);
    if (expected !== undefined) assert.deepEqual(cause.failure, expected);
    return true;
  };
}

test('public recovery construction is portable and inert, rejects proof inputs, and refuses unsupported hosts before native or Engine entry', async () => {
  const descriptor = desktopRouteAuthorityOptions('desktop-apple-virtualization-native-arm64');
  descriptor.pollIntervalMs = 1000; descriptor.commandTimeoutMs = 5000;
  descriptor.vmObserver.control.heartbeatMs = 1000; descriptor.vmObserver.control.leaseTimeoutMs = 60_000;
  const options: DockerDesktopRecoveryControllerOptions = {
    original: { routeAuthority: createDockerDesktopRouteAuthority(descriptor), helper: { protocol: 'agenai.desktop-coordinator.v1',
      sourceDigest: `sha256:${'1'.repeat(64)}`, executable: { path: '/nonexistent/agenai-original-holder', sha256: '2'.repeat(64) } } },
    helper: { protocol: 'agenai.desktop-recovery-observer.v1', sourceDigest: `sha256:${'3'.repeat(64)}`,
      executable: { path: '/nonexistent/agenai-recovery-holder', sha256: '4'.repeat(64) } },
    desktop: { profile: 'stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1', applicationPath: '/Applications/Docker.app' },
  };
  const owner = createDockerDesktopRecoveryController(options);
  assert.deepEqual(snapshotState(owner), { kind: 'inert' }); assert.equal(owner.members.length, 0);
  assert.throws(() => Reflect.apply(createDockerDesktopRecoveryController, undefined, [{ ...options, proof: { safe: true } }]), TypeError);
  assert.throws(() => Reflect.apply(owner.open, {}, [{ expectedGeneration: '11111111-1111-4111-8111-111111111111' }]), TypeError);
  assert.throws(() => owner.open({ expectedGeneration: 'invalid' }), failure(owner, { kind: 'invalid_input' }));
  if (nativeProfileSkip !== false) {
    await assert.rejects(owner.open({ expectedGeneration: '11111111-1111-4111-8111-111111111111' }),
      failure(owner, { kind: 'unsupported', reason: 'profile' }));
    assert.equal(owner.members.length, 0);
  }
});

async function destroyOriginal(owner: DockerDesktopRecoveryController,
  fixture: Awaited<ReturnType<typeof desktopRecoveryControllerFixture>>) {
  const record = owner.members[0]; assert(record);
  const result = await owner.reconcile({ configuration: fixture.configuration, record });
  assert(result.kind === 'matched' || result.kind === 'uncertain');
  await result.owner.destroy();
  assert.equal(owner.members[0]?.phase, 'destroyed');
  return result.owner;
}

for (const second of [false, true]) {
  test(`public ${second ? 'second ' : ''}helper succession preserves its old history and resumes the next attempt with the current issuer`,
    { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
      const fixture = await desktopRecoveryControllerFixture();
      const previous = await (second ? fixture.seedTwoPreviousHelpers() : fixture.seedPreviousHelper());
      const priorArms = (await fixture.events()).filter((event) => event.command === 'ARM').length;
      const nextAttempt = second ? 5 : 2;
      const first = fixture.createOwner(); let owner = first;
      try {
        await fixture.fault('pause_helper_adoption');
        const expected = { ...previous.helper, executable: { ...previous.helper.executable } };
        const opening = first.open({ expectedGeneration: fixture.generation, replaceHelper: { expected } });
        expected.executable.path += '.caller-mutation';
        await fixture.waitFor('PAUSED');
        assert.throws(() => first.open({ expectedGeneration: fixture.generation, replaceHelper: { expected } }),
          failure(first, { kind: 'identity_conflict', scope: 'configuration' }));
        const joining = first.open({ expectedGeneration: fixture.generation });
        await fixture.release(); await Promise.all([opening, joining]);
        const adopted = parseRecoveryCanonical(await fixture.currentText());
        if (second) {
          if (adopted.format !== 'agenai.docker-desktop-recovery.v3') assert.fail('Second helper succession did not publish v3.');
          assert.deepEqual(adopted.previousIssuers.map((issuer) => issuer.throughAttempt), [2, 4]);
          assert.deepEqual(adopted.previousIssuers[1].helper, previous.helper);
        } else {
          if (adopted.format !== 'agenai.docker-desktop-recovery.v2') assert.fail('First helper succession did not publish v2.');
          assert.equal(adopted.previousIssuer.throughAttempt, 1);
        }
        assert.deepEqual(adopted.origin, previous.envelope.origin);
        assert.deepEqual(adopted.preparation, previous.envelope.preparation);
        assert.deepEqual(adopted.historyHead, previous.envelope.historyHead);
        assert.deepEqual(adopted.projection.snapshot.generation.kind === 'dirty' ? adopted.projection.snapshot.generation.members : null,
          previous.envelope.projection.snapshot.generation.kind === 'dirty' ? previous.envelope.projection.snapshot.generation.members : null);
        assert.deepEqual(adopted.activeHelper, fixture.options.helper);
        assert.equal(adopted.nextAttempt, nextAttempt);
        assert.equal((await fixture.events()).filter((event) => event.command === 'ARM').length, priorArms);
        await first.release();
        owner = fixture.createOwner();
        await owner.open({ expectedGeneration: fixture.generation });
        await owner.beginObservation();
        assert.deepEqual(snapshotState(owner), { kind: 'observing', generation: fixture.generation, attempt: nextAttempt, phase: 'armed' });
        await fixture.simulateStop(); await owner.observeStopped(); await fixture.simulateStart(); await owner.finishObservation();
        await destroyOriginal(owner, fixture); await owner.close();
        assert.deepEqual(snapshotState(owner), { kind: 'closed', generation: fixture.generation, result: 'clean' });
        fixture.setOffline(true);
        const cleanText = await fixture.currentText();
        const requests = fixture.source.requests.length;
        const fresh = fixture.createOwner();
        try {
          await fresh.open({ expectedGeneration: fixture.generation, replaceHelper: { expected: previous.helper } });
          assert.deepEqual(snapshotState(fresh), { kind: 'closed', generation: fixture.generation, result: 'clean' });
          assert.equal(fresh.members[0]?.phase, 'destroyed');
          await fresh.close();
          await fresh.open({ expectedGeneration: fixture.generation, replaceHelper: { expected: previous.helper } });
          const wrong = fixture.createOwner();
          try {
            await assert.rejects(wrong.open({ expectedGeneration: fixture.generation, replaceHelper: {
              expected: { ...previous.helper, executable: { ...previous.helper.executable, sha256: '9'.repeat(64) } },
            } }), failure(wrong, { kind: 'identity_conflict', scope: 'configuration' }));
          } finally { await wrong.release({ timeoutMs: 1000 }).catch(() => {}); }
          assert.equal(await fixture.currentText(), cleanText);
          assert.equal(fixture.source.requests.length, requests, 'Clean helper-succession acknowledgement remains offline.');
        } finally { await fresh.release({ timeoutMs: 1000 }).catch(() => {}); }
      } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await first.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });
}

test('public helper succession refuses omitted or wrong predecessor intent without changing its original recovery envelope',
  { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
    for (const second of [false, true]) {
      const fixture = await desktopRecoveryControllerFixture();
      const previous = await (second ? fixture.seedTwoPreviousHelpers() : fixture.seedPreviousHelper());
      try {
        for (const expected of [undefined, { ...previous.helper, executable: { ...previous.helper.executable, sha256: '9'.repeat(64) } }]) {
          const owner = fixture.createOwner();
          try {
            await assert.rejects(owner.open({ expectedGeneration: fixture.generation,
              ...(expected ? { replaceHelper: { expected } } : {}) }), failure(owner, { kind: 'identity_conflict', scope: 'configuration' }));
            await owner.release();
            assert.equal(await fixture.currentText(), previous.text);
          } finally { await owner.release({ timeoutMs: 1000 }).catch(() => {}); }
        }
        assert.equal(fixture.source.effects.length, 0);
      } finally { await fixture.close(); }
    }
  });

for (const retained of ['hidden_barrier', 'queued_delete'] as const) {
  test(`public second helper succession refuses ${retained} before conversion or cleanup`,
    { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
      const fixture = await desktopRecoveryControllerFixture();
      const previous = await fixture.seedTwoPreviousHelpers(retained === 'hidden_barrier');
      const before = retained === 'queued_delete' ? await fixture.queueOriginalDelete() : previous.text;
      const arms = (await fixture.events()).filter((event) => event.command === 'ARM').length;
      const owner = fixture.createOwner();
      try {
        await assert.rejects(owner.open({ expectedGeneration: fixture.generation, replaceHelper: { expected: previous.helper } }), (cause) => {
          failure(owner)(cause);
          if (retained === 'hidden_barrier') {
            assert(cause instanceof Error && cause.cause instanceof Error);
            assert.match(cause.cause.message, /completed preferred barrier acceptance/u);
          }
          return true;
        });
        await owner.release();
        assert.equal(await fixture.currentText(), before);
        assert.equal(fixture.source.effects.length, 0);
        assert.equal((await fixture.events()).filter((event) => event.command === 'ARM').length, arms);
      } finally { await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
    });
}

test('replacement intent still refuses an ordinary dirty v1 generation and a clean v1 recovery transaction',
  { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture();
    const ordinary = fixture.createOwner(); const unexpected = fixture.createOwner();
    try {
      const intent = { expectedGeneration: fixture.generation, replaceHelper: { expected: fixture.options.helper } };
      const dirtyText = await fixture.currentText();
      await assert.rejects(unexpected.open(intent), failure(unexpected, { kind: 'unsupported', reason: 'original_format' }));
      await unexpected.release();
      assert.equal(await fixture.currentText(), dirtyText);
      await ordinary.open({ expectedGeneration: fixture.generation });
      await destroyOriginal(ordinary, fixture); await ordinary.close();
      fixture.setOffline(true);
      const cleanText = await fixture.currentText();
      const requests = fixture.source.requests.length;
      const fresh = fixture.createOwner();
      try {
        await assert.rejects(fresh.open(intent), failure(fresh, { kind: 'unsupported', reason: 'original_format' }));
      } finally { await fresh.release({ timeoutMs: 1000 }).catch(() => {}); }
      assert.equal(await fixture.currentText(), cleanText);
      assert.equal(fixture.source.requests.length, requests);
    } finally { await ordinary.release({ timeoutMs: 1000 }).catch(() => {}); await unexpected.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

test('public helper succession verifies the exact original archive before publishing its successor',
  { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
    for (const second of [false, true]) {
      const fixture = await desktopRecoveryControllerFixture();
      const previous = await (second ? fixture.seedTwoPreviousHelpers() : fixture.seedPreviousHelper());
      const owner = fixture.createOwner();
      try {
        await fixture.fault('corrupt_origin_archive');
        await assert.rejects(owner.open({ expectedGeneration: fixture.generation, replaceHelper: { expected: previous.helper } }), failure(owner));
        assert.equal(await fixture.currentText(), previous.text);
        assert.equal(fixture.source.effects.length, 0);
      } finally { await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
    }
  });

for (const second of [false, true]) {
  for (const fault of ['before_helper_adoption_commit', 'after_helper_adoption_commit'] satisfies RecoveryControllerFault[]) {
    test(`public ${second ? 'second ' : ''}helper succession rejoins exact CAS after ${fault}`,
      { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
        const fixture = await desktopRecoveryControllerFixture(fault);
        const previous = await (second ? fixture.seedTwoPreviousHelpers() : fixture.seedPreviousHelper());
        const priorArms = (await fixture.events()).filter((event) => event.command === 'ARM').length;
        const original = fixture.createOwner(); let owner = original;
        try {
          const intent = { expectedGeneration: fixture.generation, replaceHelper: { expected: previous.helper } };
          await assert.rejects(original.open(intent), failure(original));
          if (fault === 'before_helper_adoption_commit') assert.equal(await fixture.currentText(), previous.text);
          else { await fixture.kill(); owner = fixture.createOwner(); }
          await owner.open(intent);
          const current = parseRecoveryCanonical(await fixture.currentText());
          if (second) {
            if (current.format !== 'agenai.docker-desktop-recovery.v3') assert.fail('Second succession did not rejoin its exact v3 CAS.');
            assert.deepEqual(current.previousIssuers.map((issuer) => issuer.throughAttempt), [2, 4]);
          } else {
            if (current.format !== 'agenai.docker-desktop-recovery.v2') assert.fail('First succession did not rejoin its exact v2 CAS.');
            assert.equal(current.previousIssuer.throughAttempt, 1);
          }
          assert.equal(current.nextAttempt, second ? 5 : 2);
          assert.deepEqual(current.historyHead, previous.envelope.historyHead);
          assert.deepEqual(current.preparation, previous.envelope.preparation);
          assert.equal((await fixture.events()).filter((event) => event.command === 'ARM').length, priorArms);
        } finally { await owner.release({ timeoutMs: 1000 }).catch(() => {}); if (owner !== original) await original.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
      });
  }
}

test('public release reports a native opening exit once and then acknowledges its joined cleanup without changing canonical state',
  { skip: nativeProfileSkip, timeout: 30_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture('before_open_response');
    const owner = fixture.createOwner();
    try {
      const originalText = await fixture.currentText();
      const requests = fixture.source.requests.length;
      await assert.rejects(owner.open({ expectedGeneration: fixture.generation }),
        failure(owner, { kind: 'authority_lost', source: 'native_holder' }));
      await assert.rejects(owner.release(), failure(owner, { kind: 'authority_lost', source: 'native_holder' }));
      await owner.release();
      assert.deepEqual(snapshotState(owner), { kind: 'released', generation: fixture.generation, result: 'retained' });
      await owner.release();
      assert.equal(await fixture.currentText(), originalText);
      assert.equal(fixture.source.requests.length, requests);
      assert.deepEqual((await fixture.events()).map((event) => event.command), ['OPEN']);
      assert.equal(fixture.source.effects.length, 0);
    } finally { await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

test('public recovery retains the exact instance facade and closes an original zero-attempt generation through real immutable SDK slots',
  { skip: nativeProfileSkip, timeout: 30_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture();
    const owner = fixture.createOwner();
    try {
      assert.deepEqual(snapshotState(owner), { kind: 'inert' }); assert.equal(owner.members.length, 0);
      const open = owner.open;
      assert.throws(() => Reflect.apply(open, {}, [{ expectedGeneration: fixture.generation }]), TypeError);
      const stateGetter = Object.getOwnPropertyDescriptor(owner, 'state')?.get; assert(stateGetter);
      assert.throws(() => Reflect.apply(stateGetter, {}, []), TypeError);
      assert.deepEqual(await fixture.events(), []);
      await owner.open({ expectedGeneration: fixture.generation });
      assert.equal(snapshotState(owner).kind, 'ready');
      assert.equal(owner.members[0]?.operationId, fixture.record.operationId);
      await destroyOriginal(owner, fixture);
      await owner.close();
      assert.deepEqual(snapshotState(owner), { kind: 'closed', generation: fixture.generation, result: 'clean' });
      assert.equal(owner.members[0]?.phase, 'destroyed');
      const canonical = parseRecoveryCanonical(await fixture.currentText());
      assert.equal(canonical.format, 'agenai.docker-desktop-coordinator.v1');
      assert.equal(canonical.generation.kind, 'clean');
      assert.equal(fixture.source.effects.length, 0);
      const commands = (await fixture.events()).map((event) => event.command);
      assert(!commands.includes('ARM')); assert(!commands.includes('BIND'));
      assert(commands.includes('SDK_DECISION')); assert(commands.includes('ARCHIVE'));
      assert.equal(commands.at(-1), 'EXIT');
    } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

for (const continuation of ['same_owner', 'fresh_owner'] as const) {
  test(`public recovery resumes its complete origin binding after interrupted envelope conversion through ${continuation}`,
    { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
      const fixture = await desktopRecoveryControllerFixture('before_conversion_commit');
      const original = fixture.createOwner();
      let owner = original;
      try {
        const originalText = await fixture.currentText();
        await assert.rejects(original.open({ expectedGeneration: fixture.generation }), failure(original));
        assert.equal(await fixture.currentText(), originalText);
        assert.equal(fixture.source.effects.length, 0);
        if (continuation === 'fresh_owner') { await fixture.kill(); owner = fixture.createOwner(); }
        await owner.open({ expectedGeneration: fixture.generation });
        const current = parseRecoveryCanonical(await fixture.currentText());
        assert.equal(current.format, 'agenai.docker-desktop-recovery.v1');
        if (current.format !== 'agenai.docker-desktop-recovery.v1') assert.fail('Original recovery conversion did not settle.');
        assert.equal(Buffer.from(current.origin.payloadBase64, 'base64').toString('utf8'), originalText);
        assert.deepEqual(owner.members, [fixture.record]);
        await destroyOriginal(owner, fixture);
        await owner.close();
        assert.deepEqual(snapshotState(owner), { kind: 'closed', generation: fixture.generation, result: 'clean' });
        assert.equal(fixture.source.effects.length, 0);
      } finally {
        await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {});
        if (owner !== original) await original.release({ timeoutMs: 1000 }).catch(() => {});
        await fixture.close();
      }
    });
}

for (const fault of ['before_bind_attempt', 'after_outcome_fact'] satisfies RecoveryControllerFault[]) {
  test(`fresh public recovery retries interrupted observation initialization after ${fault}`,
    { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
      const fixture = await desktopRecoveryControllerFixture();
      const original = fixture.createOwner(); const recovered = fixture.createOwner();
      try {
        await original.open({ expectedGeneration: fixture.generation }); await original.beginObservation();
        await fixture.kill(); await fixture.fault(fault);
        await assert.rejects(recovered.open({ expectedGeneration: fixture.generation }), failure(recovered));
        await recovered.open({ expectedGeneration: fixture.generation });
        assert.deepEqual(snapshotState(recovered), { kind: 'ready', generation: fixture.generation, barrier: 'required' });
        const current = parseRecoveryCanonical(await fixture.currentText());
        if (current.format !== 'agenai.docker-desktop-recovery.v1') assert.fail('Interrupted recovery lost its original transaction.');
        assert.equal(current.nextAttempt, 2); assert.equal(current.historyHead?.slot, 'outcome');
        assert.deepEqual(recovered.members, [fixture.record]);
        assert.equal((await fixture.events()).filter((event) => event.command === 'ARM').length, 1,
          'Fresh recovery must retire the interrupted observation without recreating producer watches.');
        await destroyOriginal(recovered, fixture); await recovered.close();
        assert.equal(snapshotState(recovered).kind, 'closed'); assert.equal(fixture.source.effects.length, 0);
      } finally {
        await fixture.release(); await recovered.release({ timeoutMs: 1000 }).catch(() => {});
        await original.release({ timeoutMs: 1000 }).catch(() => {});
        await fixture.kill().catch(() => {}); await fixture.close();
      }
    });
}

for (const fault of ['before_terminal_commit', 'after_clean_commit'] satisfies RecoveryControllerFault[]) {
  test(`fresh public recovery completes ${fault} offline from the exact durable original evidence`, { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture(fault);
    const original = fixture.createOwner();
    let recovered: DockerDesktopRecoveryController | undefined;
    try {
      await original.open({ expectedGeneration: fixture.generation });
      await destroyOriginal(original, fixture);
      await assert.rejects(original.close(), failure(original));
      const before = parseRecoveryCanonical(await fixture.currentText());
      if (fault === 'before_terminal_commit') {
        assert.equal(before.format, 'agenai.docker-desktop-recovery.v1');
        if (before.format === 'agenai.docker-desktop-recovery.v1') assert.notEqual(before.phase.kind, 'terminal_ready');
      } else assert.equal(before.format, 'agenai.docker-desktop-coordinator.v1');
      await fixture.kill();
      const requests = fixture.source.requests.length;
      fixture.setOffline(true);
      recovered = fixture.createOwner();
      await recovered.open({ expectedGeneration: fixture.generation });
      assert.deepEqual(snapshotState(recovered), { kind: 'closed', generation: fixture.generation, result: 'clean' });
      assert.equal(recovered.members[0]?.phase, 'destroyed');
      assert.equal(fixture.source.requests.length, requests, 'Complete durable evidence must finish without any current Docker GET.');
      const clean = parseRecoveryCanonical(await fixture.currentText());
      assert.equal(clean.format, 'agenai.docker-desktop-coordinator.v1');
      assert.equal(clean.generation.kind, 'clean');
      assert.equal(fixture.source.effects.length, 0);
    } finally {
      await fixture.release(); await recovered?.release({ timeoutMs: 1000 }).catch(() => {});
      await original.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close();
    }
  });
}

test('the same public owner reopens a durably published terminal manifest after its acknowledgement was lost and completes offline',
  { skip: nativeProfileSkip, timeout: 35_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture('after_terminal_manifest');
    const owner = fixture.createOwner();
    try {
      await owner.open({ expectedGeneration: fixture.generation }); await destroyOriginal(owner, fixture);
      await assert.rejects(owner.close(), failure(owner));
      const terminal = parseRecoveryCanonical(await fixture.currentText());
      assert.equal(terminal.format, 'agenai.docker-desktop-recovery.v1');
      if (terminal.format === 'agenai.docker-desktop-recovery.v1') assert.equal(terminal.phase.kind, 'terminal_ready');
      const requests = fixture.source.requests.length;
      const opened = (await fixture.events()).filter((event) => event.command === 'OPEN').length;
      fixture.setOffline(true);
      await owner.open({ expectedGeneration: fixture.generation });
      assert.equal(snapshotState(owner).kind, 'closed'); assert.equal(owner.members[0]?.phase, 'destroyed');
      assert.equal(fixture.source.requests.length, requests);
      assert.equal((await fixture.events()).filter((event) => event.command === 'OPEN').length, opened);
    } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

test('final public inventory refuses occupied reserved names and retains the original terminal records for an explicit retry',
  { skip: nativeProfileSkip, timeout: 35_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture();
    const owner = fixture.createOwner();
    let retried: DockerDesktopRecoveryController | undefined;
    try {
      await owner.open({ expectedGeneration: fixture.generation }); await destroyOriginal(owner, fixture);
      const resource = owner.members[0]?.resources.find((entry) => entry.role === 'compute'); assert(resource);
      fixture.occupy(resource.name);
      await assert.rejects(owner.close(), failure(owner));
      const retained = parseRecoveryCanonical(await fixture.currentText());
      assert.equal(retained.format, 'agenai.docker-desktop-recovery.v1');
      if (retained.format === 'agenai.docker-desktop-recovery.v1') assert.notEqual(retained.phase.kind, 'terminal_ready');
      assert.equal(owner.members[0]?.phase, 'destroyed'); assert.equal(fixture.source.effects.length, 0);
      await owner.release(); fixture.occupy();
      retried = fixture.createOwner(); await retried.open({ expectedGeneration: fixture.generation }); await retried.close();
      assert.equal(snapshotState(retried).kind, 'closed'); assert.equal(retried.members[0]?.phase, 'destroyed');
    } finally {
      await fixture.release(); await retried?.release({ timeoutMs: 1000 }).catch(() => {});
      await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close();
    }
  });

test('final public inventory independently checks every reserved name and the original full returned ID after exact cleanup',
  { skip: nativeProfileSkip, timeout: 35_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture('none', 'identified');
    const owner = fixture.createOwner();
    try {
      const id = fixture.returnedContainerId; assert(id);
      const originalCreates = fixture.source.effects.filter((effect) => effect.method === 'POST' && effect.path === '/v1.52/containers/create').length;
      await owner.open({ expectedGeneration: fixture.generation }); await destroyOriginal(owner, fixture);
      assert.equal(fixture.source.containers.has(id), false);
      const start = fixture.source.requests.length;
      await owner.close();
      const final = fixture.source.requests.slice(start);
      for (const resource of fixture.record.resources) {
        assert(final.some((request) => request.method === 'GET' && request.path.includes(`/${encodeURIComponent(resource.name)}`)),
          `Final inventory omitted reserved ${resource.role} name.`);
      }
      assert(final.some((request) => request.method === 'GET' && request.path === `/v1.52/containers/${id}/json`),
        'A final name-only sweep must not replace independent full-ID absence.');
      assert.equal(fixture.source.effects.filter((effect) => effect.method === 'POST' && effect.path === '/v1.52/containers/create').length, originalCreates);
      assert.equal(snapshotState(owner).kind, 'closed');
    } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

test('cancelling a public open wait retains the entered conversion and blocks member admission until the same actual phase joins',
  { skip: nativeProfileSkip, timeout: 35_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture('pause_conversion');
    const owner = fixture.createOwner();
    try {
      const abort = new AbortController();
      const opening = owner.open({ expectedGeneration: fixture.generation }, { signal: abort.signal });
      await fixture.waitFor('PAUSED'); abort.abort();
      await assert.rejects(opening, failure(owner, { kind: 'interrupted', by: 'signal', effect: 'owned' }));
      assert.equal(snapshotState(owner).kind, 'opening');
      assert.throws(() => owner.reconcile({ configuration: fixture.configuration, record: fixture.record }),
        failure(owner, { kind: 'busy' }));
      await fixture.release(); await owner.settle();
      assert.equal(snapshotState(owner).kind, 'ready');
      await destroyOriginal(owner, fixture); await owner.close();
      assert.equal(snapshotState(owner).kind, 'closed');
      assert.equal((await fixture.events()).filter((event) => event.command === 'BIND_ORIGIN').length, 1);
    } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

test('public close owns the gap through a paused member terminal checkpoint and joins cleanup after its wait is cancelled',
  { skip: nativeProfileSkip, timeout: 35_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture();
    const owner = fixture.createOwner();
    try {
      await owner.open({ expectedGeneration: fixture.generation });
      const record = owner.members[0]; assert(record);
      const member = await owner.reconcile({ configuration: fixture.configuration, record });
      assert(member.kind === 'matched' || member.kind === 'uncertain');
      await fixture.fault('pause_destroyed');
      const destroying = member.owner.destroy();
      await fixture.waitFor('PAUSED');
      const abort = new AbortController();
      const closing = owner.close({ signal: abort.signal }); abort.abort();
      await assert.rejects(closing, failure(owner, { kind: 'interrupted', by: 'signal', effect: 'owned' }));
      assert.throws(() => owner.reconcile({ configuration: fixture.configuration, record }), failure(owner, { kind: 'busy' }));
      await fixture.release(); await destroying; await owner.settle();
      assert.equal(snapshotState(owner).kind, 'closed'); assert.equal(owner.members[0]?.phase, 'destroyed');
      assert.equal(fixture.source.effects.length, 0);
    } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

test('public restoration retry joins its completed native facts after a transient Engine read failure',
  { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture('pause_finished');
    const owner = fixture.createOwner();
    try {
      await owner.open({ expectedGeneration: fixture.generation });
      await owner.beginObservation(); await fixture.simulateStop(); await owner.observeStopped();
      await fixture.simulateStart();
      const finishing = owner.finishObservation();
      await fixture.waitFor('FINISHED_PAUSED'); fixture.setOffline(true); await fixture.release();
      await assert.rejects(finishing, failure(owner));
      assert.equal(snapshotState(owner).kind, 'fenced');
      fixture.setOffline(false);
      await owner.finishObservation();
      assert.deepEqual(snapshotState(owner), { kind: 'ready', generation: fixture.generation, barrier: 'accepted' });
      await destroyOriginal(owner, fixture); await owner.close();
      assert.equal(snapshotState(owner).kind, 'closed'); assert.equal(fixture.source.effects.length, 0);
    } finally {
      fixture.setOffline(false); await fixture.release();
      await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close();
    }
  });

test('public observation rejoins exact stopped and finished facts after their publication acknowledgements fail',
  { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture('after_stopped_fact');
    const owner = fixture.createOwner();
    try {
      await owner.open({ expectedGeneration: fixture.generation });
      await owner.beginObservation(); await fixture.simulateStop();
      await assert.rejects(owner.observeStopped(), failure(owner));
      await fixture.simulateStart(); await owner.observeStopped();
      await fixture.fault('after_finished_fact');
      await assert.rejects(owner.finishObservation(), failure(owner));
      await owner.finishObservation();
      assert.deepEqual(snapshotState(owner), { kind: 'ready', generation: fixture.generation, barrier: 'accepted' });
      await destroyOriginal(owner, fixture); await owner.close();
      assert.equal(snapshotState(owner).kind, 'closed'); assert.equal(fixture.source.effects.length, 0);
    } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

test('public restoration still classifies unread bytes after readiness and refuses a late restore error',
  { skip: nativeProfileSkip, timeout: 40_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture('late_restore_error');
    const owner = fixture.createOwner();
    try {
      await owner.open({ expectedGeneration: fixture.generation });
      await owner.beginObservation(); await fixture.simulateStop(); await owner.observeStopped();
      await fixture.simulateStart();
      await assert.rejects(owner.finishObservation(), failure(owner, { kind: 'observation_incomplete', reason: 'restoration' }));
      const current = parseRecoveryCanonical(await fixture.currentText());
      assert.equal(current.format, 'agenai.docker-desktop-recovery.v1');
      if (current.format !== 'agenai.docker-desktop-recovery.v1') assert.fail('Failed observation lost its recovery transaction.');
      assert.equal(current.phase.kind, 'stopped'); assert.equal(current.historyHead, null);
      assert.deepEqual(owner.members, [fixture.record]); assert.equal(fixture.source.effects.length, 0);
    } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

test('public observed recovery settles an original absent no-ID compute only after the complete native/log/API barrier and preserves dependencies beforehand',
  { skip: nativeProfileSkip, timeout: 60_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture('none', 'unknown_compute');
    const owner = fixture.createOwner();
    try {
      const original = parseRecoveryCanonical(await fixture.currentText());
      assert.equal(original.format, 'agenai.docker-desktop-coordinator.v1');
      if (original.format !== 'agenai.docker-desktop-coordinator.v1' || original.generation.kind !== 'dirty') assert.fail('Expected original dirty source state.');
      const compute = original.generation.members[0]?.roles.find((role) => role.role === 'compute');
      assert.equal(compute?.presence.kind, 'possibly_present');
      if (compute?.presence.kind === 'possibly_present') assert.equal(compute.presence.returnedId, null);
      const volumes = [...fixture.source.volumes.keys()]; const networks = [...fixture.source.networks.keys()];
      assert(volumes.length > 0 && networks.length > 0);
      const creates = fixture.source.effects.filter((effect) => effect.method === 'POST' && effect.path === '/v1.52/containers/create').length;
      await owner.open({ expectedGeneration: fixture.generation });
      const record = owner.members[0]; assert(record);
      const held = await owner.reconcile({ configuration: fixture.configuration, record });
      assert(held.kind === 'uncertain');
      await assert.rejects(held.owner.destroy()); await owner.settle();
      for (const name of volumes) assert(fixture.source.volumes.has(name), 'Absent unresolved compute must retain original volume dependencies.');
      for (const id of networks) assert(fixture.source.networks.has(id), 'Absent unresolved compute must retain the original network.');
      assert.equal(fixture.source.containers.size, 0, 'Known helpers must be independently joined before arming.');
      await owner.beginObservation();
      assert.equal(snapshotState(owner).kind, 'observing');
      await fixture.simulateStop(); await owner.observeStopped();
      await fixture.simulateStart(); await owner.finishObservation();
      assert.deepEqual(snapshotState(owner), { kind: 'ready', generation: fixture.generation, barrier: 'accepted' });
      await destroyOriginal(owner, fixture);
      const settled = parseRecoveryCanonical(await fixture.currentText());
      assert.equal(settled.format, 'agenai.docker-desktop-recovery.v1');
      if (settled.format !== 'agenai.docker-desktop-recovery.v1') assert.fail('Expected retained explicit recovery envelope.');
      assert.equal(settled.noIdAbsences.length, 1); assert.equal(settled.noIdAbsences[0]?.role, 'compute');
      const computeRecord = owner.members[0]?.resources.find((resource) => resource.role === 'compute');
      assert.equal(computeRecord?.identity.kind, 'creating', 'Barrier absence must not manufacture an acquired container ID.');
      await owner.close();
      assert.equal(snapshotState(owner).kind, 'closed');
      for (const name of volumes) assert.equal(fixture.source.volumes.has(name), false);
      for (const id of networks) assert.equal(fixture.source.networks.has(id), false);
      assert.equal(fixture.source.effects.filter((effect) => effect.method === 'POST' && effect.path === '/v1.52/containers/create').length, creates,
        'Observed recovery must never replay the original unknown create.');
      const commands = (await fixture.events()).map((event) => event.command);
      assert.equal(commands.filter((command) => command === 'ARM').length, 1);
      assert.equal(commands.filter((command) => command === 'OBSERVE_STOPPED').length, 1);
      assert.equal(commands.filter((command) => command === 'FINISH_FACTS').length, 1);
    } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });

test('public recovery cannot infer a missing stopped checkpoint from a later started composition',
  { skip: nativeProfileSkip, timeout: 45_000 }, async () => {
    const fixture = await desktopRecoveryControllerFixture('none', 'unknown_compute');
    const owner = fixture.createOwner();
    try {
      await owner.open({ expectedGeneration: fixture.generation });
      const record = owner.members[0]; assert(record);
      const member = await owner.reconcile({ configuration: fixture.configuration, record });
      assert(member.kind === 'uncertain');
      await assert.rejects(member.owner.destroy()); await owner.settle();
      const volumes = [...fixture.source.volumes.keys()]; const networks = [...fixture.source.networks.keys()];
      await owner.beginObservation(); await fixture.simulateStop(); await fixture.simulateStart();
      await assert.rejects(owner.finishObservation(), failure(owner, { kind: 'invalid_state' }));
      const retained = parseRecoveryCanonical(await fixture.currentText());
      assert.equal(retained.format, 'agenai.docker-desktop-recovery.v1');
      if (retained.format === 'agenai.docker-desktop-recovery.v1') {
        assert.equal(retained.noIdAbsences.length, 0); assert.equal(retained.phase.kind, 'armed');
      }
      for (const name of volumes) assert(fixture.source.volumes.has(name));
      for (const id of networks) assert(fixture.source.networks.has(id));
      assert(!(await fixture.events()).some((event) => event.command === 'FINISH_FACTS'));
      await owner.release(); assert.equal(snapshotState(owner).kind, 'released');
    } finally { await fixture.release(); await owner.release({ timeoutMs: 1000 }).catch(() => {}); await fixture.close(); }
  });
