// ------------------------------------------------------------------------------------------------
//                deadline.ts - Caller-selected absolute turn deadlines within Node timer bounds
// ------------------------------------------------------------------------------------------------

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function scheduleTurnDeadline(deadlineAt: string, expire: () => void): () => void {
  const expiresAt = Date.parse(deadlineAt);
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { expire(); return; }
    timer = setTimeout(check, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  timer = setTimeout(check, Math.min(Math.max(0, expiresAt - Date.now()), MAX_TIMER_DELAY_MS));
  return () => clearTimeout(timer);
}
