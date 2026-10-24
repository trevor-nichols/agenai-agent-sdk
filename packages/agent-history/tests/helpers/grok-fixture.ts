import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrotliDecompress } from 'node:zlib';
import { createAcpClient, createAcpExtensionRegistry, type AcpClient, type AcpExtensionDefinition,
  type AcpJsonValue, type AcpRequestOptions } from '@agen-ai/acp-transport';

export const GROK_NATIVE_VERSION = '1.0.62';
export const GROK_NATIVE_SHA256 = '2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa';
export const GROK_FIXTURE_IDS = {
  alpha: '70000001-1111-4111-8111-111111111111', beta: '70000002-1111-4111-8111-111111111111',
  child: '70000003-1111-4111-8111-111111111111', empty: '70000004-1111-4111-8111-111111111111',
  foreign: '70000005-1111-4111-8111-111111111111', oversized: '70000006-1111-4111-8111-111111111111',
  missing: '70000007-1111-4111-8111-111111111111',
  mixed: '70000008-1111-4111-8111-111111111111',
} as const;
export const GROK_FIXTURE_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=';

export interface GrokFixture {
  readonly root: string;
  readonly nativeHome: string;
  readonly temporaryRoot: string;
  readonly projectPath: string;
  readonly otherProjectPath: string;
  readonly executable: string;
  readonly label: string;
  readonly ids: typeof GROK_FIXTURE_IDS;
  cleanup(): Promise<void>;
}

export interface GrokFixtureConnection {
  readonly client: AcpClient;
  readonly initialization: AcpJsonValue;
  readonly pid: number;
  readonly methods: readonly string[];
  request(method: string, params: AcpJsonValue, options?: AcpRequestOptions): Promise<AcpJsonValue>;
  close(): Promise<void>;
}

export async function grokFixtureSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function materializeGrokFixtureExecutable(directory: string): Promise<string> {
  const require = createRequire(import.meta.url);
  const wrapper = require.resolve('@xai-official/grok/package.json');
  const platform = require.resolve('@xai-official/grok-linux-x64/package.json', { paths: [dirname(wrapper)] });
  for (const path of [wrapper, platform]) {
    const manifest: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (manifest === null || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== GROK_NATIVE_VERSION) {
      throw new Error('Grok fixture requires the exact official 1.0.62 wrapper and Linux x64 platform payload.');
    }
  }
  const compressed = join(dirname(platform), 'bin', 'grok.br');
  if ((await stat(compressed)).size !== 54_382_343
    || await grokFixtureSha256(compressed) !== '06187c2fa2d9ef531328ed24fd0239ec95f163cecaebcad610ba9d37a9e9db5f') {
    throw new Error('The official Grok fixture compressed payload differs from the qualified artifact.');
  }
  const executable = join(directory, 'grok');
  const digest = createHash('sha256');
  let bytes = 0;
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.byteLength;
    if (bytes > 191_715_904) { callback(new Error('Grok fixture executable exceeds its exact qualified size.')); return; }
    digest.update(chunk); callback(null, chunk);
  } });
  try {
    await pipeline(createReadStream(compressed), createBrotliDecompress(), bounded,
      createWriteStream(executable, { flags: 'wx', mode: 0o700 }));
    if (bytes !== 191_715_904 || digest.digest('hex') !== GROK_NATIVE_SHA256) throw new Error('Grok fixture executable identity differs from qualification.');
    await chmod(executable, 0o700);
    return executable;
  } catch (error) { await rm(executable, { force: true }); throw error; }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
}

