// ------------------------------------------------------------------------------------------------
//                selectors.ts - Glob selectors compiled to a bounded, linear-state matcher
// ------------------------------------------------------------------------------------------------

/**
 * One matcher state. `segment` consumes any code point except `/`; `any` consumes every code point;
 * `none` consumes nothing and only forwards. A looping state stays put after it consumes.
 */
type MatchState = Readonly<{ consumes: 'literal' | 'segment' | 'any' | 'none'; literal: string; loop: boolean; forward: readonly number[] }>;

export interface CompiledSelector {
  readonly states: readonly MatchState[];
}

/** Work shared by one decision or one search; each active state examined for one code point costs one step. */
export interface MatchBudget {
  steps: number;
}

const state = (consumes: MatchState['consumes'], forward: readonly number[] = [], loop = false, literal = ''): MatchState =>
  Object.freeze({ consumes, literal, loop, forward: Object.freeze([...forward]) });

/**
 * `**` spans segments, `**\/` also matches zero segments, `*` and `?` stay within one segment, and
 * every other code point is literal.
 */
export function compileSelector(selector: string): CompiledSelector {
  const characters = [...selector];
  const states: MatchState[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    const at = states.length;
    const character = characters[index] as string;
    if (character === '*' && characters[index + 1] === '*') {
      if (characters[index + 2] === '/') {
        states.push(state('none', [at + 1, at + 3]), state('any', [at + 2], true), state('literal', [], false, '/'));
        index += 2;
      } else {
        states.push(state('any', [at + 1], true));
        index += 1;
      }
    } else if (character === '*') states.push(state('segment', [at + 1], true));
    else if (character === '?') states.push(state('segment'));
    else states.push(state('literal', [], false, character));
  }
  return Object.freeze({ states: Object.freeze(states) });
}

/**
 * Simulates every alternative at once, so a path costs at most its code points times the selector's
 * states. Resolves `undefined` when the budget runs out before the answer is known.
 */
export function selectorMatches(selector: CompiledSelector, text: string, budget: MatchBudget): boolean | undefined {
  const { states } = selector;
  const accept = states.length;
  const marks = new Int32Array(accept + 1).fill(-1);
  let generation = 0;
  const enter = (into: number[], from: number) => {
    const pending = [from];
    while (pending.length > 0) {
      const index = pending.pop() as number;
      if (marks[index] === generation) continue;
      marks[index] = generation;
      into.push(index);
      if (index < accept) pending.push(...(states[index] as MatchState).forward);
    }
  };
  let active: number[] = [];
  enter(active, 0);
  for (const character of text) {
    if (active.length === 0) return false;
    budget.steps -= active.length;
    if (budget.steps < 0) return undefined;
    generation += 1;
    const next: number[] = [];
    for (const index of active) {
      if (index === accept) continue;
      const current = states[index] as MatchState;
      const consumed = current.consumes === 'any' || (current.consumes === 'segment' && character !== '/')
        || (current.consumes === 'literal' && character === current.literal);
      if (consumed) enter(next, current.loop ? index : index + 1);
    }
    active = next;
  }
  return active.includes(accept);
}
