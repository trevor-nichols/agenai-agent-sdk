import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const CLAUDE_FIXTURE_IDS = {
  alpha: '10000001-1111-4111-8111-111111111111',
  beta: '10000002-1111-4111-8111-111111111111',
  compact: '10000003-1111-4111-8111-111111111111',
  programmatic: '10000004-1111-4111-8111-111111111111',
  empty: '10000005-1111-4111-8111-111111111111',
  unavailable: '10000006-1111-4111-8111-111111111111',
  otherProject: '10000007-1111-4111-8111-111111111111',
  worktree: '10000008-1111-4111-8111-111111111111',
  missing: '10000009-1111-4111-8111-111111111111',
  oversized: '10000010-1111-4111-8111-111111111111',
} as const;

export interface ClaudeFixture {
  readonly root: string;
  readonly configHome: string;
  readonly temporaryRoot: string;
  readonly projectPath: string;
  readonly otherProjectPath: string;
  readonly worktreePath: string | undefined;
  readonly ids: typeof CLAUDE_FIXTURE_IDS;
  cleanup(): Promise<void>;
}

export function claudeSessionFile(fixture: ClaudeFixture, sessionId: string, projectPath = fixture.projectPath): string {
  return join(fixture.configHome, 'projects', projectPath.replace(/[^a-zA-Z0-9]/gu, '-'), `${sessionId}.jsonl`);
}

export function claudeMessage(sessionId: string, uuid: string, parentUuid: string | null, type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, uuid, parentUuid, sessionId, timestamp: '2026-10-21T12:00:00.000Z',
    version: '2.1.306', isSidechain: false, entrypoint: 'cli', message: { role: type, content }, ...extra };
}

