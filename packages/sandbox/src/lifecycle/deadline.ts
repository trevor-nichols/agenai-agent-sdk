// ------------------------------------------------------------------------------------------------
//                deadline.ts - Cancellable monotonic deadline - Node timer range handling
// ------------------------------------------------------------------------------------------------

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Slices an admitted finite duration without turning Node timer overflow into immediate expiry. */
export function scheduleDeadline(timeoutMs: number, expire: () => void): () => void {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) { expire(); return; }
    timer = setTimeout(check, Math.min(Math.ceil(remaining), MAX_TIMER_DELAY_MS));
  };
  timer = setTimeout(check, Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
  return () => clearTimeout(timer);
}
