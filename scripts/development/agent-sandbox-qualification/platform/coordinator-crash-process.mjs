// Expected controller crash: observe natural native-holder settlement before any cleanup signal.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

function exists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function observeCoordinatorCrash({ executable, args, cwd, env, timeoutMs = 90_000 }) {
  const child = spawn(executable, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  let bytes = 0, closed = false, status = null, signal = null, failure;
  const evidence = { pid: child.pid, intervention: false, quiescent: false, status, signal };
  const receive = (destination, chunk) => {
    if (bytes + chunk.length > 64 * 1024) { failure ??= new Error('Crash child output exceeded 64 KiB.'); return; }
    bytes += chunk.length; destination.push(chunk);
  };
  child.stdout.on('data', (chunk) => receive(stdout, chunk));
  child.stderr.on('data', (chunk) => receive(stderr, chunk));
  child.stdout.on('error', (error) => { failure ??= error; });
  child.stderr.on('error', (error) => { failure ??= error; });
  child.once('error', (error) => { failure ??= error; });
  child.once('exit', (code, name) => { status = code; signal = name; });
  child.once('close', () => { closed = true; });
  const deadline = performance.now() + timeoutMs;
  try {
    while (!failure && (!closed || child.pid && exists(child.pid)) && performance.now() < deadline) await delay(20);
    evidence.quiescent = closed && (!child.pid || !exists(child.pid));
    if (!evidence.quiescent) failure ??= new Error('Crash child or holder did not settle naturally before the deadline.');
    if (status !== null || signal !== 'SIGKILL') failure ??= new Error('Crash child did not exit through the expected SIGKILL.');
  } catch (error) { failure ??= error; }
  finally {
    if (!evidence.quiescent && child.pid) {
      evidence.intervention = true;
      try {
        if (exists(child.pid)) process.kill(-child.pid, 'SIGKILL');
        const cleanupDeadline = performance.now() + 5_000;
        while ((!closed || exists(child.pid)) && performance.now() < cleanupDeadline) await delay(20);
        evidence.quiescent = closed && !exists(child.pid);
      } catch (error) { failure = new AggregateError([failure, error], 'Crash proof and owned process cleanup failed.'); }
    }
    if (!closed) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
  }
  Object.assign(evidence, { status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  if (failure || evidence.intervention) throw Object.assign(failure ?? new Error('Crash proof required cleanup intervention.'), evidence);
  return evidence;
}
