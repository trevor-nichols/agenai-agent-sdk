import { createInterface } from 'node:readline/promises';
import type { AcceptEditsAction, AcceptEditsDecider } from './decisions.js';

function describe(action: AcceptEditsAction): string {
  switch (action.kind) {
    case 'command': return `Run this exact command once?\n  ${JSON.stringify(action.command)}`;
    case 'edit': return `Apply ${action.reason === 'restricted' ? 'restricted' : 'host-policy'} edits once?\n${action.paths.map((path) => `  ${JSON.stringify(path)}`).join('\n')}`;
    case 'read': return `Read this restricted file once?\n  ${JSON.stringify(action.path)}`;
  }
}

/**
 * Asks a person at a terminal. Only an explicit "y" approves; an empty answer, any other text,
 * a closed terminal or cancellation denies this one action.
 */
export function terminalDecider(): AcceptEditsDecider {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error('Interactive approvals require a terminal. Use an exact approval list for unattended runs.');
  }
  return async (action, signal) => {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await prompt.question(`${describe(action)}\nApprove once? [y/N] `, { signal });
      return answer.trim() === 'y' ? 'approve_once' : 'deny_once';
    } catch {
      return 'deny_once';
    } finally {
      prompt.close();
    }
  };
}
