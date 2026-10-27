import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { until } from '../../../engine.mjs';
import { failure } from './evidence.mjs';

const program = `import fs from 'node:fs/promises';import{createHash}from'node:crypto';
const [operation,marker]=process.argv.slice(1);
if(operation==='seed'){await fs.writeFile('/store/sentinel',marker,{flag:'wx',mode:0o600});await fs.mkdir('/store/sibling');await fs.writeFile('/store/sibling/sentinel',marker,{flag:'wx',mode:0o600});}
const bytes=await fs.readFile('/store/sentinel');const sibling=await fs.readFile('/store/sibling/sentinel');
console.log(JSON.stringify({marker:bytes.toString(),sha256:createHash('sha256').update(bytes).digest('hex'),siblingSha256:createHash('sha256').update(sibling).digest('hex'),stage:await fs.readdir('/store/stage'),root:await fs.readdir('/store')}));`;

const output = (bytes, maximum) => ({ byteLength: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  text: bytes.subarray(0, maximum).toString('utf8'), truncated: bytes.length > maximum });

async function exec(run, context, fixture, operation) {
  assert(fixture.executions.length < 32, 'Sentinel exec observations exceed their bounded census.');
  const observation = { operation, execId: null, status: 'planned' };
  fixture.executions.push(observation); await run.save();
  let stream; let primary; let closingFailure; let result;
  try {
    const created = await context.engine.request('POST', `/containers/${fixture.id}/exec`, {
      AttachStdout: true, AttachStderr: true, Tty: false,
      Cmd: ['/usr/local/bin/node', '--input-type=module', '-e', program, operation, fixture.marker],
    });
    observation.execId = created.data.Id; assert.match(observation.execId, /^[a-f0-9]{64}$/u);
    observation.status = 'created'; await run.save();
    stream = await context.engine.hijack(`/exec/${observation.execId}/start`, { Detach: false, Tty: false });
    await stream.waitFor((actual) => actual.closed, context.config.capabilities.limits.requestMs);
    const completed = (await context.engine.request('GET', `/exec/${observation.execId}/json`)).data;
    observation.inspection = { ID: completed.ID, ContainerID: completed.ContainerID, Running: completed.Running,
      ExitCode: completed.ExitCode, Pid: completed.Pid, OpenStdout: completed.OpenStdout, OpenStderr: completed.OpenStderr };
    observation.stdout = output(stream.stdout, 4096); observation.stderr = output(stream.stderr, 8192);
    observation.status = 'settled'; await run.save();
    assert.equal(completed.Running, false); assert.equal(completed.ExitCode, 0);
    assert.equal(stream.stderr.length, 0);
    result = JSON.parse(stream.stdout.toString('utf8'));
  } catch (error) {
    primary = error; observation.failure = failure(error);
    if (stream && !observation.stdout) { observation.stdout = output(stream.stdout, 4096); observation.stderr = output(stream.stderr, 8192); }
    await run.save();
  } finally {
    try { await stream?.close(); }
    catch (error) {
      closingFailure = error; observation.closeFailure = failure(error);
    }
  }
  if (closingFailure) {
    await run.save();
    throw primary ? new AggregateError([primary, closingFailure], 'Sentinel exec and stream closure failed.') : closingFailure;
  }
  if (primary) throw primary;
  return result;
}

