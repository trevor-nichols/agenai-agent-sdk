import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runOwnedCommand } from '../../../command.mjs';
import { until } from '../../../engine.mjs';

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export function startController({ script, configuration, cwd, env, timeoutMs, maxOutputBytes, signal,
  mode = 'start', onControl = async () => {} }) {
  assert(['start', 'lease'].includes(mode));
  const child = spawn(process.execPath, [script, mode, configuration], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false; let failure; let stdout = ''; let stderr = ''; let bytes = 0;
  let killObservation; let killLogging;
  const controls = [];
  const completion = Promise.withResolvers();
  const sendSignal = async (name) => {
    assert(child.pid && !closed, 'Control signals require the original live child process.');
    const observation = { signal: name, pid: child.pid, pgid: child.pid, enteredAt: new Date().toISOString(), status: 'entered' };
    controls.push(observation); assert(controls.length <= 8);
    try { await onControl(observation); }
    catch (error) { failure ??= error; throw error; }
    if (closed) { observation.status = 'closed-before-signal'; await onControl(observation); return observation; }
    try { process.kill(-child.pid, name); observation.status = 'sent'; }
    catch (error) { observation.status = error.code === 'ESRCH' ? 'absent' : 'failed'; if (error.code !== 'ESRCH') throw error; }
    observation.sentAt = new Date().toISOString();
    try { await onControl(observation); } catch (error) { failure ??= error; }
    return observation;
  };
  const kill = () => {
    if (closed || !child.pid || killObservation) return;
    killObservation = { signal: 'SIGKILL', pid: child.pid, pgid: child.pid,
      enteredAt: new Date().toISOString(), status: 'entered', loggingStatus: 'pending' };
    controls.push(killObservation);
    // Abort must retire the owned group even when evidence persistence is blocked.
    try { process.kill(-child.pid, 'SIGKILL'); killObservation.status = 'sent'; }
    catch (error) {
      killObservation.status = error.code === 'ESRCH' ? 'absent' : 'failed';
      if (error.code !== 'ESRCH') failure ??= error;
    }
    killObservation.sentAt = new Date().toISOString();
    killLogging = Promise.resolve().then(() => onControl(killObservation)).then(() => { killObservation.loggingStatus = 'fulfilled'; },
      (error) => { killObservation.loggingStatus = 'rejected'; failure ??= error; });
  };
  const receive = (field, chunk) => {
    bytes += chunk.byteLength;
    if (bytes > maxOutputBytes) { failure ??= new Error('Owned recovery controller exceeded its output bound.'); kill(); return; }
    if (field === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
  };
  child.stdout.on('data', (chunk) => receive('stdout', chunk)); child.stderr.on('data', (chunk) => receive('stderr', chunk));
  child.once('error', (error) => { failure ??= error; });
  const timer = setTimeout(() => { failure ??= new Error('Owned recovery controller exceeded its deadline.'); kill(); }, timeoutMs);
  const abort = () => { failure ??= new Error('Owned recovery controller was cancelled.'); kill(); };
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  child.once('close', (code, exitedSignal) => {
    closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    completion.resolve({ pid: child.pid ?? null, code, signal: exitedSignal });
  });
  const snapshot = async () => {
    assert(child.pid && !closed, 'A process-group snapshot requires the original live child.');
    const command = '/bin/ps'; const args = ['-A', '-o', 'pid=,ppid=,pgid=,stat='];
    const execution = await runOwnedCommand({ command, args, cwd, env, timeoutMs: 5000, maxOutputBytes: 256 * 1024,
      terminationGraceMs: 250, signal });
    assert.equal(execution.stderr, '');
    const processes = execution.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line); assert(match, 'Unexpected bounded ps process-state record.');
      return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4] };
    }).filter(({ pgid }) => pgid === child.pid);
    assert(processes.length > 0 && processes.length <= 16, 'Original controller group is missing or exceeds its bound.');
    const leader = processes.find(({ pid }) => pid === child.pid);
    assert(leader && leader.ppid === process.pid && leader.pgid === child.pid, 'Controller process-group ownership changed.');
    return { observedAt: new Date().toISOString(), command, args, status: execution.status, quiescent: execution.quiescent,
      stdoutBytes: Buffer.byteLength(execution.stdout), stdoutSha256: createHash('sha256').update(execution.stdout).digest('hex'),
      stderr: execution.stderr, processes };
  };
  const pause = async () => {
    const before = await snapshot();
    const observation = await sendSignal('SIGSTOP'); observation.before = before;
    observation.observed = await until(async () => {
      const actual = await snapshot();
      return actual.processes.every(({ state }) => state.startsWith('T')) ? actual : false;
    }, 5000, 'Original controller process group did not stop.');
    await onControl(observation); return observation;
  };
  return {
    get pid() { return child.pid; },
    controls,
    snapshot,
    pause,
    resume: () => sendSignal('SIGCONT'),
    async ready(timeout) {
      return until(() => {
        if (failure) throw failure;
        const lines = stdout.split('\n');
        for (const line of lines.slice(0, -1)) {
          const message = JSON.parse(line);
          if (message.phase === 'ready') { assert.equal(message.pid, child.pid); return message; }
        }
        assert(!closed, `Controller closed before native readiness: ${stderr}`); return false;
      }, timeout, 'Controller did not acknowledge its durable initialized-workspace checkpoint.');
    },
    async join() {
      const exit = await completion.promise;
      if (child.pid) await until(() => !groupExists(child.pid), 5000, 'Original controller process group remains owned after child closure.');
      if (killLogging) {
        let timer;
        try {
          await Promise.race([killLogging, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Owned controller SIGKILL evidence persistence remains pending.')), Math.min(5000, timeoutMs));
          })]);
        } catch (error) { failure ??= error; }
        finally { clearTimeout(timer); }
      }
      if (failure) throw Object.assign(failure, { quiescent: true, stdout, stderr, controls });
      return { ...exit, stdout, stderr, groupQuiescent: true, controls };
    },
    async kill() { kill(); return this.join(); },
  };
}
