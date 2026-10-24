import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { AgentHistoryError } from '../../lifecycle/errors.js';

export interface GrokProjectMount { readonly name: string; readonly handle: FileHandle }
const AUXILIARY_FILES = new Set(['session_search.sqlite', 'session_search.sqlite-wal', 'session_search.sqlite-shm',
  'session_search.sqlite-journal', 'prompt_history.jsonl']);

/** Compose native project directories with a fresh native cache; no session files are parsed here. */
export async function openGrokSearchProjects(root: FileHandle): Promise<readonly GrokProjectMount[]> {
  const projects: GrokProjectMount[] = [];
  try {
    let count = 0;
    for await (const entry of await opendir(`/proc/self/fd/${root.fd}`)) {
      count += 1;
      if (count > 256) throw new AgentHistoryError('limit_exhausted', 'Grok search sessions-root census exceeds 256 entries.');
      if (entry.isFile() && AUXILIARY_FILES.has(entry.name)) continue;
      if (!entry.isDirectory() || !/^[^/\u0000-\u001F\u007F]{1,255}$/u.test(entry.name)) {
        throw new AgentHistoryError('unsupported_scope', 'Grok search requires the qualified native sessions-root directory layout.');
      }
      if (projects.length === 64) throw new AgentHistoryError('limit_exhausted', 'Grok search permits at most 64 native project-directory mounts.');
      const handle = await open(`/proc/self/fd/${root.fd}/${entry.name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      projects.push({ name: entry.name, handle });
    }
    return projects;
  } catch (error) {
    await Promise.all(projects.map((project) => project.handle.close()));
    if (error instanceof AgentHistoryError) throw error;
    throw new AgentHistoryError('unsupported_scope', 'The native Grok search project-directory mounts are unavailable.');
  }
}
