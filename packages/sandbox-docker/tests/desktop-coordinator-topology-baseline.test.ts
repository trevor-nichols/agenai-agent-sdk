import assert from 'node:assert/strict';
import test from 'node:test';
import { lifecycleTopology } from './fixtures/desktopCoordinatorTopologyLifecycle.js';

// Resource Saver stops the Desktop VM while no container runs; the first container create boots it again.
const externalChange = /External Desktop Engine topology changed\./u;

test('activation over a Resource Saver stopped VM takes its baseline from the first live member observation', async () => {
  const fixture = await lifecycleTopology({ stoppedVm: true });
  try {
    await fixture.addMember();
    assert.equal(fixture.manager.observationKind, 'full');
    await fixture.addMember();
    fixture.addForeignNetwork();
    await assert.rejects(fixture.manager.assertCurrent(), externalChange);
  } finally { await fixture.close(); }
});

test('a cold boot baseline waits for duplicate address detection on Desktop interfaces', async () => {
  // Three tentative reads: one whole observation, then one that settles between its two VM reads.
  const fixture = await lifecycleTopology({ stoppedVm: true, tentativeReadsAfterWake: 3 });
  try {
    await fixture.addMember();
    await fixture.addMember();
    fixture.addForeignNetwork();
    await assert.rejects(fixture.manager.assertCurrent(), externalChange);
  } finally { await fixture.close(); }
});

test('a period without owned members starts a new live baseline across a Resource Saver reboot', async () => {
  const fixture = await lifecycleTopology();
  try {
    const first = await fixture.addMember(); await first.stop(); await first.destroy();
    fixture.stopVm(); fixture.drift();
    await fixture.addMember();
    assert.equal(fixture.manager.observationKind, 'full');
    fixture.addForeignNetwork();
    await assert.rejects(fixture.manager.assertCurrent(), externalChange);
  } finally { await fixture.close(); }
});

test('the first member after a period without owned members allocates around networks created meanwhile', async () => {
  const fixture = await lifecycleTopology();
  try {
    // Without a member network, only the Engine census can show the foreign network on the first slot.
    const first = await fixture.addMember(false); await first.stop(); await first.destroy();
    fixture.addForeignNetwork('10.240.0.0/28');
    await fixture.manager.assertCurrent();
    const next = await fixture.addMember();
    assert.deepEqual(next.member.network?.IPAM.Config, [{ Subnet: '10.240.0.16/28', Gateway: '10.240.0.17' }]);
  } finally { await fixture.close(); }
});

test('a period without owned members still requires the Engine identity seen at activation', async () => {
  for (const identity of [{ Name: 'another-host' }, { KernelVersion: '6.12.99-linuxkit' }]) {
    const fixture = await lifecycleTopology();
    try {
      const first = await fixture.addMember(); await first.stop(); await first.destroy();
      fixture.replaceEngineIdentity(identity);
      await assert.rejects(fixture.manager.assertCurrent(), /Desktop Engine identity differs from its activation\./u);
      await assert.rejects(fixture.addMember(), /Desktop Engine identity differs from its activation\./u);
    } finally { await fixture.close(); }
  }
});

test('an Engine restart while a stopped member is retained is refused as a restart', async () => {
  const fixture = await lifecycleTopology();
  try {
    const first = await fixture.addMember(); await first.stop();
    fixture.stopVm();
    await assert.rejects(fixture.addMember(false), {
      name: 'SandboxOperationError', message: 'Desktop Engine restarted while the coordinator owned resources in its VM.' });
  } finally { await fixture.close(); }
});
