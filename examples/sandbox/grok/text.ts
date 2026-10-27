import type { AcpRequestId } from "@agen-ai/acp-transport";
import type { SandboxReadOnlyFiles, SandboxReadWriteFiles, SandboxRelativePath } from "@agen-ai/sandbox";
import { admitResponse, SandboxAcpFileError } from "./requests.js";
import type { SandboxAcpFileBudgets } from "./requests.js";

/** Streaming equivalent of split(LF).slice(line - 1, line - 1 + limit).join(LF). */
export async function readSandboxText(input: {
  readonly files: SandboxReadOnlyFiles | SandboxReadWriteFiles;
  readonly path: SandboxRelativePath;
  readonly id: AcpRequestId;
  readonly line?: number;
  readonly limit?: number;
  readonly budgets: SandboxAcpFileBudgets;
  readonly signal: AbortSignal;
}): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const first = input.line ?? 1;
  const end = input.limit === undefined ? Infinity : first + input.limit;
  let currentLine = 1;
  let selectedLines = 0;
  let content = "";
  let responseBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: { content: "" } }));
  let scannedBytes = 0n;

  const append = (text: string) => {
    responseBytes += Buffer.byteLength(JSON.stringify(text)) - 2;
    if (responseBytes > input.budgets.maxResponseFrameBytes) throw new SandboxAcpFileError("response_budget");
    content += text;
  };
  const selected = () => currentLine >= first && currentLine < end;
  const beginLine = () => { if (selected() && selectedLines++ > 0) append("\n"); };
  beginLine();
  const consume = (text: string) => {
    let offset = 0;
    for (;;) {
      const newline = text.indexOf("\n", offset);
      if (selected()) append(text.slice(offset, newline < 0 ? undefined : newline));
      if (newline < 0) return;
      currentLine++;
      beginLine();
      offset = newline + 1;
    }
  };

  const observation = await input.files.readFile(input.path, async ({ chunks }, { signal }) => {
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      scannedBytes += BigInt(chunk.byteLength);
      if (scannedBytes > BigInt(input.budgets.maxReadBytes)) throw new SandboxAcpFileError("read_failed");
      let text: string;
      try { text = decoder.decode(chunk, { stream: true }); }
      catch { throw new SandboxAcpFileError("read_failed"); }
      consume(text);
    }
    let tail: string;
    try { tail = decoder.decode(); }
    catch { throw new SandboxAcpFileError("read_failed"); }
    consume(tail);
  }, { signal: input.signal, quotas: { maxBytes: input.budgets.maxReadBytes } });
  input.signal.throwIfAborted();
  if (observation.kind !== "completed" || observation.bytes !== scannedBytes) throw new SandboxAcpFileError("read_failed");
  admitResponse(input.id, { content }, input.budgets.maxResponseFrameBytes);
  return content;
}
