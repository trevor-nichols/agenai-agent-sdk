// MS001 research controller. Its protocol has no caller-selected lock/journal root.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const engineKey = (engineId) => digest({ domain: 'agenai.desktop-coordinator.research.v1', engineId });

export async function openHolder(binary, engineId, launcher = {}) {
  const args = launcher.args ?? [engineKey(engineId)];
  const child = spawn(launcher.command ?? binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiting = [];
  let failure;
  let stderr = '';
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2048); });
  child.stdin.on('error', () => {});
  const ended = new Promise((resolve) => {
    const end = (error) => {
      failure ??= error;
      for (const pending of waiting.splice(0)) pending.reject(failure);
      resolve(failure);
    };
    child.once('error', (error) => end(error));
    child.once('exit', (code, signal) => end(new Error(`holder_exit:${code}:${signal}:${stderr}`)));
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let value;
    try { value = JSON.parse(line); } catch { value = { kind: 'failure', reason: 'invalid_frame' }; }
    const pending = waiting.shift();
    if (pending) pending.resolve(value);
    else lines.push(value);
  });
  const next = () => {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('holder_frame_timeout')); }, 5000);
      waiting.push({ resolve(value) { clearTimeout(deadline); resolve(value); },
        reject(error) { clearTimeout(deadline); reject(error); } });
    });
  };
  const checked = async (pending) => {
    const value = await pending;
    if (value.kind === 'failure') throw new Error(`${value.reason}:${value.errno}`);
    return value;
  };
  let tail = Promise.resolve();
  const holder = {
    child,
    ended,
    command(command) {
      const operation = tail.then(async () => {
        if (failure) throw failure;
        child.stdin.write(`${command}\n`);
        return checked(next());
      });
      tail = operation.catch(() => {});
      return operation;
    },
    async close() {
      child.stdin.end();
      await ended;
    },
  };
  try { holder.identity = await checked(next()); }
  catch (error) { child.stdin.end(); await ended; throw error; }
  return holder;
}

export function parseJournal(text) {
  if (!text.endsWith('\n')) throw new Error('torn_journal');
  const entries = text.slice(0, -1).split('\n').map((line) => JSON.parse(line));
  const [empty, ...frames] = entries;
  if (JSON.stringify(empty) !== '{"kind":"empty","version":1}') throw new Error('journal_header');
  let previous = digest(empty);
  for (const [index, frame] of frames.entries()) {
    const { checksum, ...body } = frame;
    if (body.sequence !== index + 1 || body.previous !== previous || checksum !== digest(body)) throw new Error('journal_integrity');
    previous = checksum;
  }
  return { entries, record: frames.at(-1)?.record, previous, sequence: frames.length };
}

export function immutableMemberBinding(record) {
  return digest({ format: record.format, backendId: record.backendId, backendRevision: record.backendRevision,
    namespace: record.namespace, operationId: record.operationId, sandboxId: record.sandboxId,
    imageDigest: record.imageDigest, configurationDigest: record.configurationDigest, policyDigest: record.policyDigest,
    resources: record.resources.map(({ role, name }) => ({ role, name })) });
}

export async function activate(binary, engineId, configuration, launcher) {
  const holder = await openHolder(binary, engineId, launcher);
  try {
    const journal = parseJournal((await holder.command('SNAPSHOT')).text);
    if (journal.record && journal.record.phase !== 'clean') throw new Error(`dirty_generation:${journal.record.generation}`);
    const coordinator = {
      holder,
      journal,
      failure: undefined,
      record: { format: 'agenai.desktop-coordinator-research.v1', engineId, generation: randomUUID(),
        configuration, phase: 'active', members: [], transition: null },
      async checkpoint(record) {
        if (this.failure) throw this.failure;
        // Preserve returned identities before the persistence promise, as the real member journal does.
        this.record = structuredClone(record);
        const body = { sequence: this.journal.sequence + 1, previous: this.journal.previous, record: this.record };
        const checksum = digest(body);
        try {
          await holder.command(`APPEND ${JSON.stringify({ ...body, checksum })}`);
          this.journal = { ...this.journal, sequence: body.sequence, previous: checksum, record: this.record };
        } catch (error) { this.failure = error; throw error; }
      },
      async register(record) {
        if (this.record.members.length >= 8) throw new Error('member_capacity');
        await this.checkpoint({ ...this.record, members: [...this.record.members,
          { binding: immutableMemberBinding(record), original: record, state: 'registered' }] });
      },
      async begin(memberRecord, persistMember) {
        const binding = immutableMemberBinding(memberRecord);
        if (!this.record.members.some((member) => member.binding === binding)) throw new Error('unknown_member');
        if (this.record.transition) throw new Error('transition_busy');
        try { await persistMember(memberRecord); }
        catch (error) { this.failure = error; throw error; }
        await this.checkpoint({ ...this.record, transition: { binding, state: 'authorized', original: memberRecord } });
      },
      async dispatch(effect) {
        if (this.failure) throw this.failure;
        if (!this.record.transition || this.record.transition.state !== 'authorized') throw new Error('missing_intent');
        await holder.command('CHECK');
        const result = await effect();
        const observed = { ...this.record, transition: { ...this.record.transition, state: 'identified', returned: result } };
        this.record = structuredClone(observed);
        await this.checkpoint(observed);
        return result;
      },
      async settle() {
        if (this.record.transition?.state !== 'identified') throw new Error('unsettled_effect');
        await this.checkpoint({ ...this.record, transition: null });
      },
      async clean() {
        if (this.record.transition || this.record.members.length > 0) throw new Error('unresolved_obligations');
        await this.checkpoint({ ...this.record, phase: 'clean' });
      },
    };
    void holder.ended.then((error) => { coordinator.failure ??= error; });
    await coordinator.checkpoint(coordinator.record);
    return coordinator;
  } catch (error) { await holder.close(); throw error; }
}

export function assertRecoveryBinding(canonical, supplied, engineId, generation, configurationDigest) {
  if (canonical.engineId !== engineId || canonical.generation !== generation
    || supplied.configurationDigest !== configurationDigest
    || !canonical.members.some((member) => member.binding === immutableMemberBinding(supplied))) {
    throw new Error('recovery_conflict');
  }
  return Object.freeze({ kind: 'cleanup_only', generation, operationId: supplied.operationId });
}
