import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export async function joinOriginalChild({ command, args, cwd, env, output, onSpawn }) {
  const stdout = await open(join(output, 'controller-stdout.log'), 'wx', 0o600);
  const stderr = await open(join(output, 'controller-stderr.log'), 'wx', 0o600);
  const result = { command, args, cwd, startedAt: Date.now(), pid: null, code: null, signal: null, truncated: false, joined: false, failures: [] };
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  result.pid = child.pid;
  const forward = (signum) => { if (!result.joined) child.kill(signum); };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const closed = new Promise((resolve) => {
    child.on('error', (error) => result.failures.push(String(error)));
    child.once('close', (code, signal) => { Object.assign(result, { code, signal, joined: true, finishedAt: Date.now() }); resolve(); });
  });
  const drain = async (stream, file) => {
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes <= 1024 ** 2) await file.writeFile(chunk);
        else result.truncated = true;
      }
    } catch (error) { result.failures.push(String(error)); }
    finally { await file.close(); }
  };
  const readers = [drain(child.stdout, stdout), drain(child.stderr, stderr)];
  try { await onSpawn(result); }
  catch (error) { result.failures.push(String(error)); }
  // No outer native timeout or forced kill. A retained original owner keeps this join pending.
  await Promise.all([closed, ...readers]);
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  assert.equal(result.failures.length, 0, result.failures.join('\n'));
  return result;
}
