// ------------------------------------------------------------------------------------------------
//                command.mjs - Bounded task-owned command groups and settlement before cleanup
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitForGroup(pid, deadlineMs) {
  const deadline = performance.now() + deadlineMs;
  do {
    if (!groupExists(pid)) return true;
    await delay(20);
  } while (performance.now() < deadline);
  return !groupExists(pid);
}

export async function runOwnedCommand({ command, args, env, cwd, timeoutMs, maxOutputBytes = 8 * 1024 ** 2,
  terminationGraceMs = 250, signal }) {
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 0 || terminationGraceMs > 180_000) {
    throw new RangeError('Command termination grace must be an integer between 0 and 180000 milliseconds.');
  }
  if (signal?.aborted) throw Object.assign(new Error('Command cancelled before entry.'), { quiescent: true, stdout: '', stderr: '', status: null });
  const child = spawn(command, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let status = null;
  let failure;
  let stopped;
  let closed = false;
  let resolveClosed;
  const closure = new Promise((resolve) => { resolveClosed = resolve; });
  let resolveTermination;
  const termination = new Promise((resolve) => { resolveTermination = resolve; });
  const stopGroup = async () => {
    if (!child.pid) return true;
    const send = (name) => {
      try { process.kill(-child.pid, name); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    try {
      if (!groupExists(child.pid)) return true;
      send('SIGTERM');
      if (await waitForGroup(child.pid, terminationGraceMs)) return true;
      send('SIGKILL');
      return await waitForGroup(child.pid, 2_500);
    } catch { return false; }
  };
  const fail = (error) => {
    failure ??= error;
    stopped ??= stopGroup();
    resolveTermination();
  };
  const accept = (destination, chunk) => {
    if (bytes + chunk.byteLength > maxOutputBytes) {
      fail(new Error(`${command} exceeded its ${maxOutputBytes}-byte output bound.`));
      return;
    }
    bytes += chunk.byteLength;
    destination.push(chunk);
  };
  child.stdout.on('data', (chunk) => accept(stdout, chunk));
  child.stderr.on('data', (chunk) => accept(stderr, chunk));
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  child.once('error', fail);
  child.once('exit', (code, exitedSignal) => {
    status = code;
    if (code !== 0) fail(new Error(`${command} failed (${code ?? exitedSignal}).`));
    else if (child.pid) {
      try {
        if (groupExists(child.pid)) fail(new Error(`${command} exited with an active owned process group.`));
      } catch (error) { fail(error); }
    }
  });
  child.once('close', () => { closed = true; resolveClosed(); });
  const timeout = setTimeout(() => fail(new Error(`${command} exceeded its ${timeoutMs}ms deadline.`)), timeoutMs);
  const abort = () => fail(new Error(`${command} was cancelled.`));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let quiescent = true;
  try {
    // Termination joins both the process group and its inherited output pipes.
    // A child outside the owned group can retain a pipe, so closure is bounded too.
    await Promise.race([closure, termination.then(async () => { await stopped; await delay(250); })]);
    if (stopped) quiescent = await stopped;
    if (!closed) {
      quiescent = false;
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      failure ??= new Error(`${command} output ownership did not settle after group termination.`);
    }
    if (child.pid && groupExists(child.pid)) quiescent = false;
  } catch (error) { failure ??= error; quiescent = false; }
  finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
  const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), status, quiescent };
  if (!quiescent) failure ??= new Error(`${command} process-group quiescence remains uncertain.`);
  if (failure) {
    if (result.stderr) failure.message += `\n${result.stderr.slice(0, 8192)}`;
    throw Object.assign(failure, result);
  }
  return result;
}
