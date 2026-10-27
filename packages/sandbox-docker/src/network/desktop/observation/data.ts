// ------------------------------------------------------------------------------------------------
//                data.ts - Detached immutable native observation data
// ------------------------------------------------------------------------------------------------

export function freezeObservation(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const item of Object.values(value)) freezeObservation(item);
  Object.freeze(value);
}
