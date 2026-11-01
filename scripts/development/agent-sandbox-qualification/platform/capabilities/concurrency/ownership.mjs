import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants, writeSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** A cleanup owner outlives a failed finite work deadline. No timer kills its authority. */
export async function runResidentCommand({ command, args, cwd, env, directory, timeoutMs }) {
  await mkdir(directory, { mode: 0o700 });
  const stdoutPath = join(directory, 'stdout.log'), stderrPath = join(directory, 'stderr.log');
  const stdout = await open(stdoutPath, 'wx', 0o600), stderr = await open(stderrPath, 'wx', 0o600);
  let child, closed = false, status = null, signal = null, spawnFailure;
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', stdout.fd, stderr.fd] });
    child.once('error', (error) => { spawnFailure = error; });
    child.once('exit', (code, name) => { status = code; signal = name; });
    child.once('close', () => { closed = true; });
  } finally { await stdout.close(); await stderr.close(); }
  const result = { pid: child.pid, command, args, cwd, stdoutPath, stderrPath, status: null, signal: null,
    quiescent: false, disposition: 'running', terminationSent: false, diagnosticCapacity: 256 * 1024 };
  const retained = (receipt) => {
    const value = { ...result, disposition: 'retained_cleanup', receipt };
    Object.defineProperty(value, 'retryCleanup', { value() {
      if (!closed && child.exitCode === null && child.signalCode === null) child.kill('SIGUSR2');
    } });
    child.unref(); return value;
  };
  const deadline = performance.now() + timeoutMs;
  while (!closed) {
    const diagnostics = {};
    try {
      for (const [kind, path] of [['stdout', stdoutPath], ['stderr', stderrPath]]) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat(); assert(stat.isFile());
          const buffer = Buffer.alloc(result.diagnosticCapacity + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          diagnostics[kind] = { path, size: stat.size, bytes: buffer.subarray(0, Math.min(bytesRead, result.diagnosticCapacity)),
            exceeded: stat.size > result.diagnosticCapacity || bytesRead > result.diagnosticCapacity };
        } finally { await file.close(); }
      }
    } catch (error) {
      if (child.pid) { child.kill('SIGTERM'); result.terminationSent = true; }
      return retained({ pid: child.pid, retrySignal: 'SIGUSR2', reason: 'diagnostic_observation_failed',
        failure: { name: error.name, message: error.message } });
    }
    const excess = Object.values(diagnostics).filter(({ exceeded }) => exceeded);
    if (excess.length) {
      if (child.pid) { child.kill('SIGTERM'); result.terminationSent = true; }
      return retained({ pid: child.pid, retrySignal: 'SIGUSR2', reason: 'diagnostic_capacity',
        diagnostics: excess.map(({ path, size }) => ({ path, observedBytes: size, capturedPrefixBytes: result.diagnosticCapacity })) });
    }
    const lines = diagnostics.stdout.bytes.toString('utf8').split('\n');
    for (const line of lines.slice(0, -1)) {
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value.status === 'retained_cleanup') {
        assert.equal(value.pid, child.pid, 'Retained receipt must identify the original direct child owner.');
        return retained(value);
      }
    }
    if (performance.now() >= deadline) {
      // SIGTERM asks the original owner to close admission and clean up; it never authorizes
      // replacing its proxy/native holder or discarding an unresolved canonical generation.
      if (child.pid) { child.kill('SIGTERM'); result.terminationSent = true; }
      return retained({ pid: child.pid, retrySignal: 'SIGUSR2', reason: 'Finite work deadline expired; original process remains the cleanup owner.' });
    }
    await delay(25);
  }
  if (spawnFailure) throw spawnFailure;
  return { ...result, status, signal, quiescent: true, disposition: 'exited' };
}

export async function retainCleanupOwner({ operation, onRetained }) {
  const keepAlive = setInterval(() => {}, 30_000);
  let requested = Promise.withResolvers();
  const retry = () => requested.resolve();
  process.on('SIGUSR2', retry);
  try {
    for (let attempt = 1;; attempt++) {
      try { await onRetained(attempt); }
      catch (error) {
        try {
          writeSync(1, `${JSON.stringify({ status: 'retained_cleanup', pid: process.pid, retrySignal: 'SIGUSR2', attempt,
            reportingFailure: { name: String(error.name).slice(0, 128), message: String(error.message).slice(0, 2048) } })}\n`);
        } catch { /* Reporting cannot release the original cleanup owner. */ }
      }
      await requested.promise; requested = Promise.withResolvers();
      try { await operation(); return; } catch { /* The exact owner remains resident for another explicit retry. */ }
    }
  } finally { clearInterval(keepAlive); process.off('SIGUSR2', retry); }
}
