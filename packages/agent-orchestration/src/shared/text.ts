// ------------------------------------------------------------------------------------------------
//                text.ts - Unicode-preserving prefixes under serialized projection budgets
// ------------------------------------------------------------------------------------------------

export function fitDelegationText(text: string, fits: (value: string) => boolean): string {
  if (fits(text)) return text;
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(characters.slice(0, middle).join(""))) low = middle; else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}
