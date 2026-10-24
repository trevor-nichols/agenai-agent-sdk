// ------------------------------------------------------------------------------------------------
//                peer.mjs - Credential-free one-connection ACP example guest
// ------------------------------------------------------------------------------------------------

import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const input = await readFile("input.txt", "utf8");
let initializeCount = 0;
let sessionCreates = 0;
let prompts = 0;
let pendingPrompt;
let pendingPermission;
let pendingHostProbe;
const permissions = [];
const hostReplies = [];
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const finish = async () => {
  await writeFile("artifact.json", `${JSON.stringify({ input, initializeCount, sessionCreates, prompts, permissions, hostReplies })}\n`);
  send({ id: pendingPrompt, result: { stopReason: "end_turn" } });
  pendingPrompt = undefined;
};

const receive = async (frame) => {
  if (frame.method === "initialize") {
    initializeCount += 1;
    send({ id: frame.id, result: { protocolVersion: 1, agentInfo: { name: "sandbox-public-example", version: "1" }, authMethods: [] } });
  } else if (frame.method === "session/new") {
    if (frame.params.cwd !== process.cwd()) throw new Error("The SDK must use the returned guest workspace.");
    sessionCreates += 1;
    send({ id: frame.id, result: { sessionId: "sandbox-example-session" } });
  } else if (frame.method === "session/prompt") {
    if (pendingPrompt !== undefined) throw new Error("Overlapping prompts are unsupported by this controlled peer.");
    pendingPrompt = frame.id;
    prompts += 1;
    send({ method: "session/update", params: { sessionId: "sandbox-example-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: `isolated turn ${prompts}: α\n` },
    } } });
    pendingPermission = `permission:${prompts}`;
    send({ id: pendingPermission, method: "session/request_permission", params: {
      sessionId: "sandbox-example-session",
      toolCall: { toolCallId: `edit:${prompts}`, title: "Write the isolated example artifact", kind: "edit", status: "in_progress" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "deny-once", name: "Deny once", kind: "reject_once" }],
    } });
  } else if (frame.id === pendingPermission) {
    if (frame.result?.outcome?.outcome !== "selected" || frame.result.outcome.optionId !== "allow-once") {
      throw new Error("The controlled peer requires its exact once-only approval.");
    }
    permissions.push(frame.result);
    pendingPermission = undefined;
    pendingHostProbe = `host:${prompts}`;
    send({ id: pendingHostProbe, method: "fs/read_text_file", params: {
      sessionId: "sandbox-example-session", path: "/host-facilities-are-disabled",
    } });
  } else if (frame.id === pendingHostProbe) {
    if (frame.error?.code !== -32602) throw new Error("Host filesystem authority must remain disabled.");
    hostReplies.push(frame.error);
    pendingHostProbe = undefined;
    await finish();
  } else throw new Error(`Unexpected controlled ACP frame: ${JSON.stringify(frame)}`);
};

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Controlled ACP frame exceeded its bound.");
  void receive(JSON.parse(line)).catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  });
});
