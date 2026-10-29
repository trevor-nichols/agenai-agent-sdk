import type { SandboxProcessInput } from '@agen-ai/sandbox';
import type { SandboxCodexPreflight } from './types.js';

const config = [
  'model_provider="openai"', 'model_reasoning_effort="low"',
  'check_for_update_on_startup=false', 'web_search="disabled"',
  'notify=[]', 'mcp_servers={}',
  'skills.bundled.enabled=false', 'skills.include_instructions=false',
  'project_doc_max_bytes=0', 'analytics.enabled=false',
  'otel.log_user_prompt=false', 'otel.exporter="none"',
  'otel.trace_exporter="none"', 'otel.metrics_exporter="none"',
] as const;
const disabled = [
  'plugins', 'remote_plugin', 'apps', 'hooks', 'multi_agent', 'multi_agent_v2',
  'enable_fanout', 'goals', 'skill_mcp_dependency_install', 'daemon_auto_start', 'network_proxy',
] as const;

export function codexProcess(executable: string, cwd: string,
  credential: Readonly<{ kind: 'api_key'; value: string }> | Readonly<{ kind: 'auth_json' }>,
  egress: Readonly<Record<string, string>>): SandboxProcessInput {
  const key = credential.kind === 'api_key';
  return {
    executable, cwd,
    args: [
      '--no-daemon', '--ask-for-approval', 'never',
      ...config.flatMap((value) => ['-c', value]),
      ...disabled.flatMap((name) => ['--disable', name]),
      '--enable', 'skip_host_skill_discovery',
      '-c', key ? 'forced_login_method="api"' : 'forced_login_method="chatgpt"',
      '-c', key ? 'cli_auth_credentials_store="ephemeral"' : 'cli_auth_credentials_store="file"',
      'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json',
      '--color', 'never', '--skip-git-repo-check', '--sandbox', 'danger-full-access',
      '--model', 'gpt-6-luna', '-',
    ],
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/home/sandbox', TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      // Codex refuses a missing CODEX_HOME; only the file route's bootstrap creates the private credential directory.
      CODEX_HOME: key ? '/home/sandbox' : '/home/sandbox/.agenai-credentials', ...egress,
      ...(key ? { CODEX_API_KEY: credential.value } : {}),
    },
  };
}

export function codexPreflight(route: 'api_key' | 'auth_json', lineage: 'caller_quiescent' | 'access_token_only' = 'caller_quiescent'): SandboxCodexPreflight {
  return Object.freeze({
    provider: 'codex', version: '0.163.0', transport: 'native_cli_exec', credentialRoute: route,
    sourceKind: route === 'api_key' ? 'explicit_api_key' : 'explicit_native_auth_file',
    refresh: route === 'api_key' ? 'not_applicable' : lineage === 'access_token_only' ? 'disabled' : 'native_owned',
    nativeDestination: route === 'api_key' ? 'CODEX_API_KEY' : '/home/sandbox/.agenai-credentials/auth.json',
    model: 'gpt-6-luna', reasoning: 'low',
    httpsDestinations: Object.freeze(route === 'api_key' ? ['https://api.openai.com:443']
      : ['https://chatgpt.com:443', 'https://auth.openai.com:443']),
    endpointEvidence: route === 'api_key' ? 'observed_in_ms005_native_campaign' : 'pinned_native_source',
    nativeQualification: route === 'api_key' ? 'recorded_linux_x64_and_desktop_native_arm64' : 'see_handoff_for_exact_route_and_platform_evidence',
    preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration',
  });
}
