import type { AcpRequestMessage } from "@agen-ai/acp-transport";

// Unmodified concurrent request frames from credential-free Grok Build 1.0.62, MS005 native r2.
// Source: ms005-native-r2/grok-tools/case-report.json, nativeEvents sequences 37 and 88.
// Source file SHA256: 34cdfdd452d49da0c0b67b7b9a64027e70c63c560649d2dbaf88e3c6f270d7a2.

export const nativePendingPrompt: AcpRequestMessage = {
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/prompt",
  "params": {
    "sessionId": "01a17339-c05e-7253-8a40-e81adac87346",
    "prompt": [
      {
        "type": "text",
        "text": "MS005_TOOLS: perform the exact scripted local qualification tools."
      }
    ]
  }
};

export const nativeCollidingRead: AcpRequestMessage = {
  "jsonrpc": "2.0",
  "id": 5,
  "method": "fs/read_text_file",
  "params": {
    "sessionId": "01a17339-c05e-7253-8a40-e81adac87346",
    "path": "/workspace/work/native/seed.txt"
  }
};
