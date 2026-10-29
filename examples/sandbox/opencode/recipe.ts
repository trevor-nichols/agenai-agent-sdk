import type { Sandbox } from '@agen-ai/sandbox';

export function openCodeProcess(sandbox: Sandbox, task: string, provider: string, model: string,
  egress: Readonly<Record<string, string>>, credential: Readonly<{ kind: 'import' }> | Readonly<{ kind: 'legacy_key'; key: string }>) {
  const imported = credential.kind === 'import';
  return { executable: '/opt/agenai/native/opencode', cwd: sandbox.workspace,
    args: ['run', '--standalone', '--format', 'json', '--model', model, '--agent', 'build', '--auto', '--', task],
    env: {
      HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      XDG_CONFIG_HOME: '/home/sandbox/config', XDG_DATA_HOME: '/home/sandbox/data',
      XDG_CACHE_HOME: '/home/sandbox/cache', XDG_STATE_HOME: '/home/sandbox/state', XDG_RUNTIME_DIR: '/home/sandbox/runtime',
      ...(credential.kind === 'legacy_key' ? { ANTHROPIC_API_KEY: credential.key } : {}),
      OPENCODE_DB: imported ? '/home/sandbox/.agenai-credentials/opencode.db' : '/home/sandbox/data/opencode/opencode.db',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_FREE_MODELS: '1',
      OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_FILEWATCHER_DISABLE: '1', OPENCODE_DISABLE_FFF: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model,
        ...(!imported ? { providers: { anthropic: { settings: { baseURL: 'https://api.anthropic.com/v1' } } } } : {}),
        warming: false, update: 'disable', snapshots: false, plugins: ['-opencode.browser'],
        compaction: { auto: false }, default_agent: 'build',
        experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' },
          { action: 'provider.use', resource: provider, effect: 'allow' }] } }),
      ...egress,
    } };
}
