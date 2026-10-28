// ------------------------------------------------------------------------------------------------
//                config.ts - Closed configuration and exact .273 spawn admission
// ------------------------------------------------------------------------------------------------

import type { Options, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { parseSandboxGuestPath } from '@agen-ai/sandbox';
import type { ClaudeSandboxRequest, ClaudeSandboxTool } from './types.js';

const keys = new Set(['credential', 'guestExecutable', 'model', 'tools', 'maxTurns', 'prompt', 'signal']);
const credentialKeys = new Set(['kind', 'value']);
const tools = new Set<ClaudeSandboxTool>(['Read', 'Write', 'Edit', 'Bash']);

export const guestEnvironment = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/home/sandbox', TMPDIR: '/tmp',
  LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CLAUDE_CONFIG_DIR: '/home/sandbox/.claude',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', DISABLE_ERROR_REPORTING: '1',
});

function invalid(): never { throw new TypeError('Unsupported or malformed contained Claude configuration.'); }

function plain(input: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const data: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    data[key] = descriptor.value;
  }
  return data;
}

function toolList(input: unknown): readonly ClaudeSandboxTool[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 4) invalid();
  if (Reflect.ownKeys(input).length !== input.length + 1) invalid();
  const result: ClaudeSandboxTool[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    const value: unknown = descriptor.value;
    if (value !== 'Read' && value !== 'Write' && value !== 'Edit' && value !== 'Bash') invalid();
    if (!tools.has(value) || result.includes(value)) invalid();
    result.push(value);
  }
  return Object.freeze(result);
}

export function parseClaudeSandboxRequest(input: unknown): ClaudeSandboxRequest {
  const data = plain(input, keys);
  const credential = plain(data.credential, credentialKeys);
  if (credential.kind !== 'api_key' || typeof credential.value !== 'string' || !credential.value.isWellFormed()
    || credential.value.length === 0 || /[\u0000\r\n]/u.test(credential.value) || Buffer.byteLength(credential.value) > 8192) invalid();
  if (typeof data.guestExecutable !== 'string' || data.guestExecutable === '/' || /\.(?:[cm]?js|[jt]sx?)$/iu.test(data.guestExecutable)) invalid();
  const guestExecutable = parseSandboxGuestPath(data.guestExecutable);
  if (typeof data.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(data.model)) invalid();
  if (typeof data.prompt !== 'string' || !data.prompt.isWellFormed() || Buffer.byteLength(JSON.stringify(data.prompt)) > 32 * 1024) invalid();
  if (typeof data.maxTurns !== 'number' || !Number.isSafeInteger(data.maxTurns) || data.maxTurns < 1 || data.maxTurns > 32) invalid();
  if (data.signal !== undefined && !(data.signal instanceof AbortSignal)) invalid();
  return Object.freeze({ credential: Object.freeze({ kind: 'api_key', value: credential.value }),
    guestExecutable, model: data.model, prompt: data.prompt, maxTurns: data.maxTurns,
    tools: toolList(data.tools), ...(data.signal === undefined ? {} : { signal: data.signal }) });
}

export function claudeOptions(request: ClaudeSandboxRequest, cwd: string, abortController: AbortController,
  egress: Readonly<Record<string, string>>): Options {
  return { abortController, pathToClaudeCodeExecutable: request.guestExecutable, cwd,
    env: { ...guestEnvironment, ...egress, ANTHROPIC_API_KEY: request.credential.value },
    model: request.model, maxTurns: request.maxTurns, tools: [...request.tools], allowedTools: [...request.tools],
    permissionMode: 'dontAsk', permissionPrompts: 'none', settingSources: [], skills: [], plugins: [],
    persistSession: false, mcpServers: {}, strictMcpConfig: true, thinking: { type: 'disabled' } };
}

export function admitSpawn(options: SpawnOptions, request: ClaudeSandboxRequest, cwd: string,
  egress: Readonly<Record<string, string>>): SpawnOptions {
  const expected = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--thinking', 'disabled', '--max-turns', String(request.maxTurns), '--model', request.model,
    '--permission-prompts', 'none', ...(request.tools.length ? ['--allowedTools', request.tools.join(',')] : []),
    '--tools', request.tools.join(','), '--setting-sources=', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence'];
  if (options.command !== request.guestExecutable || options.cwd !== cwd || options.args.length !== expected.length
    || options.args.some((value, index) => value !== expected[index])) throw new TypeError('Exact Claude SDK spawn command or arguments changed.');
  const environment = { ...guestEnvironment, ...egress, ANTHROPIC_API_KEY: request.credential.value,
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.273' };
  if (Reflect.ownKeys(options.env).length !== Object.keys(environment).length) throw new TypeError('Claude SDK spawn environment changed; values are not logged.');
  for (const [key, value] of Object.entries(environment)) {
    const descriptor = Object.getOwnPropertyDescriptor(options.env, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value !== value) {
      throw new TypeError('Claude SDK spawn environment changed; values are not logged.');
    }
  }
  return { command: request.guestExecutable, cwd, args: [...expected], env: environment, signal: options.signal };
}