export async function openGrokFixtureConnection(fixture: GrokFixture, historyExtensions?: readonly AcpExtensionDefinition[], cwd?: string,
  maxOutboundFrameBytes = 2_097_152): Promise<GrokFixtureConnection> {
  const operationRoot = await mkdtemp(join(fixture.temporaryRoot, 'setup-'));
  const environment: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    GROK_HOME: fixture.nativeHome, DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true' };
  for (const [key, name] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache',
    XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state', TMPDIR: 'tmp' })) {
    const path = join(operationRoot, name);
    await mkdir(path, { mode: 0o700 }); environment[key] = path;
  }
  const child = spawn('/usr/bin/prlimit', ['--as=4294967296', '--cpu=20', '--nofile=256', '--core=0', '--',
    '/usr/bin/bwrap', '--die-with-parent', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/',
    '--bind', fixture.root, fixture.root, '--proc', '/proc', '--dev', '/dev', '--chdir', cwd ?? operationRoot,
    fixture.executable, 'agent', '--no-leader', 'stdio'],
  { cwd: operationRoot, env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let processFailure: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('error', (error) => { processFailure = error; });
    child.once('close', () => resolve());
  });
  let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 65_536) signalGroup(child.pid, 'SIGKILL');
  });
  const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const definition = (name: string): AcpExtensionDefinition => ({
    method: `_x.ai/session/${name}`, direction: 'outbound_request' as const, validateParams: object, validateResult: object,
  });
  const extensions = createAcpExtensionRegistry([definition('import'), definition('load_history'),
    { method: '_x.ai/mcp/list', direction: 'outbound_request', validateParams: object, validateResult: object },
    ...(historyExtensions ?? [definition('state'), definition('updates')])]);
  const client = createAcpClient({ stdout: child.stdout, stdin: child.stdin, schemaChannel: 'stable',
    schemaProfile: 'schema-v1.23.0', unknownExtensionPolicy: 'standard', extensions,
    limits: { maxInboundFrameBytes: 1_048_576, maxOutboundFrameBytes, maxOutboundBufferedBytes: Math.max(8_388_609, maxOutboundFrameBytes + 1), maxOutstandingRequests: 1 } });
  const methods: string[] = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await client.dispose();
    signalGroup(child.pid, 'SIGTERM');
    const timer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 500);
    try { await exited; signalGroup(child.pid, 'SIGKILL'); }
    finally { clearTimeout(timer); await rm(operationRoot, { recursive: true, force: true }); }
  })();
  const request = (method: string, params: AcpJsonValue, options?: AcpRequestOptions) => {
    methods.push(method);
    return client.request(method, params, options?.lifetime === 'until_settled' ? options : { timeoutMs: 10_000, ...options });
  };
  try {
    const initialization = await request('initialize', { protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'agenai-native-history-fixture', version: '0.0.0' } });
    if (processFailure) throw processFailure;
    if (child.pid === undefined) throw new Error('The Grok fixture process did not start.');
    return { client, initialization, pid: child.pid, methods, request, close };
  } catch (error) { await close(); throw error; }
}

export async function grokFixtureDigests(root: string): Promise<readonly [string, string][]> {
  const files: [string, string][] = [];
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path, relative);
      else if (entry.isFile()) files.push([relative, await grokFixtureSha256(path)]);
      else throw new Error('Native fixture storage must contain only regular files and directories.');
    }
  }
  await visit(root, '');
  return files.sort(([first], [second]) => first.localeCompare(second));
}

export async function poisonGrokFixtureConfiguration(fixture: GrokFixture): Promise<{ readonly marker: string; readonly mcpCatalog: AcpJsonValue }> {
  const marker = join(fixture.root, 'mcp-command-entered');
  await mkdir(join(fixture.projectPath, '.grok'), { recursive: true });
  await writeFile(join(fixture.nativeHome, 'config.toml'), `[mcp_servers.history-canary]\ncommand = "/usr/bin/touch"\nargs = [${JSON.stringify(marker)}]\n`);
  await writeFile(join(fixture.projectPath, '.mcp.json'), JSON.stringify({ mcpServers: {
    'project-history-canary': { command: '/usr/bin/touch', args: [marker] },
  } }));
  const connection = await openGrokFixtureConnection(fixture, undefined, fixture.projectPath);
  let mcpCatalog: AcpJsonValue;
  try { mcpCatalog = await connection.request('_x.ai/mcp/list', { cache: true }); }
  finally { await connection.close(); }
  await rm(marker, { force: true });
  await writeFile(join(fixture.nativeHome, 'config.toml'), 'this = [\n');
  await writeFile(join(fixture.projectPath, '.grok', 'config.toml'), 'this = [\n');
  await writeFile(join(fixture.projectPath, '.mcp.json'), '{invalid-json');
  return { marker, mcpCatalog };
}

