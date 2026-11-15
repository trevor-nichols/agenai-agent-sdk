// ------------------------------------------------------------------------------------------------
//                native-stub.ts - Native session boundary whose opening can leave its server unjoined
// ------------------------------------------------------------------------------------------------

import type { NativeOpening, NativeSession } from '../../src/node/native.js';
import { NativeCleanupFailure } from '../../src/node/server.js';

/** `alive` stands for a server group that has not exited; its close can only join it once false. */
export const nativeControl = { mode: 'open' as 'open' | 'retained', alive: true, closes: 0, openings: [] as NativeOpening[] };

export async function openNativeSession(opening: NativeOpening): Promise<NativeSession> {
  nativeControl.openings.push(opening);
  const close = async () => {
    nativeControl.closes += 1;
    if (nativeControl.mode === 'retained' && nativeControl.alive) throw new Error('The OpenCode server group survived.');
  };
  if (nativeControl.mode === 'retained') {
    const cause = new Error('The plugin did not acknowledge readiness.');
    try { await close(); } catch (cleanupError) { throw new NativeCleanupFailure(cause, cleanupError, close); }
  }
  return {
    sessionID: `ses_${nativeControl.openings.length}`,
    listen() {}, async prompt() {}, async readSession() { throw new Error('unused'); }, async interrupt() { return true; },
    async rejectPermission() {}, async cancelForm() {},
    async savedGrants() { return 0; }, reply() {}, close,
  };
}
