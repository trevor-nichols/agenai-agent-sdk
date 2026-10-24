// ------------------------------------------------------------------------------------------------
//                docker.ts - Credential-free installed Docker example
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId, parseAgentTurnId } from "@agen-ai/agent-protocol";
import { fileFromBytes, type SandboxRecoveryRecord } from "@agen-ai/sandbox";
import { createDockerSandboxBackend } from "@agen-ai/sandbox-docker";
import { approveSyntheticRequest } from "../run-session.js";
import { sandboxExampleConfiguration } from "./configuration.js";
import { failureSummary, inspectResources } from "./evidence.js";
import { isolatedSandboxRequest } from "./policy.js";
import { SandboxAcpSessionError, withSandboxAcpSession } from "./session.js";

const config = await sandboxExampleConfiguration(process.env);
const namespace = `sdk-example-${randomUUID()}`;
const directory = path.join(config.output, "packed-sandbox");
await mkdir(config.output, { recursive: true, mode: 0o700 });
await mkdir(directory, { mode: 0o700 });
const backend = createDockerSandboxBackend({ endpoint: config.endpoint, profile: config.profile, namespace, imageDigest: config.imageDigest,
  user: config.user, spillDirectory: await realpath(directory) });
let latestRecord: SandboxRecoveryRecord | undefined;
const recoveryPath = path.join(directory, "recovery.json");
const checkpoints: unknown[] = [];
let result: unknown;
let primaryFailure: Readonly<{ error: unknown }> | undefined;
const cleanupFailures: unknown[] = [];
const evidenceFailures: unknown[] = [];
try {
  const completed = await withSandboxAcpSession({
    backend, request: isolatedSandboxRequest(),
    recovery: { kind: "persisted", async persist(record) {
      latestRecord = record;
      await writeFile(`${recoveryPath}.next`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(`${recoveryPath}.next`, recoveryPath);
    } },
    entries: [fileFromBytes("peer.mjs", await readFile(new URL("./peer.mjs", import.meta.url))),
      fileFromBytes("input.txt", Buffer.from("explicit packed sandbox input\n"))],
    identity: {
      providerKey: parseAgentProviderKey("sandbox-example"), instanceId: parseAgentInstanceId("sandbox-example:instance"),
      sessionId: parseAgentSessionId("sandbox-example:session"), configurationRevision: parseAgentConfigurationRevisionId("sandbox-example:configuration"),
    },
    launch: (sandbox) => ({ executable: "/usr/local/bin/node", args: [path.posix.join(sandbox.workspace, "peer.mjs")], env: {}, shutdownTimeoutMs: 15_000 }),
    driver: { limits: { initializationTimeoutMs: 20_000, cancellationTimeoutMs: 10_000, hostOperationTimeoutMs: 30_000 } },
    exportPaths: ["artifact.json"],
    maxExportBytes: 64 * 1024,
    transferOptions: () => ({ deadlineAt: new Date(Date.now() + 60_000).toISOString() }),
    async afterClose(sandbox) {
      checkpoints.push(...await inspectResources(config.endpoint, sandbox.recoveryRecord, "sdk-close-before-export", ["compute"]));
    },
  }, async (session) => {
    const turns = [];
    for (const index of [1, 2]) {
      const execution = session.startTurn({ turnId: parseAgentTurnId(`sandbox-example:turn:${index}`), interactionMode: "default",
        parts: [{ type: "text", text: "Write the controlled guest artifact." }], deadlineAt: new Date(Date.now() + 20_000).toISOString() });
      let text = "";
      let outcome: string | undefined;
      for await (const output of execution.outputs) {
        if (output.kind !== "event") continue;
        const event = output.event;
        if (event.type === "content.delta") text += event.payload.delta;
        if (event.type === "request.opened") {
          const request = event.payload.request;
          if (request.requestKind !== "approval") throw new Error("The controlled peer may request only portable approval.");
          const receipt = await execution.resolveRequest({ resolution: await approveSyntheticRequest(request) });
          assert.deepEqual(receipt, { status: "delivered" });
        }
        if (event.type === "turn.completed") outcome = event.payload.outcome;
      }
      assert.equal(text, `isolated turn ${index}: α\n`);
      assert.equal(outcome, "completed");
      turns.push({ text, outcome });
    }
    return turns;
  });
  latestRecord = completed.recoveryRecord;
  assert.equal(completed.files.length, 1);
  const artifact = completed.files[0];
  assert(artifact);
  const guest: unknown = JSON.parse(Buffer.from(artifact.bytes).toString("utf8"));
  assert.deepEqual(guest, { input: "explicit packed sandbox input\n", initializeCount: 1, sessionCreates: 1, prompts: 2,
    permissions: [1, 2].map(() => ({ outcome: { outcome: "selected", optionId: "allow-once" } })),
    hostReplies: [1, 2].map(() => ({ code: -32602, message: "This host facility is not available." })),
  });
  result = { turns: completed.result, guest, artifactSha256: createHash("sha256").update(artifact.bytes).digest("hex") };
} catch (error) {
  primaryFailure = { error };
  if (error instanceof SandboxAcpSessionError) latestRecord = error.owner.recoveryRecord;
} finally {
  if (latestRecord) {
    try { checkpoints.push(...await inspectResources(config.endpoint, latestRecord, "finally-destroy")); }
    catch (error) { cleanupFailures.push(error); }
  }
  const report = { proof: "packed-sandbox-docker-example", evidence: "credential-free-controlled-acp", namespace,
    endpoint: config.endpoint, imageDigest: config.imageDigest, node: process.version, result, checkpoints,
    recoveryRecord: latestRecord, modelCalls: 0, credentialReads: 0,
    primaryFailure: primaryFailure ? failureSummary(primaryFailure.error) : null, cleanupFailures: cleanupFailures.map((error) => failureSummary(error)),
    evidenceFailures: evidenceFailures.map((error) => failureSummary(error)),
  };
  try { await writeFile(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
  catch (error) {
    evidenceFailures.push(error);
    report.evidenceFailures = evidenceFailures.map((entry) => failureSummary(entry));
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
if (primaryFailure || cleanupFailures.length || evidenceFailures.length) throw new AggregateError([
  ...(primaryFailure ? [primaryFailure.error] : []), ...cleanupFailures, ...evidenceFailures,
], "The public sandbox example failed; original failures and exact recovery evidence are retained.");