function update(sessionId: string, sessionUpdate: string, text: string, index: number, eventId?: string): AcpJsonValue {
  const isoTimestamp = `2026-10-21T00:00:${String(index).padStart(2, '0')}Z`;
  return { timestamp: index === 5 ? Date.parse(isoTimestamp) / 1000 : isoTimestamp, method: 'session/update',
    params: { sessionId, update: { sessionUpdate, content: { type: 'text', text } },
      ...(eventId === undefined ? {} : { _meta: { eventId } }) } };
}

export async function createGrokFixture(options: { readonly executable?: string; readonly label?: string;
  readonly oversizedBytes?: number; readonly mixed?: boolean } = {}): Promise<GrokFixture> {
  const root = await mkdtemp(join(tmpdir(), 'agent-grok-history-'));
  const nativeHome = join(root, 'native-home'), temporaryRoot = join(root, 'workers');
  const projectPath = join(root, 'project'), otherProjectPath = join(root, 'other-project');
  try {
    const executable = options.executable ?? await materializeGrokFixtureExecutable(root);
    if (await grokFixtureSha256(executable) !== GROK_NATIVE_SHA256) throw new Error('Grok fixture requires the exact qualified 1.0.62 Linux executable.');
    const fixture: GrokFixture = { root, nativeHome, temporaryRoot, projectPath, otherProjectPath,
      executable, label: options.label ?? 'STORE-A', ids: GROK_FIXTURE_IDS,
      cleanup: () => rm(root, { recursive: true, force: true }) };
    await Promise.all([nativeHome, temporaryRoot, projectPath, otherProjectPath].map((path) => mkdir(path, { mode: 0o700 })));
    const connection = await openGrokFixtureConnection(fixture, undefined, undefined,
      Math.max(2_097_152, (options.oversizedBytes ?? 0) + 65_536));
    try {
      const specs: { key: 'alpha' | 'beta' | 'child' | 'empty' | 'foreign' | 'oversized' | 'mixed'; title: string; seconds: number }[] = [
        { key: 'alpha', title: 'Alpha', seconds: 1 }, { key: 'beta', title: 'Beta', seconds: 2 },
        { key: 'child', title: 'Child', seconds: 3 }, { key: 'empty', title: 'Empty', seconds: 4 },
        { key: 'foreign', title: 'Foreign', seconds: 5 },
      ];
      if (options.oversizedBytes !== undefined) specs.push({ key: 'oversized', title: 'Oversized', seconds: 6 });
      if (options.mixed) specs.push({ key: 'mixed', title: 'Mixed stored updates', seconds: 7 });
      for (const spec of specs) {
        const key = spec.key;
        const id = GROK_FIXTURE_IDS[key];
        const cwd = key === 'foreign' ? otherProjectPath : projectPath;
        const updates: AcpJsonValue[] = key === 'empty' ? [] : key === 'oversized'
          ? [update(id, 'user_message_chunk', 'oversizedbodyneedle ' + 'x'.repeat(Math.max(0, (options.oversizedBytes ?? 0) - 'oversizedbodyneedle '.length)), 0)]
          : Array.from({ length: 6 }, (_, index) => update(id, index % 2 === 0 ? 'user_message_chunk' : 'agent_message_chunk',
            `${fixture.label} ${spec.title} message ${index}`, index, key === 'alpha' && index === 0 ? `${id}-1` : undefined));
        if (key === 'alpha') updates.splice(1, 0, update(id, 'user_message_chunk', `${fixture.label} Alpha adjacent chunk`, 0));
        if (key === 'beta') updates.push({ timestamp: '2026-10-21T00:00:10Z', method: '_x.ai/session/update', params: {
          sessionId: id, update: { sessionUpdate: 'rewind_marker', target_prompt_index: 1, created_at: '2026-10-21T00:00:10Z' },
        } }, update(id, 'user_message_chunk', `${fixture.label} Beta replacement`, 11),
        update(id, 'agent_message_chunk', `${fixture.label} Beta replacement answer`, 12));
        if (key === 'mixed') {
          const mixed: AcpJsonValue[] = [
            { sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: 'image/png', data: GROK_FIXTURE_IMAGE_BASE64 } },
            { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Synthetic retained thought' } },
            { sessionUpdate: 'tool_call', toolCallId: 'stored-tool-call-1', title: 'Stored tool display title',
              rawInput: { path: '/synthetic/never-executed.txt' }, kind: 'read', status: 'pending' },
            { sessionUpdate: 'tool_call_update', toolCallId: 'stored-tool-call-1', status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: 'Synthetic retained tool output' } }] },
            { sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'A'.repeat(9000) } },
            { sessionUpdate: 'future_stored_fixture_kind' },
            { sessionUpdate: 'tool_call', toolCallId: 'stored-long-title-2', title: 't'.repeat(300), status: 'pending' },
          ];
          updates.splice(0, updates.length, ...mixed.map((value, index) => ({ timestamp: `2026-10-21T00:00:0${index}Z`,
            method: 'session/update', params: { sessionId: id, update: value } })));
        }
        const result = await connection.request('_x.ai/session/import', { sessionId: id, cwd, updates,
          state: { summary: { info: { id, cwd }, session_summary: `${fixture.label} ${spec.title}`,
            created_at: '2026-10-21T00:00:00Z', updated_at: `2026-10-21T00:00:0${spec.seconds}Z`,
            num_messages: updates.length, current_model_id: 'grok-4.3',
            ...(key === 'child' ? { parent_session_id: GROK_FIXTURE_IDS.alpha, session_kind: 'subagent' } : {}),
          } } });
        if (result === null || typeof result !== 'object' || Array.isArray(result) || result.imported !== true) {
          throw new Error('Official native Grok import did not create the owned fixture session.');
        }
      }
    } finally { await connection.close(); }
    return fixture;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

