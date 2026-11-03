import { isAbsolute, join, normalize } from 'node:path';

export const endpoint = 'https://cli-chat-proxy.grok.com/v1/models';
export const nativeIdentity = Object.freeze({ executable: '/usr/local/bin/grok', bytes: 166639048,
  sha256: '3aa36883574b263088e5addffe241f55430e8daaee1a0c4934b02180007a9761' });
export const limits = Object.freeze({ overallMs: 45_000, requestMs: 30_000, cleanupMs: 30_000, eofGraceMs: 10_000, termGraceMs: 2000,
  outboundRequests: 4, inboundMessages: 128, inboundFrameBytes: 256 * 1024, outboundFrameBytes: 64 * 1024,
  debugBytes: 1024 * 1024, debugLineBytes: 16 * 1024, projectedEvents: 64, projectedBytes: 16 * 1024,
  resultBytes: 256 * 1024, configBytes: 16 * 1024, credentialBytes: 64 * 1024 });
export const failureCodes = Object.freeze(['configuration', 'native_identity', 'spawn', 'request_timeout', 'observation_timeout',
  'protocol', 'request_limit', 'inbound_limit', 'frame_limit', 'debug_limit', 'projection_limit', 'native_request',
  'remote_fetch_failed', 'remote_unproven', 'authentication', 'catalog_invalid', 'cancelled', 'native_exit', 'cleanup_incomplete']);
export const eventKinds = Object.freeze(['http_fetch_started', 'http_fetch_completed', 'prefetch_completed',
  'remote_fetch_failed', 'fallback', 'manager_success', 'catalog_requested', 'catalog_observed']);

export class CatalogGuestError extends Error {
  constructor(code) { super('Native catalog qualification did not satisfy its bounded contract.'); this.name = 'CatalogGuestError'; this.code = code; }
}
export function reject(code = 'protocol') { throw new CatalogGuestError(code); }
function object(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) reject();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (required.some((key) => !Object.hasOwn(fields, key))
    || Object.keys(fields).some((key) => ![...required, ...optional].includes(key)
      || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable)) reject();
  return value;
}
function array(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length) reject();
  return value;
}
function text(value, maximum, identifier = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length === 0 || Buffer.byteLength(value) > maximum
    || /[\p{Cc}\p{Cf}]/u.test(value) || (identifier && (!/^[a-zA-Z0-9._:/+-]+$/u.test(value) || value.trim() !== value))) reject();
  return value;
}
function integer(value, maximum) { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) reject(); return value; }
function boolean(value) { if (typeof value !== 'boolean') reject(); return value; }
function member(value, values) { if (!values.includes(value)) reject(); return value; }
function path(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value === '/'
    || Buffer.byteLength(value) > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) reject('configuration');
  return value;
}

export function parseGuestConfig(value) {
  object(value, ['format', 'observation', 'native', 'profile', 'project', 'authFile']);
  member(value.format, ['agenai.native-catalog-guest-config.v1']); member(value.observation, ['native', 'scripted']);
  object(value.native, ['executable', 'sha256', 'bytes']); path(value.native.executable);
  if (!/^[a-f0-9]{64}$/u.test(value.native.sha256)) reject('configuration'); integer(value.native.bytes, 512 * 1024 ** 2);
  if (value.observation === 'native' && Object.keys(nativeIdentity).some((key) => value.native[key] !== nativeIdentity[key])) reject('native_identity');
  path(value.profile); path(value.project); path(value.authFile);
  if (value.profile === value.project || value.authFile.startsWith(value.profile + '/') || value.authFile.startsWith(value.project + '/')) reject('configuration');
  return structuredClone(value);
}

