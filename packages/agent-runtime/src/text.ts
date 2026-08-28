// ------------------------------------------------------------------------------------------------
//                text.ts - Canonical provider text chunking - Dependencies: agent protocol
// ------------------------------------------------------------------------------------------------

import { AGENT_PROTOCOL_TEXT_MAX_LENGTH } from "@agen-ai/agent-protocol";

// ------------------------------------------------------------------------------------------------
//                Canonical Text Chunks
// ------------------------------------------------------------------------------------------------

export function chunkAgentCanonicalText(value: string): readonly string[] {
  const chunks: string[] = [];
  let offset = 0;

  while (offset < value.length) {
    let end = Math.min(offset + AGENT_PROTOCOL_TEXT_MAX_LENGTH, value.length);
    const splitsSurrogatePair =
      end < value.length &&
      /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") &&
      /[\uDC00-\uDFFF]/u.test(value[end] ?? "");
    if (splitsSurrogatePair) end -= 1;
    chunks.push(value.slice(offset, end));
    offset = end;
  }

  return Object.freeze(chunks);
}
