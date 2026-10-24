// ------------------------------------------------------------------------------------------------
//                closing.ts - Actual filesystem work and close failures retain separate evidence
// ------------------------------------------------------------------------------------------------

export async function closeAfter<Value>(perform: () => Promise<Value>, close: () => Promise<void>): Promise<Value> {
  let outcome: Readonly<{ kind: 'returned'; value: Value }> | Readonly<{ kind: 'threw'; error: unknown }>;
  try { outcome = { kind: 'returned', value: await perform() }; }
  catch (error) { outcome = { kind: 'threw', error }; }
  try { await close(); }
  catch (cleanupError) {
    if (outcome.kind === 'threw') throw new AggregateError([outcome.error, cleanupError], 'Filesystem work and native handle closure both failed.', { cause: outcome.error });
    throw cleanupError;
  }
  if (outcome.kind === 'threw') throw outcome.error;
  return outcome.value;
}
