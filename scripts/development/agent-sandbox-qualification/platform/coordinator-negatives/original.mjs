import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { originalFile } from '../coordinator-recovery/common.mjs';
import { loadOriginalMembers } from '../coordinator-recovery/multi-input.mjs';
import { sha } from '../coordinator/evidence.mjs';

export function assertExited(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  assert.fail(`Original predecessor PID ${pid} still exists; no replacement process may acquire cleanup.`);
}

export async function originalDeleteCut(input) {
  const original = await loadOriginalMembers(input);
  const predecessor = await originalFile(input.predecessor, 4 * 1024 ** 2);
  const report = predecessor.value;
  assert.equal(report.format, 'agenai.ms005-owned-controller-crash-handoff.v2');
  assert.equal(report.status, 'original_controller_killed_exact_pending_cut_preserved');
  assert.equal(report.originalHelperExited, true);
  assert.equal(report.barrier.report.path, original.retained.identity.path);
  assert.equal(report.barrier.report.sha256, original.retained.identity.sha256);
  assert.equal(report.barrier.generation, original.generation);
  assert.equal(report.barrier.pending.action, 'delete'); assert.equal(report.barrier.pending.role, 'compute');
  assert.deepEqual(report.input, { path: original.originalInput.identity.path, sha256: original.originalInput.identity.sha256 });
  assertExited(report.pid); assertExited(report.originalHelper.pid);
  const liveCanonical = await originalFileBytes(original.config.scenario.canonicalPath);
  assert.deepEqual(liveCanonical, original.canonical.bytes, 'Original canonical generation changed after the captured predecessor cut.');
  return { ...original, predecessor, originals: [...original.originals, predecessor] };
}

export async function originalFileBytes(path) {
  const { originalBytes } = await import('../coordinator-recovery/common.mjs');
  return (await originalBytes(path, 4 * 1024 ** 2)).bytes;
}

export async function freezeOwnSources(evidence) {
  const directory = new URL('./', import.meta.url); const result = [];
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).sort()) {
    const path = fileURLToPath(new URL(name, directory)); assert.equal(await realpath(path), path);
    result.push({ original: path, ...await evidence.file(`sources/negative-${name}`, await readFile(path), 1024 ** 2) });
  }
  return result;
}

export async function assertOriginals(originals, sources) {
  for (const selected of originals) assert.equal(sha(await readFile(selected.identity.path)), selected.identity.sha256, 'Original input/checkpoint bytes changed.');
  for (const selected of sources) assert.equal(sha(await readFile(selected.original)), selected.sha256, 'Executed qualification source changed.');
}
