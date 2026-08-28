// ------------------------------------------------------------------------------------------------
//                ordering.ts - Canonical protocol string ordering - Dependencies: none
// ------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------
//                Unicode Code-Point Ordering
// ------------------------------------------------------------------------------------------------

export function compareStringsByUnicodeCodePoint(
  left: string,
  right: string,
): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();

  while (true) {
    const leftCodePoint = leftIterator.next();
    const rightCodePoint = rightIterator.next();
    if (leftCodePoint.done) return rightCodePoint.done ? 0 : -1;
    if (rightCodePoint.done) return 1;

    const difference =
      (leftCodePoint.value.codePointAt(0) ?? 0)
      - (rightCodePoint.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
}
