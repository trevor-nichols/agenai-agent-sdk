import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const CODEX_NATIVE_VERSION = '0.163.0';
export const CODEX_LINUX_X64_SHA256 = '399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215';
export const CODEX_FIXTURE_PROVENANCE = 'https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/tests/common/rollout.rs';
export const CODEX_FIXTURE_IDS = {
  cli: 'fc3bd767-afc0-40f8-b984-21c2b985ed4e',
  vscode: '5dd54cbc-02cf-45aa-a127-049217ae7f1c',
  exec: 'd9cabb8c-d483-4e1a-95e2-b00d00858dff',
  appServer: '332166eb-0ab2-48f6-a0b7-0a115c98b3fc',
  child: '698c537c-0f0b-4b6e-9f7d-8f8d72a673fc',
  empty: 'b24ad521-7983-4721-a8e3-e5d1260bbf6f',
  missing: '215e9586-25ad-42ab-ba0f-aa62df2e4703',
} as const;

export interface CodexNativeFixture {
  readonly root: string;
  readonly configHome: string;
  readonly temporaryRoot: string;
  readonly projectPath: string;
  readonly otherProjectPath: string;
  readonly ids: typeof CODEX_FIXTURE_IDS;
  cleanup(): Promise<void>;
}

export interface CodexNativeRollout {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly turns: number;
}

export async function createCodexFixture(): Promise<CodexNativeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'agent-codex-history-'));
  const configHome = join(root, 'native-home'), temporaryRoot = join(root, 'workers');
  const projectPath = join(root, 'project'), otherProjectPath = join(root, 'other-project');
  try {
    await Promise.all([configHome, temporaryRoot, projectPath, otherProjectPath].map((path) => mkdir(path, { mode: 0o700 })));
    return { root, configHome, temporaryRoot, projectPath, otherProjectPath,
      ids: CODEX_FIXTURE_IDS, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

// Synthetic native-format setup follows upstream fixtures; production reads only app-server responses.
export async function seedCodexRollouts(fixture: CodexNativeFixture, options: { oversizedAssistantBytes?: number; childInOtherProject?: boolean } = {}): Promise<readonly CodexNativeRollout[]> {
  const specs = [
    { key: 'cli', source: 'cli', day: 1, title: 'History Alpha CLI', turns: 3 },
    { key: 'vscode', source: 'vscode', day: 2, title: 'History Beta VSCode', turns: 2 },
    { key: 'exec', source: 'exec', day: 3, title: 'History Gamma Exec', turns: 1 },
    { key: 'appServer', source: 'mcp', day: 4, title: 'History Delta AppServer', turns: 1 },
    { key: 'child', source: 'child', day: 5, title: 'History Epsilon Child', turns: 1 },
    { key: 'empty', source: 'cli', day: 6, title: null, turns: 0 },
  ] as const;
  const rollouts: CodexNativeRollout[] = [];
  for (const spec of specs) {
    const id = fixture.ids[spec.key], timestamp = `2026-01-0${spec.day}T12:00:00Z`;
    const directory = join(fixture.configHome, 'sessions', '2026', '01', `0${spec.day}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `rollout-${timestamp.replaceAll(':', '-').replace('Z', '')}-${id}.jsonl`);
    const cwd = spec.key === 'exec' || (spec.key === 'child' && options.childInOtherProject) ? fixture.otherProjectPath : fixture.projectPath;
    const meta = { id, session_id: spec.key === 'child' ? fixture.ids.cli : id, timestamp, cwd,
      originator: 'agenai-generated-native-history-fixture', cli_version: CODEX_NATIVE_VERSION,
      source: spec.key === 'child' ? { subagent: { thread_spawn: { parent_thread_id: fixture.ids.cli, depth: 1 } } } : spec.source,
      model_provider: spec.key === 'exec' ? 'fixture-other' : 'openai', history_mode: 'legacy', selected_capability_roots: [],
      ...(spec.key === 'child' ? { parent_thread_id: fixture.ids.cli } : {}),
    };
    const lines: Record<string, unknown>[] = [{ timestamp, type: 'session_meta', payload: meta }];
    for (let turn = 1; turn <= spec.turns; turn += 1) {
      const at = `2026-01-0${spec.day}T12:0${turn}:00Z`;
      const text = turn === 1 ? spec.title : `Fixture ${spec.key} user turn ${turn}`;
      if (spec.key === 'vscode' && turn === 2) {
        lines.push({ timestamp: at, type: 'event_msg', payload: { type: 'task_started', turn_id: 'fixture-vscode-turn-2' } });
      }
      lines.push(
        { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
        { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: text,
          images: spec.key === 'vscode' && turn === 1 ? ['https://fixture.invalid/image.png'] : [], local_images: [], text_elements: [] } },
        { timestamp: at, type: 'event_msg', payload: { type: 'agent_message',
          message: spec.key === 'cli' && turn === 1 && options.oversizedAssistantBytes !== undefined
            ? 'x'.repeat(options.oversizedAssistantBytes) : `Fixture ${spec.key} assistant turn ${turn} body-token-OnlyInContent` } },
      );
      if (spec.key === 'vscode' && turn === 2) {
        lines.push(
          { timestamp: at, type: 'event_msg', payload: { type: 'item_completed', thread_id: id,
            turn_id: 'fixture-vscode-turn-2', started_at_ms: 1, completed_at_ms: 2,
            item: { type: 'FunctionCallOutput', id: 'fixture-tool', name: 'fixture-tool-never-executed', output: 'Synthetic stored tool output' } } },
          { timestamp: at, type: 'event_msg', payload: { type: 'context_compacted' } },
          { timestamp: at, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fixture-vscode-turn-2' } },
        );
      }
    }
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    await utimes(path, new Date(timestamp), new Date(timestamp));
    rollouts.push({ id, path, title: spec.title, cwd, turns: spec.turns });
  }
  return rollouts;
}

export async function codexFileSha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export async function resolveCodexFixtureExecutable(): Promise<string> {
  const require = createRequire(import.meta.url);
  const wrapperManifest = require.resolve('@openai/codex/package.json');
  const manifest = JSON.parse(await readFile(wrapperManifest, 'utf8')) as { version?: unknown };
  if (manifest.version !== CODEX_NATIVE_VERSION) throw new Error('Native fixture requires exact @openai/codex 0.163.0.');
  const platformManifest = require.resolve('@openai/codex-linux-x64/package.json', { paths: [dirname(wrapperManifest)] });
  return join(dirname(platformManifest), 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex');
}
