import { createAcpClient } from "@agen-ai/acp-transport";
import type { AcpNotificationHandler, AcpProtocolLimits, AcpReverseRequestHandler } from "@agen-ai/acp-transport";
import type { Sandbox, SandboxProcessStreams } from "@agen-ai/sandbox";
import { createSandboxAcpFileScope } from "./scope.js";
import type { SandboxAcpFileBudgets } from "./requests.js";

/** Uses the custom ACP client directly; adopting provider-acp is optional. */
export function createSandboxGrokClient(input: {
  readonly streams: Pick<SandboxProcessStreams, "stdin" | "stdout" | "stderr">;
  readonly sandbox: Sandbox;
  readonly grant: Readonly<{ kind: "read_only" | "read_write" }>;
  readonly budgets: SandboxAcpFileBudgets;
  readonly limits?: Partial<AcpProtocolLimits>;
  /** Required consumer observer; receives complete schema-validated core updates unchanged. */
  readonly onSessionUpdate: AcpNotificationHandler;
  /** Omit to retain transport rejection; supplied policies must be turn-scoped and once-only. */
  readonly onPermission?: AcpReverseRequestHandler;
}) {
  if (typeof input.onSessionUpdate !== "function") throw new TypeError("The Grok client requires a bounded session/update observer.");
  const files = createSandboxAcpFileScope(input);
  const client = createAcpClient({ ...input.streams, schemaChannel: "stable", schemaProfile: "schema-v1.23.0",
    unknownExtensionPolicy: "standard", outboundRequestIdPrefix: "sandbox-grok:",
    limits: files.transportLimits, reverseRequestHandlers: { ...files.handlers,
      ...(input.onPermission === undefined ? {} : { "session/request_permission": input.onPermission }) },
    notificationHandlers: { "session/update": input.onSessionUpdate } });
  return Object.freeze({ client, files });
}