export async function seedClaudeSession(fixture: ClaudeFixture, sessionId: string, rows: readonly Record<string, unknown>[], options: { title?: string; projectPath?: string; ageSeconds?: number } = {}): Promise<void> {
  const projectPath = options.projectPath ?? fixture.projectPath;
  const file = claudeSessionFile(fixture, sessionId, projectPath);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const entries = [...rows.map((row) => ({ ...row, cwd: projectPath })),
    ...(options.title === undefined ? [] : [{ type: 'custom-title', sessionId, customTitle: options.title }])];
  await writeFile(file, entries.length === 0 ? '' : `${entries.map((row) => JSON.stringify(row)).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  const mtime = Date.parse('2026-10-21T12:00:00Z') / 1000 - (options.ageSeconds ?? 0);
  await utimes(file, mtime, mtime);
}

export async function seedClaudeLargeSession(fixture: ClaudeFixture, sessionId: string, textBytes: number): Promise<void> {
  const file = await open(claudeSessionFile(fixture, sessionId), 'wx', 0o600);
  const marker = 'STREAMED_NATIVE_TEXT';
  const row = JSON.stringify({ ...claudeMessage(sessionId, 'resource-u1', null, 'user', marker), cwd: fixture.projectPath });
  const markerOffset = row.indexOf(marker);
  try {
    await file.writeFile(`${JSON.stringify({ type: 'custom-title', sessionId, customTitle: 'Owned resource boundary', cwd: fixture.projectPath })}\n${row.slice(0, markerOffset)}`);
    const chunk = 'x'.repeat(1024 * 1024);
    for (let remaining = textBytes; remaining > 0; remaining -= chunk.length) {
      await file.writeFile(chunk.slice(0, Math.min(remaining, chunk.length)));
    }
    await file.writeFile(`${row.slice(markerOffset + marker.length)}\n`);
  } finally { await file.close(); }
}

export async function forkClaudeFixture(fixture: ClaudeFixture, sessionId: string): Promise<string> {
  const source = `import {forkSession} from ${JSON.stringify(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))};
console.log(JSON.stringify(await forkSession(process.argv[1],{dir:process.argv[2],title:'Native surviving fork'})));`;
  const { stdout } = await execute('/usr/bin/prlimit', ['--as=4294967296', '--cpu=12', '--nofile=128', '--core=0', '--',
    process.execPath, '--jitless', '--max-old-space-size=128', '--input-type=module', '--eval', source, sessionId, fixture.projectPath],
  { env: { PATH: '/usr/bin:/bin', HOME: fixture.root, CLAUDE_CONFIG_DIR: fixture.configHome }, timeout: 20000, maxBuffer: 32768 });
  const result: unknown = JSON.parse(stdout);
  if (result === null || typeof result !== 'object' || !('sessionId' in result) || typeof result.sessionId !== 'string') {
    throw new Error('The official fixture fork helper returned an invalid identity.');
  }
  return result.sessionId;
}

export async function createClaudeFixture(options: { label?: string; gitWorktree?: boolean } = {}): Promise<ClaudeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'agent-claude-history-'));
  const configHome = join(root, 'config');
  const temporaryRoot = join(root, 'workers');
  const projectPath = join(root, 'project');
  const otherProjectPath = join(root, 'other-project');
  const worktreePath = options.gitWorktree ? join(root, 'worktree') : undefined;
  const fixture: ClaudeFixture = { root, configHome, temporaryRoot, projectPath, otherProjectPath, worktreePath,
    ids: CLAUDE_FIXTURE_IDS, cleanup: () => rm(root, { recursive: true, force: true }) };
  try {
    await Promise.all([configHome, temporaryRoot, projectPath, otherProjectPath].map((path) => mkdir(path, { mode: 0o700 })));
    if (worktreePath) {
      const git = (args: string[]) => execute('git', args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'git-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 10000 });
      await git(['init', '--quiet', projectPath]);
      await git(['-C', projectPath, '-c', 'user.name=History Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic history fixture']);
      await git(['-C', projectPath, 'worktree', 'add', '--quiet', '--detach', worktreePath]);
    }
    const label = options.label ?? 'HOME-A';
    const ids = fixture.ids;
    await seedClaudeSession(fixture, ids.alpha, [
      claudeMessage(ids.alpha, 'alpha-u1', null, 'user', `${label} user first`),
      claudeMessage(ids.alpha, 'alpha-a1', 'alpha-u1', 'assistant', [
        { type: 'text', text: `${label} assistant before tool` },
        { type: 'tool_use', id: 'toolu_fixture_read', name: 'Read', input: { file_path: '/synthetic/input.txt' } },
        { type: 'text', text: `${label} assistant after tool` },
      ]),
      claudeMessage(ids.alpha, 'alpha-u2', 'alpha-a1', 'user', [
        { type: 'tool_result', tool_use_id: 'toolu_fixture_read', content: `${label} tool result` },
        { type: 'text', text: `${label} user after tool` },
      ]),
      claudeMessage(ids.alpha, 'alpha-a2', 'alpha-u2', 'assistant', [{ type: 'text', text: `${label} assistant final` }]),
    ], { title: `${label} Alpha` });
    await seedClaudeSession(fixture, ids.beta, [claudeMessage(ids.beta, 'beta-u1', null, 'user', `${label} second conversation`)], { title: `${label} Beta`, ageSeconds: 10 });
    await seedClaudeSession(fixture, ids.compact, [
      claudeMessage(ids.compact, 'compact-old-u', null, 'user', 'PRECOMPACTION USER OMITTED'),
      claudeMessage(ids.compact, 'compact-old-a', 'compact-old-u', 'assistant', [{ type: 'text', text: 'PRECOMPACTION ANSWER OMITTED' }]),
      { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary', parentUuid: null, sessionId: ids.compact,
        timestamp: '2026-10-21T12:00:01.000Z', compactMetadata: { trigger: 'manual', preTokens: 1000 } },
      claudeMessage(ids.compact, 'compact-new-u', 'compact-boundary', 'user', `${label} retained user`),
      claudeMessage(ids.compact, 'compact-new-a', 'compact-new-u', 'assistant', [{ type: 'text', text: `${label} retained assistant` }]),
    ], { title: `${label} Compacted`, ageSeconds: 20 });
    await seedClaudeSession(fixture, ids.programmatic, [claudeMessage(ids.programmatic, 'program-u1', null, 'user', `${label} SDK prompt`, { entrypoint: 'sdk-ts' })], { title: `${label} Programmatic`, ageSeconds: 30 });
    await seedClaudeSession(fixture, ids.empty, [], { title: `${label} Empty`, ageSeconds: 40 });
    await seedClaudeSession(fixture, ids.unavailable, [], { ageSeconds: 50 });
    await seedClaudeSession(fixture, ids.otherProject, [claudeMessage(ids.otherProject, 'other-u1', null, 'user', `${label} other project`)], { title: `${label} Other project`, projectPath: otherProjectPath, ageSeconds: 60 });
    if (worktreePath) await seedClaudeSession(fixture, ids.worktree, [claudeMessage(ids.worktree, 'worktree-u1', null, 'user', `${label} worktree prompt`)], { title: `${label} Worktree`, projectPath: worktreePath, ageSeconds: 70 });
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}
