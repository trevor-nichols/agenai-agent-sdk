// Exact coordinated public SDK package inventory and source dependency policy.

export const PUBLIC_PACKAGE_POLICIES = Object.freeze([
  {
    root: "packages/validation",
    name: "@agen-ai/validation",
    dependencies: { zod: "catalog:" },
  },
  {
    root: "packages/agent-protocol",
    name: "@agen-ai/agent-protocol",
    dependencies: { "@agen-ai/validation": "workspace:^", zod: "catalog:" },
  },
  {
    root: "packages/agent-runtime",
    name: "@agen-ai/agent-runtime",
    dependencies: { "@agen-ai/agent-protocol": "workspace:^" },
  },
  {
    root: "packages/agent-orchestration",
    name: "@agen-ai/agent-orchestration",
    dependencies: {
      "@agen-ai/agent-runtime": "workspace:^",
      "@agen-ai/agent-protocol": "workspace:^",
      "@agen-ai/validation": "workspace:^",
      zod: "catalog:",
      "@modelcontextprotocol/sdk": "1.29.0",
    },
  },
  {
    root: "packages/acp-transport",
    name: "@agen-ai/acp-transport",
    dependencies: { ajv: "8.17.1" },
  },
  {
    root: "packages/provider-acp",
    name: "@agen-ai/provider-acp",
    dependencies: {
      "@agen-ai/acp-transport": "workspace:^",
      "@agen-ai/agent-runtime": "workspace:^",
      "@agen-ai/agent-protocol": "workspace:^",
    },
  },
  {
    root: "packages/acp-registry",
    name: "@agen-ai/acp-registry",
    dependencies: { "@agen-ai/validation": "workspace:^", zod: "catalog:",
      "@openpgp/unbzip2-stream": "2.1.0", "buffer-crc32": "1.0.0", "tar-stream": "3.2.2", yauzl: "3.4.0" },
  },
  {
    root: "packages/agent-history",
    name: "@agen-ai/agent-history",
    dependencies: { "@agen-ai/agent-protocol": "workspace:^", "@agen-ai/validation": "workspace:^", zod: "catalog:" },
  },
  {
    root: "packages/sandbox",
    name: "@agen-ai/sandbox",
    dependencies: { "@agen-ai/validation": "workspace:^", zod: "catalog:" },
  },
  {
    root: "packages/sandbox-docker",
    name: "@agen-ai/sandbox-docker",
    dependencies: { "@agen-ai/sandbox": "workspace:^", "@agen-ai/validation": "workspace:^", zod: "catalog:" },
  },
  {
    root: "packages/provider-grok",
    name: "@agen-ai/provider-grok",
    dependencies: {
      "@agen-ai/agent-protocol": "workspace:^",
      "@agen-ai/agent-runtime": "workspace:^",
      "@agen-ai/provider-acp": "workspace:^",
      "@agen-ai/sandbox": "workspace:^",
      "@agen-ai/sandbox-docker": "workspace:^",
    },
  },
  {
    root: "packages/provider-tools",
    name: "@agen-ai/provider-tools",
    dependencies: { "@agen-ai/agent-protocol": "workspace:^", "@agen-ai/sandbox": "workspace:^", "@agen-ai/sandbox-docker": "workspace:^", zod: "catalog:" },
  },
  {
    root: "packages/provider-claude",
    name: "@agen-ai/provider-claude",
    dependencies: {
      "@agen-ai/agent-protocol": "workspace:^",
      "@agen-ai/agent-runtime": "workspace:^",
      "@agen-ai/provider-tools": "workspace:^",
      "@anthropic-ai/claude-agent-sdk": "0.3.322",
      "@anthropic-ai/sdk": "0.113.0",
      "@modelcontextprotocol/sdk": "1.29.0",
      zod: "catalog:",
    },
  },
  {
    root: "packages/provider-opencode",
    name: "@agen-ai/provider-opencode",
    dependencies: {
      "@agen-ai/agent-protocol": "workspace:^",
      "@agen-ai/agent-runtime": "workspace:^",
      "@agen-ai/provider-tools": "workspace:^",
      "@opencode/client": "2.2.7",
      "eventsource-parser": "3.1.1",
      zod: "catalog:",
    },
  },
].map((policy) => Object.freeze({ ...policy, dependencies: Object.freeze(policy.dependencies) })));
