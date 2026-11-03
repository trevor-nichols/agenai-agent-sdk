import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const target = 'xai_grok_shell::remote::model_source::oai';
const prefetch = 'xai_grok_shell::agent::remote_config::fetch';
const manager = 'xai_grok_shell::agent::remote_config::manager';
const url = 'https://cli-chat-proxy.grok.com/v1/models';
const line = (level, source, message) => `2026-11-03T15:00:00.123456Z  ${level} ${source}: ${message}\n`;
const catalog = { result: { currentModelId: 'grok-4.7', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7',
  description: 'PRIVATE-UNRETAINED-CATALOG-FIELD', _meta: { totalContextTokens: 500000, agentType: 'grok-build-plan',
    supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: [{ id: 'high', value: 'high', label: 'High', default: true }] } }] } };

export async function scriptedPeer(scenario) {
  const args = process.argv.slice(2); const log = args[args.indexOf('--debug-file') + 1];
  const trace = `${process.env.GROK_HOME}/methods.jsonl`;
  const send = (id, result, extra = '') => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n' + extra);
  const append = (data) => appendFileSync(log, data, { mode: 0o600 });
  const success = () => append(line('INFO', target, `Fetching models from ${url}`)
    + line('INFO', target, `Fetched 300 models from ${url}`)
    + line('INFO', prefetch, 'Prefetched models count=280 etag=Some("PRIVATE-UNRETAINED-ETAG")'));
  const input = createInterface({ input: process.stdin });
  for await (const raw of input) {
    const message = JSON.parse(raw); appendFileSync(trace, JSON.stringify(message) + '\n', { mode: 0o600 });
    if (message.method === 'initialize') {
      if (scenario === 'malformed') { process.stdout.write('{invalid native frame}\n'); continue; }
      if (scenario === 'oversized') { process.stdout.write('x'.repeat(256 * 1024 + 1) + '\n'); continue; }
      if (scenario === 'cancel') { await new Promise((resolve) => process.stdin.once('end', resolve)); break; }
      send(message.id, { protocolVersion: 1, agentInfo: { name: 'Grok', version: '1.0.70' },
        authMethods: scenario === 'no-cache' ? [] : [{ id: 'cached_token', name: 'Cached access' }],
        _meta: { privateAccount: 'PRIVATE-UNRETAINED-INITIALIZATION', plausibleFallbackCatalog: { currentModelId: 'grok-4.6', availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6' }] } } });
    } else if (message.method === 'authenticate') send(message.id, { privateAccount: 'PRIVATE-UNRETAINED-AUTHENTICATE' });
    else if (message.method === '_x.ai/auth/info') {
      const account = JSON.parse(readFileSync(process.env.GROK_AUTH_PATH, 'utf8'))[scope];
      send(message.id, { methodId: 'cached_token', email: scenario === 'wrong-account' ? 'other@example.invalid' : account.email,
        principalType: account.principal_type ?? null, principalId: account.principal_id ?? null,
        teamId: account.team_id ?? null, organizationId: account.organization_id ?? null, firstName: 'PRIVATE-UNRETAINED-AUTH-INFO' });
      if (scenario === 'fallback') {
        append(line('WARN', prefetch, 'Failed to fetch models error=PRIVATE-UNRETAINED-HTTP-BODY'));
        append(line('WARN', manager, 'model catalog: falling back to bundled defaults only')); input.close(); process.stdin.destroy(); break;
      }
      if (scenario === 'unproven') {
        append(line('INFO', manager, 'model catalog: fetch succeeded model_count=2')); input.close(); process.stdin.destroy(); break;
      }
      if (scenario === 'log-limit') { append('x'.repeat(16 * 1024 + 1)); continue; }
      success();
    } else if (message.method === '_x.ai/models/list') {
      if (scenario === 'catalog-invalid') send(message.id, { result: { currentModelId: 'grok-4.7', availableModels: [] } });
      else if (scenario === 'terminal-request') send(message.id, catalog, JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'fs/read_text_file', params: { path: '/PRIVATE-UNRETAINED-PATH' } }) + '\n');
      else if (scenario === 'inbound-limit') send(message.id, catalog, Array.from({ length: 128 }, () => JSON.stringify({ jsonrpc: '2.0', method: 'notice', params: {} }) + '\n').join(''));
      else send(message.id, catalog);
      if (scenario === 'late-failure') append(line('WARN', prefetch, 'Failed to fetch models error=PRIVATE-UNRETAINED-LATE-FAILURE'));
      if (scenario === 'cleanup-failure') {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', process.stdout, process.stderr] });
        writeFileSync(`${process.env.GROK_HOME}/retained-producer.pid`, String(child.pid), { mode: 0o600 }); child.unref(); process.exit(0);
      }
    } else { process.stderr.write('PRIVATE-UNRETAINED-UNEXPECTED-METHOD'); process.exitCode = 2; break; }
  }
  if (scenario === 'graceful-delay') await new Promise((resolve) => setTimeout(resolve, 3000));
  if (scenario === 'forced-stop') await new Promise((resolve) => setTimeout(() => {
    append(line('WARN', prefetch, 'Failed to fetch models error=PRIVATE-UNRETAINED-DELAYED-FAILURE')); resolve();
  }, 20_000));
}
