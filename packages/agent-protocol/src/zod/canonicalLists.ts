// ------------------------------------------------------------------------------------------------
//                canonicalLists.ts - Unique canonical-order list refinement - Dependencies: Zod 4
// ------------------------------------------------------------------------------------------------

import type { z } from 'zod/v4';

export function addCanonicalListIssues(
  input: {
    readonly values: readonly string[];
    readonly canonicalOrder?: readonly string[];
    readonly path: readonly (string | number)[];
    readonly label: string;
  },
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  let previousOrder = -1;
  input.values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [...input.path, index],
        message: `${input.label} must be unique.`,
      });
    }
    seen.add(value);

    const order = input.canonicalOrder
      ? input.canonicalOrder.indexOf(value)
      : index === 0 || input.values[index - 1]! < value
        ? index
        : previousOrder;
    if (index > 0 && order <= previousOrder) {
      context.addIssue({
        code: 'custom',
        path: [...input.path, index],
        message: `${input.label} must use canonical order.`,
      });
    }
    previousOrder = order;
  });
}
