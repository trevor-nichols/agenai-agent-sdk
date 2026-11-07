import assert from 'node:assert/strict';
import test from 'node:test';
import { lifecycleTopology } from './fixtures/desktopCoordinatorTopologyLifecycle.js';

test('normal final-observer retirement seals two full observations and preserves the retained allocation on re-entry', async () => {
  const fixture = await lifecycleTopology();
  try {
    const first = await fixture.addMember();
    const reads = first.member.observerReads;
    await fixture.manager.before(first.memberId, 'route_observer', 'control_close');
    assert(first.member.observerReads - reads >= 4, 'Final retirement must bracket retained facts twice before control close.');
    first.member.observer = 'detached';
    const exited = setTimeout(() => { first.member.observer = 'exited'; }, 300);
    try {
      await fixture.manager.after(first.memberId, 'route_observer', 'control_close', first.inspection());
    } finally { clearTimeout(exited); }
    assert.equal(first.member.observer, 'exited', 'An observer still listed by its detached endpoint has not left the host network.');
    await fixture.manager.before(first.memberId, 'route_observer', 'delete'); first.member.observer = 'absent';
    await fixture.manager.after(first.memberId, 'route_observer', 'delete', undefined);
    await fixture.manager.stopped(first.memberId);
    assert.equal(fixture.manager.observationKind, 'quiescent');
    const second = await fixture.addMember();
    assert.equal(second.member.geometry.slot, 1, 'Retained bridges keep their original slot.');
    assert.equal(fixture.manager.observationKind, 'full');
  } finally { await fixture.close(); }
});

test('a retained stopped member keeps the external VM baseline across re-entry', async () => {
  const fixture = await lifecycleTopology();
  try {
    const first = await fixture.addMember(); await first.stop();
    assert.equal(fixture.manager.observationKind, 'quiescent');
    fixture.drift();
    await assert.rejects(fixture.addMember(false), /External Desktop topology changed/u);
  } finally { await fixture.close(); }
});

test('a quiescent bridge deletion cannot conceal its VM remnant on re-entry', async () => {
  const fixture = await lifecycleTopology();
  try {
    const first = await fixture.addMember(); await first.stop();
    await first.destroy();
    assert.equal(fixture.manager.observationKind, 'quiescent');
    first.member.bridgeRemnant = true;
    await assert.rejects(fixture.addMember(false), /Desktop owned bridge remains in the VM after its Engine deletion\./u);
  } finally { await fixture.close(); }
});

for (const order of [[0, 1], [1, 0]] as const) test(`retiring member ${order[0]} preserves the independent peer observation path`, async () => {
  const fixture = await lifecycleTopology();
  try {
    const members = [await fixture.addMember(), await fixture.addMember()];
    const retiring = members[order[0]]; const survivor = members[order[1]];
    await retiring.stop(); await retiring.destroy();
    assert.equal(fixture.manager.observationKind, 'full');
    const reads = survivor.member.observerReads;
    await fixture.manager.assertCurrent();
    assert(survivor.member.observerReads > reads);
    assert.equal(survivor.member.observer, 'running');
    assert(survivor.member.network);
    await survivor.stop();
  } finally { await fixture.close(); }
});

test('a control-failed observer may leave its builtin network while peer producers stay exact', { timeout: 20_000 }, async () => {
  const fixture = await lifecycleTopology();
  try {
    const target = await fixture.addMember(); const peer = await fixture.addMember();
    assert.equal(fixture.manager.releaseControl(target.memberId, 'route_observer'), true);
    await fixture.manager.assertCurrent();
    for (const observer of ['detached', 'exited'] as const) {
      target.member.observer = observer;
      await fixture.manager.assertCurrent();
    }
    peer.member.observer = 'exited';
    await assert.rejects(fixture.manager.assertCurrent(), /registered Desktop producer disappeared/u);
    peer.member.observer = 'running';
    await fixture.manager.before(target.memberId, 'route_observer', 'delete'); target.member.observer = 'absent';
    const removed = await fixture.manager.after(target.memberId, 'route_observer', 'delete', undefined);
    assert(removed.projection?.kind === 'registered');
    assert.equal(removed.projection.facts.observerId, null);
    await fixture.manager.stopped(target.memberId);
    await target.destroy();
    await fixture.manager.assertCurrent();
    await peer.stop();
  } finally { await fixture.close(); }
});

test('a control-failed broker may retire its endpoint without fencing while peer topology stays exact', { timeout: 20_000 }, async () => {
  const fixture = await lifecycleTopology();
  try {
    const target = await fixture.addMember(); const peer = await fixture.addMember();
    await target.startBroker();
    await fixture.manager.assertCurrent();
    assert.equal(fixture.manager.releaseControl(target.memberId, 'egress_broker'), true);
    await fixture.manager.assertCurrent();
    await fixture.manager.before(target.memberId, 'egress_relay', 'delete');
    await fixture.manager.after(target.memberId, 'egress_relay', 'delete', undefined);
    for (const [endpoint, retirement] of [['attached', 'detached'], ['attached', 'releasing'], ['settling', 'releasing'],
      ['retained', 'releasing']] as const) {
      target.member.endpoint = endpoint; target.member.brokerRetirement = retirement;
      await fixture.manager.assertCurrent();
    }
    peer.member.observer = 'exited';
    await assert.rejects(fixture.manager.assertCurrent(), /registered Desktop producer disappeared/u);
    peer.member.observer = 'running';
    await fixture.manager.before(target.memberId, 'egress_broker', 'delete');
    const released = setTimeout(() => { target.member.brokerRetirement = 'none'; }, 300);
    let removed: Awaited<ReturnType<typeof fixture.manager.after>>;
    try {
      removed = await fixture.manager.after(target.memberId, 'egress_broker', 'delete', undefined);
    } finally { clearTimeout(released); }
    assert.equal(target.member.brokerRetirement, 'none', 'A bridge whose broker address is still held is not retained.');
    assert(removed.projection?.kind === 'registered');
    assert.equal(removed.projection.facts.broker, null);
    await target.stop(); await target.destroy();
    await fixture.manager.assertCurrent();
    await peer.stop();
  } finally { await fixture.close(); }
});
