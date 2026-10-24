import { parseAgentRequest, type AgentRequestId } from "@agen-ai/agent-protocol";

import type { AgentEvent } from "@agen-ai/agent-protocol";
import { throwIfAgentOperationAborted } from "../foundation.js";
import type { AgentProviderTurnExecution } from "../sessions.js";
import type { GenerationCleanupOwner } from "./cleanup.js";
import {
  AGENT_GENERATION_REQUEST_LIMIT, AGENT_GENERATION_REQUEST_TIMEOUT_MS, AGENT_GENERATION_RESPONSE_TIMEOUT_MS,
  waitForBoundedGenerationWork,
} from "./deadline.js";
import { AgentGenerationError } from "./errors.js";
import type { AgentGenerateObjectInput } from "./types.js";

interface RequestWork {
  readonly controller: AbortController;
  live: boolean;
  pending: number;
  finished: boolean;
}

export function createGenerationRequests(input: Readonly<{
  handler: AgentGenerateObjectInput<unknown>["onRequest"];
  execution: AgentProviderTurnExecution;
  signal: AbortSignal;
  deadlineAt: number;
  owner: GenerationCleanupOwner;
  fail: (error: unknown) => void;
  checkDeadline: () => void;
}>) {
  const records = new Map<AgentRequestId, RequestWork>();
  let stopped = false;
  const retire = (record: RequestWork): void => {
    record.live = false;
    record.controller.abort(new DOMException("The generation request is no longer available.", "AbortError"));
  };
  return {
    stop(): void { stopped = true; for (const record of records.values()) retire(record); },
    observe(event: AgentEvent): void {
      if (event.type === "request.unavailable") {
        const record = records.get(event.payload.requestId);
        if (record) retire(record);
        return;
      }
      if (event.type === "turn.completed") {
        for (const record of records.values()) retire(record);
        return;
      }
      if (event.type !== "request.opened" || stopped) return;
      if (!input.handler) {
        input.fail(new AgentGenerationError("interaction_required", "Object generation requires a request handler."));
        return;
      }
      if (records.size >= AGENT_GENERATION_REQUEST_LIMIT) {
        input.fail(new AgentGenerationError("request_failed", "Object generation exceeded its active request handler limit."));
        return;
      }
      const request = parseAgentRequest(event.payload.request);
      const record: RequestWork = { controller: new AbortController(), live: true, pending: 0, finished: false };
      records.set(request.requestId, record);
      const handler = input.handler;
      const signal = AbortSignal.any([input.signal, record.controller.signal]);
      let expiry: ReturnType<typeof setTimeout> | undefined;
      if (request.expiresAt !== undefined) {
        const expiresAt = Date.parse(request.expiresAt);
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) retire(record);
        else if (expiresAt < input.deadlineAt) expiry = setTimeout(() => retire(record), remaining);
      }
      const clearRecord = () => {
        if (record.finished && record.pending === 0 && records.get(request.requestId) === record) records.delete(request.requestId);
      };
      const retain = <T>(work: Promise<T>): Promise<T> => {
        record.pending += 1;
        void work.then(() => { record.pending -= 1; clearRecord(); }, () => { record.pending -= 1; clearRecord(); });
        return input.owner.retain(work);
      };
      let deliveryEntered = false;
      const task = (async () => {
        try {
          const callback = retain(Promise.resolve().then(() => { throwIfAgentOperationAborted(signal); return handler(request, { signal }); }));
          const resolution = await waitForBoundedGenerationWork(callback, signal, AGENT_GENERATION_REQUEST_TIMEOUT_MS,
            new AgentGenerationError("request_failed", "Object generation request handler exceeded its deadline."));
          input.checkDeadline();
          if (!record.live || stopped || signal.aborted) return;
          const delivery = retain(Promise.resolve().then(() => {
            input.checkDeadline();
            if (!record.live || stopped) throw new DOMException("The generation request is no longer available.", "AbortError");
            deliveryEntered = true;
            return input.execution.resolveRequest({ resolution, signal: input.signal });
          }));
          const receipt = await waitForBoundedGenerationWork(delivery, input.signal, AGENT_GENERATION_RESPONSE_TIMEOUT_MS,
            new AgentGenerationError("request_failed", "Object generation request delivery exceeded its deadline."));
          if (receipt.status !== "delivered") {
            input.fail(new AgentGenerationError("request_failed", "Object generation request was not delivered.", { receipt, cause: receipt }));
          }
        } catch (cause) {
          try { input.checkDeadline(); } catch { /* The generation owner already retains its deadline failure. */ }
          if ((record.live || deliveryEntered) && !stopped && !input.signal.aborted) {
            input.fail(cause instanceof AgentGenerationError ? cause : new AgentGenerationError("request_failed", "Object generation request handler or delivery failed.", { cause }));
          }
        } finally {
          if (expiry !== undefined) clearTimeout(expiry);
          record.finished = true;
          clearRecord();
        }
      })();
      input.owner.retain(task);
    },
  };
}
