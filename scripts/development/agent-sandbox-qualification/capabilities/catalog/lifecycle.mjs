import assert from 'node:assert/strict';
import { CleanupObligations } from '../../platform/capabilities/cleanup/obligations.mjs';
import { originalOwnerCleanup } from '../../platform/capabilities/live/owner-cleanup.mjs';

export class CatalogFailure extends Error {
  constructor(code) { super('Catalog qualification failed.'); this.code = code; }
}

/** One SDK stdout reader owns the complete bounded guest record until closure. */
export function catalogReader(streams, parseResult) {
  let failed;
  const interrupted = Promise.withResolvers();
  const fail = (code) => { failed ??= new CatalogFailure(code); interrupted.reject(failed); };
  const stdout = (async () => {
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of streams.stdout) {
        bytes += chunk.byteLength;
        if (bytes > 256 * 1024) { fail('guest_output_capacity'); continue; }
        chunks.push(Buffer.from(chunk));
      }
      if (failed) throw failed;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      return parseResult(JSON.parse(text));
    } catch (error) { throw error instanceof CatalogFailure ? error : new CatalogFailure('guest_report_invalid'); }
  })();
  const stderr = (async () => {
    let bytes = 0;
    try { for await (const chunk of streams.stderr) { bytes += chunk.byteLength; if (bytes > 256 * 1024) fail('guest_stderr_capacity'); } }
    catch { fail('guest_stream_failure'); }
  })();
  const exit = streams.exit.catch(() => { fail('guest_exit_unavailable'); return null; });
  const joined = Promise.allSettled([stdout, stderr, exit]).then((settled) => {
    const [output, diagnostics, completion] = settled;
    if (failed) throw failed;
    if (output.status !== 'fulfilled') throw output.reason;
    if (diagnostics.status !== 'fulfilled' || completion.status !== 'fulfilled') throw new CatalogFailure('guest_stream_failure');
    const receipt = completion.value;
    return { result: output.value, exit: receipt, stdoutJoined: true, stderrJoined: true };
  });
  void joined.catch(() => {});
  const result = Promise.race([joined, interrupted.promise]); void result.catch(() => {});
  return { result, join: () => joined };
}

export async function observeWork(actual, { timeoutMs, signal }) {
  let timer;
  const abort = () => interrupted.reject(new CatalogFailure('cancelled'));
  const interrupted = Promise.withResolvers();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => interrupted.reject(new CatalogFailure('observation_deadline')), timeoutMs);
  try { return await Promise.race([actual, interrupted.promise]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Retry only the same original owner. A finite observation never releases its authority. */
export async function finishCatalogCleanup({ state, report, save, timeoutMs = 30000, independentAbsence, afterOwners = [] }) {
  const cleanup = new CleanupObligations({ timeoutMs, onFailure(_error, step) {
    report.status = 'failed'; report.cleanup.failures.push({ step, code: 'cleanup_incomplete' });
  } });
  await cleanup.finish(async () => {
    if (state.processOwner) await cleanup.step('credential-process-stop', () => originalOwnerCleanup(state.processOwner, 'stop'), { retryRejected: true });
    if (state.owner) {
      await cleanup.step('original-owner-stop', () => originalOwnerCleanup(state.owner, 'stop'), { retryRejected: true });
      await cleanup.step('original-owner-destroy', () => originalOwnerCleanup(state.owner, 'destroy'), { retryRejected: true });
      assert.equal(state.owner.state.kind, 'destroyed');
      report.cleanup.originalOwnerDestroyed = true;
    }
    if (state.work) await cleanup.step('entered-work-join', async () => {
      try { await state.work; } catch { /* The primary classification owns the failed work. */ }
    });
    if (state.reader) await cleanup.step('sole-reader-join', async () => {
      try { state.joined = await state.reader.join(); }
      catch (error) { report.status = 'failed'; report.failure ??= error instanceof CatalogFailure ? error.code : 'guest_stream_failure'; }
      report.cleanup.readerJoined = true;
      report.cleanup.processReaderJoined = true;
    });
    if (state.owner) await cleanup.step('independent-resource-absence', async () => {
      report.cleanup.absence = await independentAbsence(state.owner.recoveryRecord);
    }, { retryRejected: true });
    for (const [index, action] of afterOwners.entries()) await cleanup.step(`support-${index}`, action, { retryRejected: true });
    await cleanup.step('credential-dispose', () => { state.credential?.dispose(); });
  }, async (attempt) => {
    report.status = 'failed'; report.cleanup.complete = false;
    report.cleanup.retained = { pid: process.pid, retrySignal: 'SIGUSR2', attempt, steps: cleanup.snapshot() };
    await save(); process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', ...report.cleanup.retained })}\n`);
  });
  report.cleanup.complete = true;
  await save();
}
