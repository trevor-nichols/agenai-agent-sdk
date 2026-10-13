import { posix, win32 } from 'node:path';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import { compareStringsByUnicodeCodePoint, type AgentFileChange } from '@agen-ai/agent-protocol';

import { AcpProviderSessionError } from './errors.js';
import { nativeObject, nativeString } from './native.js';

export interface AcpObservedDiff {
  readonly changes: readonly AgentFileChange[];
  readonly text: string;
}

export function acpToolDiff(update: AcpJsonObject, workingDirectory: string): AcpObservedDiff | undefined {
  if (!Array.isArray(update.content)) return undefined;
  const changes: AgentFileChange[] = [];
  const text: string[] = [];
  const paths = new Set<string>();
  for (const value of update.content) {
    const content = nativeObject(value, 'tool content');
    if (content.type !== 'diff') continue;
    const nativePath = nativeString(content.path, 'diff path');
    const pathFlavor = /^[A-Za-z]:[\\/]|^\\\\/u.test(workingDirectory) ? win32 : posix;
    const relative = pathFlavor.relative(workingDirectory, nativePath);
    if (!pathFlavor.isAbsolute(nativePath) || pathFlavor.normalize(nativePath) !== nativePath || !relative
      || relative === '..' || relative.startsWith(`..${pathFlavor.sep}`) || pathFlavor.isAbsolute(relative)) {
      throw new AcpProviderSessionError('acp_diff_path_unsupported', 'ACP diff paths must identify canonical files within the session working directory.');
    }
    const path = pathFlavor === win32 ? relative.replaceAll('\\', '/') : relative;
    if (paths.has(path)) throw new AcpProviderSessionError('acp_diff_duplicate_path', 'ACP repeated a path within a tool diff snapshot.');
    paths.add(path);
    const oldText = content.oldText == null ? undefined : nativeString(content.oldText, 'diff original text');
    const newText = nativeString(content.newText, 'diff replacement text');
    changes.push({ path, changeKind: oldText === undefined ? 'created' : 'modified' });
    text.push(`${path}\nBefore:\n${oldText ?? '(new file)'}\nAfter:\n${newText}`);
  }
  return changes.length ? { changes: changes.sort((left, right) => compareStringsByUnicodeCodePoint(left.path, right.path)), text: text.join('\n\n') } : undefined;
}