export function nativeLaunch(config) {
  const exclusions = Object.fromEntries(['CLAUDE', 'CURSOR', 'CODEX'].flatMap((vendor) =>
    (vendor === 'CODEX' ? ['SESSIONS'] : ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS', 'SESSIONS'])
      .map((surface) => [`GROK_${vendor}_${surface}_ENABLED`, '0'])));
  return { executable: config.native.executable,
    args: ['--debug', '--debug-file', join(config.profile, 'catalog-diagnostic.log'), '--no-auto-update', 'agent', '--no-leader', 'stdio'],
    cwd: config.project, env: { HOME: '/home/sandbox', TMPDIR: '/tmp',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      GROK_HOME: config.profile, GROK_AUTH_PATH: config.authFile, HTTP_PROXY: 'http://127.0.0.1:3128', HTTPS_PROXY: 'http://127.0.0.1:3128',
      GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: 'false', GROK_TRACE_UPLOAD: 'false', GROK_INSTRUMENTATION: 'disabled',
      GROK_FOLDER_TRUST: '0', GROK_AUTO_WAKE: '0', GROK_WORKER_THREADS: '1', GROK_SUBAGENT_WORKER_THREADS: '1', GROK_GIX_STATUS_THREADS: '1', ...exclusions } };
}

export function parseCatalog(value) {
  try {
    const state = value?.result;
    if (state === null || typeof state !== 'object' || Array.isArray(state)) reject();
    const currentModelId = text(state.currentModelId, 256, true);
    const ids = new Set(); const availableModels = array(state.availableModels, 256).map((model) => {
      if (model === null || typeof model !== 'object' || Array.isArray(model)) reject();
      const modelId = text(model.modelId, 256, true); if (ids.has(modelId)) reject(); ids.add(modelId);
      const projected = { modelId, name: text(model.name, 200) };
      if (model._meta != null) {
        const meta = model._meta; if (typeof meta !== 'object' || Array.isArray(meta)) reject();
        const output = {};
        if (meta.totalContextTokens !== undefined) output.totalContextTokens = integer(meta.totalContextTokens, Number.MAX_SAFE_INTEGER);
        if (meta.agentType !== undefined) output.agentType = text(meta.agentType, 128, true);
        if (meta.supportsReasoningEffort !== undefined) output.supportsReasoningEffort = boolean(meta.supportsReasoningEffort);
        if (meta.reasoningEffort !== undefined) output.reasoningEffort = text(meta.reasoningEffort, 128, true);
        if (meta.reasoningEfforts !== undefined) {
          const options = new Set();
          output.reasoningEfforts = array(meta.reasoningEfforts, 7).map((option) => {
            if (option === null || typeof option !== 'object' || Array.isArray(option)) reject();
            const id = text(option.id, 128, true); if (options.has(id)) reject(); options.add(id);
            const selected = { id, value: text(option.value, 128, true), default: boolean(option.default) };
            if (option.label !== undefined) selected.label = text(option.label, 200);
            if (option.description !== undefined) selected.description = text(option.description, 1024);
            return selected;
          });
        }
        if (Object.keys(output).length) projected._meta = output;
      }
      return projected;
    });
    if (!ids.has(currentModelId)) reject();
    return { currentModelId, availableModels, grok47Advertised: ids.has('grok-4.7') };
  } catch { reject('catalog_invalid'); }
}

export function refreshConfirmed(events) {
  let stage = 0; let requested = false; let invalidated = false; let observed = null;
  for (const event of events) {
    if (observed !== null) continue;
    if (event.kind === 'catalog_requested') {
      if (requested || stage !== 3) return false;
      requested = true; continue;
    }
    if (event.kind === 'catalog_observed') {
      if (!requested) return false;
      observed = stage === 3 && !invalidated; continue;
    }
    if (requested && ['http_fetch_started', 'http_fetch_completed', 'prefetch_completed', 'remote_fetch_failed', 'fallback'].includes(event.kind)) invalidated = true;
    if (event.kind === 'http_fetch_started') stage = 1;
    else if (event.kind === 'http_fetch_completed') stage = stage === 1 ? 2 : 0;
    else if (event.kind === 'prefetch_completed') stage = stage === 2 ? 3 : 0;
    else if (event.kind === 'remote_fetch_failed' || event.kind === 'fallback') stage = 0;
  }
  return observed ?? (stage === 3 && !requested);
}

export function parseGuestResult(value) {
  object(value, ['format', 'observation', 'status', 'runtime', 'transport', 'refresh', 'authentication', 'catalog', 'requests', 'modelTasks', 'termination', 'cleanup', 'failure']);
  member(value.format, ['agenai.native-catalog-guest.v1']); member(value.observation, ['native', 'scripted']); member(value.status, ['passed', 'failed', 'unproven']);
  object(value.runtime, ['node', 'platform', 'architecture', 'uid', 'gid']);
  if (!/^v\d+\.\d+\.\d+$/u.test(value.runtime.node)) reject(); member(value.runtime.platform, ['linux', 'darwin']); member(value.runtime.architecture, ['x64', 'arm64']);
  for (const id of [value.runtime.uid, value.runtime.gid]) if (!Number.isSafeInteger(id) || id < 0 || id > 2 ** 31 - 1) reject();
  if (value.observation === 'native' && value.status === 'passed' && (value.runtime.node !== 'v24.18.0' || value.runtime.platform !== 'linux'
    || value.runtime.architecture !== 'arm64' || value.runtime.uid !== 65534 || value.runtime.gid !== 65534)) reject('native_identity');
  object(value.transport, ['status', 'protocolVersion']); member(value.transport.status, ['initialized', 'failed', 'not_started']); member(value.transport.protocolVersion, [1, null]);
  object(value.refresh, ['status', 'endpoint', 'events']); member(value.refresh.status, ['confirmed', 'failed', 'unproven']); member(value.refresh.endpoint, [endpoint]);
  const events = array(value.refresh.events, limits.projectedEvents).map((event, index) => {
    object(event, ['sequence', 'kind', 'count']); if (event.sequence !== index + 1) reject(); member(event.kind, eventKinds);
    if (['http_fetch_completed', 'prefetch_completed'].includes(event.kind)) integer(event.count, 65535);
    else if (event.count !== null) reject();
    return { ...event };
  });
  if (Buffer.byteLength(JSON.stringify(events)) > limits.projectedBytes) reject('projection_limit');
  object(value.authentication, ['status', 'method', 'cachedTokenAdvertised', 'cachedTokenRequested', 'acknowledged']);
  const auth = value.authentication; member(auth.status, ['acknowledged', 'failed', 'not_attempted']); member(auth.method, ['cached_token', 'grok.com', 'oidc', null]);
  boolean(auth.cachedTokenAdvertised); boolean(auth.cachedTokenRequested); boolean(auth.acknowledged);
  if (auth.cachedTokenRequested && !auth.cachedTokenAdvertised) reject();
  if (auth.acknowledged !== (auth.status === 'acknowledged') || (auth.acknowledged && auth.method === null)) reject();
  const requests = array(value.requests, limits.outboundRequests);
  const ordered = auth.cachedTokenRequested ? ['initialize', 'authenticate', '_x.ai/auth/info', '_x.ai/models/list'] : ['initialize', '_x.ai/auth/info', '_x.ai/models/list'];
  if (requests.some((method, index) => method !== ordered[index]) || value.modelTasks !== 0) reject();
  object(value.termination, ['code', 'signal', 'forced']);
  const termination = value.termination;
  if (termination.code !== null && (!Number.isSafeInteger(termination.code) || termination.code < -4096 || termination.code > 255)) reject();
  member(termination.signal, [null, 'SIGTERM', 'SIGKILL', 'other']); boolean(termination.forced);
  if (termination.signal !== null && termination.code !== null) reject();
  object(value.cleanup, ['nativeJoined', 'stdoutJoined', 'stderrJoined']); Object.values(value.cleanup).forEach(boolean);
  if (value.failure !== null) member(value.failure, failureCodes);
  let catalog = null;
  if (value.catalog !== null) {
    object(value.catalog, ['currentModelId', 'availableModels', 'grok47Advertised']);
    for (const model of array(value.catalog.availableModels, 256)) {
      object(model, ['modelId', 'name'], ['_meta']);
      if (model._meta !== undefined) {
        object(model._meta, [], ['totalContextTokens', 'agentType', 'supportsReasoningEffort', 'reasoningEffort', 'reasoningEfforts']);
        if (model._meta.reasoningEfforts !== undefined) for (const option of array(model._meta.reasoningEfforts, 7)) object(option, ['id', 'value', 'default'], ['label', 'description']);
      }
    }
    catalog = parseCatalog({ result: value.catalog });
    if (catalog.grok47Advertised !== value.catalog.grok47Advertised) reject('catalog_invalid');
  }
  const requested = events.filter((event) => event.kind === 'catalog_requested').length;
  const observed = events.filter((event) => event.kind === 'catalog_observed').length;
  if (requested > 1 || observed > 1 || observed > requested || (requested === 1 && !requests.includes('_x.ai/models/list'))) reject();
  if (observed === 1 && events.at(-1).kind !== 'catalog_observed') reject();
  const confirmed = refreshConfirmed(events) && observed === 1;
  if (value.refresh.status === 'confirmed' && !confirmed) reject();
  if (value.status === 'passed' && (value.failure !== null || value.transport.status !== 'initialized' || value.transport.protocolVersion !== 1
    || value.refresh.status !== 'confirmed' || !auth.acknowledged || (auth.cachedTokenAdvertised && !auth.cachedTokenRequested)
    || requests.length !== ordered.length || catalog === null || termination.code !== 0 || termination.signal !== null || termination.forced
    || Object.values(value.cleanup).some((joined) => !joined))) reject();
  if (value.status !== 'passed' && value.failure === null) reject();
  const result = { format: value.format, observation: value.observation, status: value.status, runtime: { ...value.runtime }, transport: { ...value.transport },
    refresh: { status: value.refresh.status, endpoint, events }, authentication: { ...auth }, catalog, requests: [...requests], modelTasks: 0,
    termination: { ...termination }, cleanup: { ...value.cleanup }, failure: value.failure };
  if (Buffer.byteLength(JSON.stringify(result)) > limits.resultBytes) reject('frame_limit');
  return result;
}
