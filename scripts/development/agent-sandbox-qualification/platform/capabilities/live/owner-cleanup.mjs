import { setTimeout as delay } from 'node:timers/promises';
import { failure } from './evidence.mjs';

export async function settleOwnerCleanup(owner, operation, { cleanupMs, observe }) {
  const deadline = performance.now() + cleanupMs;
  let lastFailure;
  for (let attempt = 1; attempt <= 8 && performance.now() < deadline; attempt++) {
    const startedAt = new Date().toISOString();
    const observation = (status) => ({ kind: 'original-owner-cleanup-observation', operation, attempt, startedAt, status,
      ownerState: structuredClone(owner.state), recoveryRecord: structuredClone(owner.recoveryRecord),
      remainingMs: Math.max(0, Math.floor(deadline - performance.now())) });
    await observe(observation('entered'));
    let timer; let terminal;
    try {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new Error('Captured cleanup observation budget expired before the next observation.');
      await Promise.race([owner[operation](), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Captured cleanup observation budget expired; the original owner retains its actual task.')), remainingMs);
      })]);
      terminal = observation('fulfilled');
    } catch (error) {
      lastFailure = error;
      terminal = { ...observation('rejected'), failure: failure(error) };
    } finally { clearTimeout(timer); }
    terminal.finishedAt = new Date().toISOString();
    await observe(terminal);
    if (terminal.status === 'fulfilled') return terminal;
    if (performance.now() < deadline) await delay(Math.min(100, deadline - performance.now()));
  }
  throw new Error('Bounded cleanup observations did not settle; retain the same public cleanup owner and original record.', { cause: lastFailure });
}