export async function sentinel(run, context, owner) {
  const storage = owner.recoveryRecord.resources.find(({ role }) => role === 'storage');
  assert.equal(storage.identity.kind, 'identified');
  const marker = `outside-${randomUUID()}`;
  const fixture = { role: 'sentinel', name: `platform-live-sentinel-${randomUUID()}`, id: null,
    volume: storage.identity.id, image: context.config.imageDigest, marker, pidsLimit: 32,
    acquisition: 'planned', executions: [], removed: false };
  run.fixtures.push(fixture); run.evidence.fixtures.push(fixture); await run.save();
  const labels = { 'org.agenai.sandbox.platform-live.owner': context.config.fixtureOwner,
    'org.agenai.sandbox.platform-live.role': 'sentinel' };
  const user = context.config.capabilities.workload.user;
  const numericUser = `${user.uid}:${user.gid}`;
  fixture.acquisition = 'creating'; await run.save();
  const created = await context.engine.request('POST', `/containers/create?name=${encodeURIComponent(fixture.name)}`, {
    Image: fixture.image, User: numericUser, WorkingDir: '/store', Entrypoint: ['/usr/local/bin/node'],
    Cmd: ['-e', 'setInterval(()=>{},1000)'], Env: ['LANG=C.UTF-8'], NetworkDisabled: true,
    Labels: labels, Healthcheck: { Test: ['NONE'] },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'], Privileged: false, Binds: [], PidMode: '', IpcMode: 'private', CgroupnsMode: 'private',
      NanoCpus: 250_000_000, Memory: 64 * 1024 ** 2, MemorySwap: 64 * 1024 ** 2, PidsLimit: fixture.pidsLimit,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
      Mounts: [{ Type: 'volume', Source: fixture.volume, Target: '/store', ReadOnly: false, VolumeOptions: { NoCopy: true } }] },
  });
  fixture.id = created.data.Id; assert.match(fixture.id, /^[a-f0-9]{64}$/u); fixture.acquisition = 'identified'; await run.save();
  await context.engine.request('POST', `/containers/${fixture.id}/start`);
  const actual = (await context.engine.request('GET', `/containers/${fixture.id}/json`)).data;
  assert.equal(actual.Image, fixture.image); assert.equal(actual.Config.User, numericUser);
  for (const [key, value] of Object.entries(labels)) assert.equal(actual.Config.Labels[key], value);
  assert.equal(actual.HostConfig.NetworkMode, 'none'); assert.deepEqual(actual.HostConfig.Binds ?? [], []);
  assert.equal(actual.HostConfig.PidsLimit, fixture.pidsLimit);
  assert.equal(actual.Mounts.length, 1); assert.equal(actual.Mounts[0].Name, fixture.volume);
  const inspect = async (operation = 'read') => exec(run, context, fixture, operation);
  const before = await inspect('seed');
  assert.equal(before.marker, marker); assert.deepEqual(before.stage, []);
  fixture.before = before; await run.save();
  return { marker, inspect, fixture };
}

export async function closeSentinels(run, context) {
  const failures = [];
  for (const fixture of [...run.fixtures].reverse()) {
    try {
      const selected = fixture.id ?? fixture.name;
      const response = await context.engine.request('GET', `/containers/${selected}/json`, undefined, { allowed: [200, 404] });
      assert(response.status !== 404 || fixture.acquisition !== 'creating',
        'A by-name absence cannot settle an unknown sentinel create; retain original fixture and workspace ownership.');
      if (response.status === 200) {
        const actual = response.data;
        assert.equal(actual.Config.Labels['org.agenai.sandbox.platform-live.owner'], context.config.fixtureOwner);
        assert.equal(actual.Config.Labels['org.agenai.sandbox.platform-live.role'], 'sentinel');
        assert.equal(actual.Image, fixture.image); assert.equal(actual.Name, `/${fixture.name}`);
        if (fixture.before && actual.State.Running) {
          const after = await exec(run, context, fixture, 'read');
          assert.equal(after.sha256, fixture.before.sha256); assert.equal(after.siblingSha256, fixture.before.siblingSha256);
          assert.deepEqual(after.stage, []); fixture.after = after;
        }
        await context.engine.request('DELETE', `/containers/${actual.Id}?force=true&v=true`, undefined, { allowed: [204, 404] });
        await until(async () => (await context.engine.request('GET', `/containers/${actual.Id}/json`, undefined, { allowed: [200, 404] })).status === 404,
          context.config.capabilities.limits.cleanupMs, 'Sentinel removal did not settle.');
      }
      fixture.removed = true;
    } catch (error) { failures.push(error); }
    await run.save();
  }
  if (failures.length) throw new AggregateError(failures, 'Sentinel ownership remains before workspace removal.');
}
