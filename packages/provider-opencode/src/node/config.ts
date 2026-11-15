// ------------------------------------------------------------------------------------------------
//                config.ts - Private native layout, complete environment and locked OpenCode configuration
// ------------------------------------------------------------------------------------------------

import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NODE_PROVIDER_TOOL_NAMES } from '@agen-ai/provider-tools';
import type { NodeProviderToolDefinition } from '@agen-ai/provider-tools/node';
import type { NodeOpenCodeModelProvider, NodeOpenCodeUsageLimits } from '../index.js';
import type { NativeRule } from './client.js';

const PLUGIN_SOURCE = fileURLToPath(new URL('./plugin.js', import.meta.url));
const INPUT_REPAIR_PLUGIN = 'opencode.tool.input.repair';
export const OWNED_PERMISSION = 'agenai.tool';
export const OWNED_TOOLS: readonly string[] = NODE_PROVIDER_TOOL_NAMES.map((name) => `agenai_${name}`);
export const NATIVE_AGENT = 'build';

/** Unknown actions are denied; only the owned tool permission is allowed and nothing asks or persists. */
export const SESSION_RULES: readonly NativeRule[] = Object.freeze([
  Object.freeze({ action: '*', resource: '*', effect: 'deny' as const }),
  Object.freeze({ action: OWNED_PERMISSION, resource: '*', effect: 'allow' as const }),
]);

export interface NativeLayout {
  readonly root: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly cache: string;
  readonly temporary: string;
  /** The empty native location; never the workspace. */
  readonly location: string;
  /** An empty directory and the server's whole `PATH`. */
  readonly bin: string;
  readonly plugin: string;
  readonly configFile: string;
}

/** Creates one private per-session layout inside the tool owner's private state directory. */
export async function createNativeLayout(stateDirectory: string): Promise<NativeLayout> {
  const root = await mkdtemp(join(stateDirectory, 'oc-'));
  await chmod(root, 0o700);
  const layout: NativeLayout = Object.freeze({
    root, home: join(root, 'home'), config: join(root, 'config'), data: join(root, 'data'), state: join(root, 'state'),
    cache: join(root, 'cache'), temporary: join(root, 'tmp'), location: join(root, 'location'), bin: join(root, 'bin'),
    plugin: join(root, 'plugin'), configFile: join(root, 'opencode.json'),
  });
  try {
    for (const directory of [layout.home, layout.config, layout.data, layout.state, layout.cache, layout.temporary, layout.location, layout.bin, layout.plugin]) {
      await mkdir(directory, { mode: 0o700 });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return layout;
}

export interface NativeConfigurationInput {
  readonly provider: NodeOpenCodeModelProvider;
  readonly model: string;
  readonly apiKey: string;
  readonly apiBaseUrl: string;
  /** The loopback port of the private broker endpoint. */
  readonly port: number;
  readonly token: string;
  readonly nonce: string;
  readonly tools: readonly NodeProviderToolDefinition[];
  readonly usageLimits: NodeOpenCodeUsageLimits;
}

function configuration(layout: NativeLayout, input: NativeConfigurationInput) {
  const { maxModelStepsPerTurn: steps, maxOutputTokensPerRequest: maxOutputTokens } = input.usageLimits;
  return {
    warming: false, update: 'disable', share: 'disabled', snapshots: false, compaction: { auto: false },
    formatter: false, lsp: false, websearch: false, skills: [], instructions: [], commands: {}, references: {}, mcp: { servers: {} },
    tool_output: { max_bytes: 262_144, max_lines: 65_536 },
    model: { providerID: input.provider, model: input.model }, default_agent: NATIVE_AGENT,
    agents: { general: { disabled: true }, explore: { disabled: true }, plan: { disabled: true },
      ...(steps === undefined ? {} : { [NATIVE_AGENT]: { steps } }) },
    providers: {
      [input.provider]: {
        env: [], package: `@opencode/ai/providers/${input.provider}`, models: { [input.model]: {} },
        settings: { baseURL: `${input.apiBaseUrl}/v1`, apiKey: input.apiKey, transport: 'http', timeout: 600_000 },
      },
    },
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: input.provider, effect: 'allow' },
      { action: 'integration.connect', resource: '*', effect: 'deny' }, { action: 'mcp.use', resource: '*', effect: 'deny' },
      { action: 'skill.use', resource: '*', effect: 'deny' }, { action: 'websearch.use', resource: '*', effect: 'deny' },
      { action: 'plugin.use', resource: '*', effect: 'deny' }, { action: 'plugin.use', resource: layout.plugin, effect: 'allow' },
      { action: 'tool.use', resource: '*', effect: 'deny' },
      ...OWNED_TOOLS.map((name) => ({ action: 'tool.use', resource: `${name}:*`, effect: 'allow' })),
    ],
    permissions: SESSION_RULES,
    experimental: { location_idle_timeout: false },
    // The built-in input repair rewrites model input before our hook; the broker must judge it unrepaired.
    plugins: [`-${INPUT_REPAIR_PLUGIN}`, {
      package: pathToFileURL(layout.plugin).href,
      options: { port: input.port, token: input.token, nonce: input.nonce, provider: input.provider, tools: input.tools,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) },
    }],
  };
}

/** Writes the read-only plugin copy and the configuration document before the server starts. */
export async function writeNativeFiles(layout: NativeLayout, input: NativeConfigurationInput): Promise<void> {
  await writeFile(join(layout.plugin, 'package.json'), '{"type":"module"}\n', { mode: 0o400, flag: 'wx' });
  await copyFile(PLUGIN_SOURCE, join(layout.plugin, 'server.js'));
  await chmod(join(layout.plugin, 'server.js'), 0o400);
  await chmod(layout.plugin, 0o500);
  await writeFile(layout.configFile, JSON.stringify(configuration(layout, input)), { mode: 0o400, flag: 'wx' });
}

/** The complete server environment; nothing is inherited from the host process. */
export function nativeEnvironment(layout: NativeLayout, password: string): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: layout.bin, LANG: 'C.UTF-8', SHELL: '/bin/false', HOME: layout.home, TMPDIR: layout.temporary,
    XDG_CONFIG_HOME: layout.config, XDG_DATA_HOME: layout.data, XDG_STATE_HOME: layout.state, XDG_CACHE_HOME: layout.cache,
    OPENCODE_PASSWORD: password, OPENCODE_CONFIG: layout.configFile,
    OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_FILEWATCHER_DISABLE: '1',
    OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
  });
}

/** The two configuration sources a locked server may report: its private XDG directory and our document. */
export function expectedConfigSources(layout: NativeLayout): ReadonlyArray<Readonly<{ type: string; path: string }>> {
  return [{ type: 'directory', path: join(layout.config, 'opencode') }, { type: 'document', path: layout.configFile }];
}
