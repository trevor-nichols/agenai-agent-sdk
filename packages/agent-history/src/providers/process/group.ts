import { setTimeout as delay } from 'node:timers/promises';
import { AgentHistoryError } from '../../lifecycle/errors.js';

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

export function terminateProcessGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (!absent(error)) throw new AgentHistoryError('cleanup_failed', 'Native history process group could not be stopped.'); }
}

export async function waitForGroupExit(pid: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (true) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if (absent(error)) return;
      throw new AgentHistoryError('cleanup_failed', 'Native history process group could not be inspected.');
    }
    if (performance.now() >= deadline) throw new AgentHistoryError('cleanup_failed', 'Native history process group has not exited.');
    await delay(20);
  }
}
