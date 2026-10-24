// ------------------------------------------------------------------------------------------------
//                mapping-probe.ts - Native request construction against a bounded loopback fixture
// ------------------------------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionId, parseAgentTurnId,
  type AgentConfigurationSelectionInput,
} from '@agen-ai/agent-protocol';
import { AgentProviderSessionCleanupError, createAgentProviderRegistry, type AgentProviderSession } from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import type { NativeExecutableLease, NativeLaunchCandidate, NativeProcessAllocation } from './launch-contracts.js';
import { NativeCleanupError, nativeRelease } from './launch.js';

const fakeApiKey = 'native-loopback-fixture-no-account-authority';
const responseText = 'NATIVE_LOOPBACK_MAPPING_OK';
const maximumRequestBytes = 1_048_576;
const maximumInferenceRequests = 4;

export interface NativeGrokModelFixture {
  readonly id: 'grok-4.3';
  readonly object: 'model';
  readonly context_length: 1_000_000;
  readonly capabilities: {
    readonly reasoning_effort: readonly ['none', 'low', 'medium', 'high', 'xhigh'];
    readonly default_reasoning_effort: 'low';
  };
  readonly aliases: readonly ['grok-4.3-latest'];
}

export interface NativeGrokRequestProjection {
  readonly endpoint: 'chat_completions' | 'responses';
  readonly requestKeys: readonly string[];
  readonly model?: string;
  readonly reasoning_effort?: string | null;
  readonly reasoning?: { readonly effort?: string | null } | null;
  readonly service_tier?: string | null;
}

export interface NativeGrokMappingProof {
  readonly format: 'grok-native-loopback-request-v1';
  readonly scope: 'pinned_native_request_builder_with_fake_api_key';
  readonly native: { readonly bytes: number; readonly sha256: string };
  readonly allocationId: string;
  readonly fixture: NativeGrokModelFixture;
  readonly environmentOverrides: readonly ['GROK_XAI_API_BASE_URL', 'XAI_API_KEY'];
  readonly credential: 'constant_fake_key_no_account_authority';
  readonly inferenceOrigin: 'explicit_loopback_fixture';
  readonly realModelInference: false;
  readonly modelsRequests: number;
  readonly nonInference404Responses: number;
  readonly requests: readonly NativeGrokRequestProjection[];
  readonly inferenceRequestLimit: 4;
  readonly explicitSdkTurns: number;
  readonly selections: readonly AgentConfigurationSelectionInput[];
  readonly providerExecutionStarted: boolean;
  readonly terminalCompleted: boolean;
  readonly fixtureResponseMatched: boolean;
  /** Retained only when the bounded native assistant output exactly matches the harmless fixture. */
  readonly observedResultText?: string;
  readonly standardMapping: 'verified_request_default' | 'unverified';
  readonly documentation: 'https://docs.x.ai/developers/advanced-api-usage/priority-processing';
  readonly productionBackendBillingCertified: false;
  readonly cleanup: 'closed';
  readonly failureCode?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('mapping_fixture_invalid_object');
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 128 || !/^[a-zA-Z0-9_.-]+$/u.test(value)) {
    throw new Error('mapping_fixture_invalid_allowlisted_field');
  }
  return value;
}

