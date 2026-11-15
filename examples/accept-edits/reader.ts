import type { AgentItemSnapshot, AgentRequest } from '@agen-ai/agent-protocol';
import type { AgentProviderTurnExecution } from '@agen-ai/agent-runtime';
import type { AcceptEditsRunConfig } from './config.js';
import { exactAction, onceResolution, type AcceptEditsDecider, type AcceptEditsDecision } from './decisions.js';
import { failureCode, type AcceptEditsReport, type AcceptEditsRequestRecord } from './report.js';
import type { RunStopper } from './stopper.js';

const toolItemKinds = new Set<AgentItemSnapshot['itemKind']>(['command_execution', 'file_change', 'mcp_tool_call', 'dynamic_tool_call',
  'collaboration_tool_call', 'web_search', 'browser_action', 'computer_action', 'image_view']);

type ReaderInput = Readonly<{
  execution: AgentProviderTurnExecution; config: AcceptEditsRunConfig; decide: AcceptEditsDecider;
  stopper: RunStopper; report: AcceptEditsReport;
}>;

/**
 * The sole output reader for the turn. Reaching a bound requests one interruption and keeps
 * draining; output beyond twice a bound is abandoned so the original owners can close the turn.
 * It records failures instead of rejecting, so callers can always join it.
 */
export async function readTurnOutputs(input: ReaderInput): Promise<void> {
  const { execution, config, stopper, report } = input;
  const toolItems = new Set<string>();
  try {
    for await (const output of execution.outputs) {
      report.output.events += 1;
      report.output.bytes += Buffer.byteLength(JSON.stringify(output));
      if (report.output.events > config.limits.maxOutputEvents || report.output.bytes > config.limits.maxOutputBytes) {
        stopper.stop('output_limit');
        if (report.output.events > 2 * config.limits.maxOutputEvents || report.output.bytes > 2 * config.limits.maxOutputBytes) break;
      }
      if (output.kind !== 'event') continue;
      const { event } = output;
      if (event.type === 'turn.completed') {
        report.turnOutcome = event.payload.outcome;
        if (event.payload.outcome === 'failed') report.failureCode ??= event.payload.error.code;
      }
      if (event.type === 'provider.diagnostic' && event.payload.code === 'owned_tool_refused'
        && report.output.refusals.length < config.limits.maxToolItems) {
        const { operation, status } = event.payload.context ?? {};
        if (operation !== undefined && status !== undefined) report.output.refusals.push({ tool: operation, refusal: status });
      }
      if ((event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
        && toolItemKinds.has(event.payload.itemKind) && !toolItems.has(event.payload.itemId)) {
        toolItems.add(event.payload.itemId);
        report.output.toolItems += 1;
        if (report.output.toolItems >= config.limits.maxToolItems) stopper.stop('tool_item_limit');
      }
      if (event.type === 'item.completed' && event.payload.itemKind === 'file_change') {
        const changes = (event.payload.details as { changes?: ReadonlyArray<{ path?: unknown }> } | undefined)?.changes ?? [];
        report.output.fileChanges.push({ status: event.payload.status,
          paths: changes.flatMap((change) => (typeof change.path === 'string' ? [change.path] : [])) });
      }
      if (event.type === 'request.opened') report.requests.push(await answer(input, output.requestContext, event.payload.request));
    }
  } catch (error) {
    report.failureCode ??= failureCode(error);
  }
}

async function answer(input: ReaderInput, requestContext: unknown, request: AgentRequest): Promise<AcceptEditsRequestRecord> {
  const { execution, decide, stopper } = input;
  if (request.requestKind !== 'approval') {
    stopper.stop('approval_options_refused');
    return { action: null, decision: 'deny_once', exactOnce: false, receipt: 'failed' };
  }
  const action = exactAction(request, requestContext) ?? null;
  let decision: AcceptEditsDecision = 'deny_once';
  if (action && !stopper.stopped) {
    decision = await Promise.resolve().then(() => decide(action, stopper.signal)).catch((): AcceptEditsDecision => 'deny_once');
  }
  // A stop withdraws pending work; nothing is approved after it, even if a person already said yes.
  if (stopper.stopped) decision = 'deny_once';
  const { resolution, exact } = onceResolution(request, decision);
  if (!exact) stopper.stop('approval_options_refused');
  let receipt: AcceptEditsRequestRecord['receipt'];
  try { receipt = (await execution.resolveRequest({ resolution })).status; }
  catch { receipt = 'failed'; }
  if (receipt !== 'delivered') stopper.stop('resolution_not_delivered');
  return { action, decision, exactOnce: exact, receipt };
}
