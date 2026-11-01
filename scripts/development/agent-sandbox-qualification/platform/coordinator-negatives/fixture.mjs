import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { failure } from '../coordinator/evidence.mjs';

export function deletedCompute(original) {
  const { report, config, members } = original;
  assert.equal(config.scenario.kind, 'handoff'); assert.equal(config.scenario.at, 'effect-response');
  assert.deepEqual(config.scenario.fault, { operation: 'delete', role: 'compute' });
  assert.equal(report.handoff.phase, 'response-before-delivery');
  const selected = report.handoff.receipt.selected;
  assert.equal(selected.method, 'DELETE'); assert.equal(selected.status, 204);
  const member = members.find(({ member: value }) => value.label === 'b'); assert(member);
  const resource = member.record.resources.find(({ role }) => role === 'compute');
  assert.equal(resource.identity.kind, 'identified');
  assert.equal(selected.target, `/v1.52/containers/${resource.identity.id}?force=true&v=false`);
  return { originalId: resource.identity.id, name: resource.name };
}

export function createReplacement({ engine, guard, image, selected, checkpoint, save }) {
  const owner = randomUUID();
  Object.assign(checkpoint, { ...selected, image, owner, id: null, entered: false, removed: false });
  const saveCleanup = async () => {
    try { await save(); }
    catch (error) { (checkpoint.evidenceFailures ??= []).push(failure(error)); }
  };
  const inspect = async () => {
    const response = await engine.request('GET', `/containers/${encodeURIComponent(checkpoint.id ?? checkpoint.name)}/json`, undefined, { allowed: [200, 404] });
    if (response.status === 404) return null;
    const actual = response.data;
    assert.match(actual.Id, /^[a-f0-9]{64}$/u);
    assert.equal(actual.Name, `/${checkpoint.name}`); assert.equal(actual.Config.Image, image);
    assert.equal(actual.Config.Labels['ai.agen.qualification.recovery-negative'], owner);
    assert.equal(actual.State.Running, false); assert.equal(actual.State.Pid, 0);
    assert.match(actual.State.StartedAt, /^0001-01-01T00:00:00(?:\.0+)?Z$/u);
    assert.deepEqual(actual.Mounts, []);
    assert.equal(actual.HostConfig.NetworkMode, 'none');
    assert.notEqual(actual.Id, selected.originalId);
    if (checkpoint.id) assert.equal(actual.Id, checkpoint.id);
    return actual;
  };
  return {
    async create() {
      await save();
      await engine.request('GET', `/containers/${selected.originalId}/json`, undefined, { allowed: [404] });
      await engine.request('GET', `/containers/${encodeURIComponent(selected.name)}/json`, undefined, { allowed: [404] });
      const path = `/containers/create?name=${encodeURIComponent(selected.name)}&platform=linux%2Farm64`;
      guard.select({ kind: 'fixture_create', path: `/v1.52${path}` });
      checkpoint.createIntent = true; await save();
      checkpoint.entered = true;
      try {
        const response = await engine.request('POST', path, { Image: image, User: '1000:1000', Entrypoint: ['/usr/local/bin/node'],
          Cmd: ['-e', 'throw new Error("this stopped foreign fixture must never start")'],
          Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
          Labels: { 'ai.agen.qualification.recovery-negative': owner },
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
            PidsLimit: 16, Memory: 64 * 1024 ** 2, NanoCpus: 125_000_000, LogConfig: { Type: 'none', Config: {} } } });
        assert.match(response.data.Id, /^[a-f0-9]{64}$/u); checkpoint.id = response.data.Id; await save();
      } finally { guard.select({ kind: 'read_only' }); }
      checkpoint.created = await inspect(); await save();
    },
    async preserved() {
      assert(checkpoint.id, 'The exact replacement ID is still unknown.');
      const actual = await inspect(); assert(actual, 'Original cleanup removed the different same-name fixture.');
      await engine.request('GET', `/containers/${selected.originalId}/json`, undefined, { allowed: [404] });
      return { originalId: selected.originalId, replacementId: actual.Id, name: selected.name, running: false };
    },
    async remove() {
      if (!checkpoint.entered || checkpoint.removed) return;
      const actual = await inspect();
      if (!actual && checkpoint.id && checkpoint.deleteEntered) {
        for (const reference of [checkpoint.id, selected.name]) await engine.request('GET', `/containers/${reference}/json`, undefined, { allowed: [404] });
        checkpoint.removed = true; await saveCleanup(); return;
      }
      assert(actual, 'An uncertain fixture create cannot be settled from name absence.');
      checkpoint.id = actual.Id; await saveCleanup();
      guard.select({ kind: 'fixture_delete', path: `/v1.52/containers/${actual.Id}?force=true&v=false` });
      try { checkpoint.deleteEntered = true; await engine.request('DELETE', `/containers/${actual.Id}?force=true&v=false`, undefined, { allowed: [204] }); }
      finally { guard.select({ kind: 'read_only' }); }
      for (const reference of [actual.Id, selected.name]) await engine.request('GET', `/containers/${reference}/json`, undefined, { allowed: [404] });
      checkpoint.removed = true; await saveCleanup();
    },
  };
}
