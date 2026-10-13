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
].map((policy) => Object.freeze({ ...policy, dependencies: Object.freeze(policy.dependencies) })));