/** Withhold one real native mutation receipt while retaining the real prlimit/Bubblewrap launch. */
export async function createGrokResponseLossLauncher(fixture: GrokFixture) {
  const executable = join(fixture.root, 'response-loss-launcher.mjs'), trace = join(fixture.root, 'mutation-native-receipts.jsonl');
  const script = `#!${process.execPath}
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const trace=${JSON.stringify(trace)};
const child=spawn('/usr/bin/prlimit',process.argv.slice(2),{stdio:['pipe','pipe','inherit',3],env:process.env});
let input='',output='';const mutations=new Map();
process.stdin.on('data',chunk=>{input+=chunk.toString('utf8');if(input.length>32768)process.exit(72);let end;while((end=input.indexOf('\\n'))>=0){const line=input.slice(0,end);input=input.slice(end+1);const request=JSON.parse(line);if(request.method==='_x.ai/session/rename'||request.method==='_x.ai/session/delete')mutations.set(request.id,request.method);child.stdin.write(line+'\\n');}});
child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>1048576)process.exit(73);let end;while((end=output.indexOf('\\n'))>=0){const line=output.slice(0,end);output=output.slice(end+1);const response=JSON.parse(line);const method=mutations.get(response.id);if(method){appendFileSync(trace,JSON.stringify({method,result:response.result})+'\\n');mutations.delete(response.id);}else process.stdout.write(line+'\\n');}});
child.on('error',()=>process.exit(74));child.on('close',code=>process.exit(code??75));
`;
  await writeFile(executable, script, { flag: 'wx', mode: 0o700 });
  return { executable, trace };
}

export async function waitForGrokWithheldReceipt(trace: string): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    try { if ((await readFile(trace, 'utf8')).endsWith('\n')) return; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await delay(10);
  }
  throw new Error('The real native mutation did not produce a withheld receipt within the fixture deadline.');
}

export async function createGrokMutationLaunchFailure(fixture: GrokFixture) {
  const executable = join(fixture.root, 'mutation-launch-failure.mjs'), trace = join(fixture.root, 'rejected-mutation-launches');
  await writeFile(executable, `#!${process.execPath}
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
if(process.argv.includes('--bind-fd')){appendFileSync(${JSON.stringify(trace)},'native-not-launched\\n');process.exit(76);}
const child=spawn('/usr/bin/prlimit',process.argv.slice(2),{stdio:['inherit','inherit','inherit',3],env:process.env});
child.on('error',()=>process.exit(77));child.on('close',code=>process.exit(code??78));
`, { flag: 'wx', mode: 0o700 });
  return { executable, trace };
}