function projectRequest(body: unknown, endpoint: NativeGrokRequestProjection['endpoint']): NativeGrokRequestProjection {
  const object = record(body);
  const requestKeys = Object.keys(object).sort();
  if (requestKeys.length > 128 || requestKeys.some((key) => !/^[a-zA-Z0-9_]{1,64}$/u.test(key))) {
    throw new Error('mapping_fixture_invalid_request_keys');
  }
  let reasoning: NativeGrokRequestProjection['reasoning'];
  if (Object.hasOwn(object, 'reasoning')) {
    const value = object.reasoning;
    reasoning = value === null ? null : Object.hasOwn(record(value), 'effort')
      ? { effort: optionalString(record(value).effort) } : {};
  }
  const model = Object.hasOwn(object, 'model') ? optionalString(object.model) : undefined;
  if (model === null) throw new Error('mapping_fixture_invalid_model');
  return Object.freeze({ endpoint, requestKeys: Object.freeze(requestKeys),
    ...(model === undefined ? {} : { model }),
    ...(Object.hasOwn(object, 'reasoning_effort') ? { reasoning_effort: optionalString(object.reasoning_effort) } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(Object.hasOwn(object, 'service_tier') ? { service_tier: optionalString(object.service_tier) } : {}),
  });
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    bytes += chunk.length;
    if (bytes > maximumRequestBytes) throw new Error('mapping_fixture_request_byte_limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
  response.end(JSON.stringify(value));
}

function respondInference(response: ServerResponse, endpoint: NativeGrokRequestProjection['endpoint'], model: string): void {
  const events = endpoint === 'chat_completions' ? [
    { id: 'chatcmpl-native-loopback', object: 'chat.completion.chunk', created: 1_700_000_000, model,
      choices: [{ index: 0, delta: { role: 'assistant', content: responseText }, finish_reason: null }] },
    { id: 'chatcmpl-native-loopback', object: 'chat.completion.chunk', created: 1_700_000_000, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ] : [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_native_loopback', object: 'response',
      created_at: 1_700_000_000, model, status: 'in_progress', output: [] } },
    { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_native_loopback',
      output_index: 0, content_index: 0, delta: responseText },
    { type: 'response.completed', sequence_number: 2, response: { id: 'resp_native_loopback', object: 'response',
      created_at: 1_700_000_000, model, status: 'completed', output: [{ type: 'message', id: 'msg_native_loopback',
        role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: responseText, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
}

function safeFailure(error: unknown): string {
  if (error instanceof Error && /^mapping_[a-z_]+$/u.test(error.message)) return error.message;
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^(acp_|agent_)[a-z_]{1,100}$/u.test(error.code)) return error.code;
  return 'mapping_native_operation_failed';
}

/**
 * One fake-credential prompt against one loopback fixture. The caller owns the independently
 * allocated process home and executable lease, and releases them only after this function closes.
 * NativeCleanupError retains pending producer cleanup; its retry must succeed before those releases.
 * This observes native request construction; it does not attest production backend billing.
 */
export async function probeNativeGrokStandardMapping(input: {
  readonly candidate: NativeLaunchCandidate;
  readonly executable: NativeExecutableLease;
  readonly allocation: NativeProcessAllocation;
  readonly fixture: NativeGrokModelFixture;
  readonly signal?: AbortSignal;
}): Promise<NativeGrokMappingProof> {
  const { candidate, executable, allocation } = input;
  const proposedFixture = input.fixture;
  if (candidate.native.version !== '1.0.50' || candidate.native.sha256 !== executable.identity.sha256
    || candidate.native.bytes !== executable.identity.bytes || allocation.launch.executable !== executable.executable
    || allocation.role !== 'comparison' || proposedFixture.id !== 'grok-4.3' || proposedFixture.object !== 'model'
    || proposedFixture.context_length !== 1_000_000 || proposedFixture.capabilities.default_reasoning_effort !== 'low'
    || proposedFixture.capabilities.reasoning_effort.join(',') !== 'none,low,medium,high,xhigh'
    || proposedFixture.aliases.join(',') !== 'grok-4.3-latest'
    || allocation.launch.env?.XAI_API_KEY !== fakeApiKey) throw new Error('mapping_fixture_inputs_invalid');
  // Rebuild the allowlisted fixture rather than retaining caller-owned objects or extra fields.
  const fixture: NativeGrokModelFixture = Object.freeze({ id: 'grok-4.3', object: 'model', context_length: 1_000_000,
    capabilities: Object.freeze({ reasoning_effort: Object.freeze(['none', 'low', 'medium', 'high', 'xhigh'] as const),
      default_reasoning_effort: 'low' }), aliases: Object.freeze(['grok-4.3-latest'] as const) });
  input.signal?.throwIfAborted();
  await executable.assertUnchanged();
  const stop = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal;
  const timer = setTimeout(() => stop.abort(new Error('mapping_fixture_deadline')), 30_000);
  const requests: NativeGrokRequestProjection[] = [];
  const selections: AgentConfigurationSelectionInput[] = [];
  let modelsRequests = 0;
  let nonInference404Responses = 0;
  let totalRequests = 0;
  let inferenceRequests = 0;
  let failureCode: string | undefined;
  let providerExecutionStarted = false;
  let explicitSdkTurns = 0;
  let terminalCompleted = false;
  let assistantText = '';
  const handlers = new Set<Promise<void>>();
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 16_384 }, (request, response) => {
    const handling = (async () => {
      totalRequests += 1;
      if (totalRequests > 8) throw new Error('mapping_fixture_request_count_limit');
      if (request.method === 'GET' && request.url === '/v1/models') {
        modelsRequests += 1;
        respond(response, 200, { object: 'list', data: [{ id: fixture.id, object: fixture.object,
          context_length: fixture.context_length, capabilities: {
            reasoning_effort: [...fixture.capabilities.reasoning_effort],
            default_reasoning_effort: fixture.capabilities.default_reasoning_effort }, aliases: [...fixture.aliases] }] });
        return;
      }
      const endpoint = request.url === '/v1/chat/completions' ? 'chat_completions'
        : request.url === '/v1/responses' ? 'responses' : undefined;
      if (request.method !== 'POST' || !endpoint) {
        nonInference404Responses += 1;
        request.resume();
        respond(response, 404, { error: { message: 'No fixture route.' } });
        return;
      }
      inferenceRequests += 1;
      if (inferenceRequests > maximumInferenceRequests) throw new Error('mapping_fixture_inference_request_limit');
      const projected = projectRequest(await readRequest(request), endpoint);
      requests.push(projected);
      respondInference(response, endpoint, fixture.id);
    })().catch((error: unknown) => {
      failureCode ??= safeFailure(error);
      if (!response.headersSent) respond(response, 400, { error: { message: 'Native mapping fixture rejected the request.' } });
      else response.destroy();
      stop.abort(new Error(failureCode));
    });
    handlers.add(handling);
    void handling.finally(() => handlers.delete(handling));
  });
  server.maxRequestsPerSocket = 8;
  let registry: Awaited<ReturnType<typeof createAgentProviderRegistry>> | undefined;
  let session: AgentProviderSession | undefined;
  let operationError: unknown;
  let openingCleanup: AgentProviderSessionCleanupError | undefined;
  const closeFixture = nativeRelease(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await Promise.all(handlers);
  });
  const cleanup = nativeRelease(async () => {
    const failures: unknown[] = [];
    if (openingCleanup) {
      try { await openingCleanup.retryCleanup(); } catch (error) { failures.push(error); }
    }
    if (session) {
      try { await session.close({ reason: 'shutdown' }); } catch (error) { failures.push(error); }
    }
    if (registry) {
      try { await registry.dispose(); } catch (error) { failures.push(error); }
    }
    try { await closeFixture(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Native mapping probe cleanup remains pending.');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const driver = createNodeAcpProviderDriver({ providerKey: 'grok-native-loopback', configuration: 'selectable',
      launch: { ...allocation.launch, env: { ...allocation.launch.env, XAI_API_KEY: fakeApiKey,
        GROK_XAI_API_BASE_URL: baseUrl } },
      limits: { initializationTimeoutMs: 15_000, cancellationTimeoutMs: 2_000 },
    });
    const instanceId = parseAgentInstanceId('native-loopback:instance');
    registry = await createAgentProviderRegistry({ drivers: [driver],
      definitions: [{ instanceId, providerKey: driver.providerKey, driverConfiguration: {} }] });
    session = await registry.requireInstance(instanceId).adapter.createSession({
      sessionId: parseAgentSessionId('native-loopback:session'), workingDirectory: allocation.workingDirectory,
      configuration: { kind: 'selected', revision: parseAgentConfigurationRevisionId('native-loopback:configuration'),
        catalogRevision: 1, selections: [] }, onBindingCreated() {}, signal,
    });
    const configuration = session.configuration;
    if (configuration.kind !== 'selectable') throw new Error('mapping_configuration_unavailable');
    for (const [fieldLabel, valueLabel] of [['Model', fixture.id], ['Reasoning Effort', 'Low']] as const) {
      const catalog = await configuration.listConfiguration({ signal });
      const field = catalog.fields.find((entry) => entry.label === fieldLabel);
      if (field?.fieldKind !== 'single_select') throw new Error('mapping_configuration_field_unavailable');
      const option = field.options.find((entry) => entry.label === valueLabel);
      if (!option) throw new Error('mapping_configuration_option_unavailable');
      const selection: AgentConfigurationSelectionInput = { key: field.key,
        expectedCatalogRevision: catalog.revision, expectedFieldRevision: field.revision,
        value: { fieldKind: 'single_select', optionId: option.optionId } };
      const selected = await configuration.applyConfigurationSelection({ selection, signal });
      if (selected.status !== 'completed') throw new Error('mapping_configuration_selection_failed');
      selections.push(selection);
    }
    if (!modelsRequests) throw new Error('mapping_fixture_models_not_observed');
    explicitSdkTurns += 1;
    for await (const output of session.startTurn({ turnId: parseAgentTurnId('native-loopback:turn'),
      interactionMode: 'default', parts: [{ type: 'text', text: 'Return one short acknowledgement without calling tools.' }],
      signal, deadlineAt: new Date(Date.now() + 10_000).toISOString(), onProviderExecutionStarted() { providerExecutionStarted = true; },
    }).outputs) {
      if (output.kind !== 'event') continue;
      if (output.event.type === 'content.delta' && output.event.payload.streamKind === 'assistant_text') {
        assistantText += output.event.payload.delta;
        if (Buffer.byteLength(assistantText) > 1_024) throw new Error('mapping_fixture_output_byte_limit');
      }
      if (output.event.type === 'request.opened') throw new Error('mapping_fixture_unexpected_native_request');
      if (output.event.type === 'turn.completed') terminalCompleted = output.event.payload.outcome === 'completed';
    }
  } catch (error) {
    operationError = error;
    if (error instanceof AgentProviderSessionCleanupError) openingCleanup = error;
    failureCode ??= safeFailure(error);
  }
  finally {
    clearTimeout(timer);
    try { await cleanup(); }
    catch (cleanupError) {
      throw new NativeCleanupError(operationError, cleanupError, allocation.workingDirectory, cleanup);
    }
  }
  await executable.assertUnchanged();
  const request = requests[0];
  const fixtureResponseMatched = assistantText === responseText;
  const standardMapping = !failureCode && providerExecutionStarted && terminalCompleted && fixtureResponseMatched
    && explicitSdkTurns === 1 && requests.length > 0 && requests.length <= maximumInferenceRequests
    && request?.model === fixture.id && requests.every((entry) => entry.model === fixture.id
      && (entry.reasoning_effort === 'low' || entry.reasoning?.effort === 'low')
      && (entry.reasoning_effort === undefined || entry.reasoning_effort === 'low')
      && (entry.reasoning === undefined || entry.reasoning?.effort === 'low')
      && (entry.service_tier === undefined || entry.service_tier === 'default'))
    ? 'verified_request_default' : 'unverified';
  return Object.freeze({ format: 'grok-native-loopback-request-v1', scope: 'pinned_native_request_builder_with_fake_api_key',
    native: Object.freeze({ bytes: candidate.native.bytes, sha256: candidate.native.sha256 }),
    allocationId: allocation.allocationId, fixture, environmentOverrides: ['GROK_XAI_API_BASE_URL', 'XAI_API_KEY'] as const,
    credential: 'constant_fake_key_no_account_authority', inferenceOrigin: 'explicit_loopback_fixture', realModelInference: false,
    modelsRequests, nonInference404Responses, requests: Object.freeze(requests), selections: Object.freeze(selections), providerExecutionStarted,
    inferenceRequestLimit: maximumInferenceRequests, explicitSdkTurns,
    terminalCompleted, fixtureResponseMatched, ...(fixtureResponseMatched ? { observedResultText: assistantText } : {}), standardMapping,
    documentation: 'https://docs.x.ai/developers/advanced-api-usage/priority-processing', productionBackendBillingCertified: false,
    cleanup: 'closed', ...(failureCode === undefined ? {} : { failureCode }),
  });
}

export function nativeGrokMappingFixtureCredential(): string { return fakeApiKey; }
