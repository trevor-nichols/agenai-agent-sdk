// ------------------------------------------------------------------------------------------------
//                plugin.ts - The OpenCode 2.2.7 plugin context surface the packaged plugin drives
// ------------------------------------------------------------------------------------------------

type Tool = { name: string; description?: string; input?: unknown; options?: unknown; execute?: (input: unknown, context: unknown) => Promise<unknown> };
type Hook = (event: Record<string, unknown>) => void;

/**
 * Models the native registries the plugin edits: transforms see the current entries and list()
 * reports what remains. `pinned` tools survive removal, as a native tool outside plugin control would.
 */
export function pluginContext(options: unknown, settings: { version?: string; pinned?: readonly string[] } = {}) {
  const tools = new Map<string, Tool>(['read', 'shell', 'patch', 'question', 'opencode_models'].map((name) => [name, { name }]));
  const providers = new Set(['anthropic', 'openai', 'opencode']);
  const servers = new Set(['docs']);
  const skills = new Set(['opencode', 'report']);
  const agents = new Map<string, unknown>([['build', []], ['compaction', []]]);
  const hooks = new Map<string, Hook>();
  const hook = async (name: string, run: Hook) => { hooks.set(name, run); };
  const ctx = {
    app: { version: settings.version ?? '2.2.7' },
    options,
    tool: {
      async transform(edit: (editor: unknown) => void) {
        edit({
          list: () => [...tools.keys()].map((id) => ({ id })),
          remove: (id: string) => { if (!settings.pinned?.includes(id)) tools.delete(id); },
          add: (tool: Tool) => { tools.set(tool.name, tool); },
        });
      },
      async list() { return [...tools.keys()].map((id) => ({ id })); },
      hook,
    },
    provider: { async transform(edit: (editor: unknown) => void) {
      edit({ list: () => [...providers].map((id) => ({ provider: { id } })), remove: (id: string) => providers.delete(id) });
    } },
    mcp: { async transform(edit: (editor: unknown) => void) {
      edit({ list: () => [...servers].map((name) => [name, {}]), remove: (name: string) => servers.delete(name) });
    } },
    skill: { async transform(edit: (editor: unknown) => void) {
      edit({ list: () => [...skills].map((id) => ({ id })), remove: (id: string) => skills.delete(id) });
    } },
    agent: { async transform(edit: (editor: unknown) => void) {
      edit({
        list: () => [...agents.keys()].map((id) => ({ id })),
        update: (id: string, change: (value: { permissions: unknown }) => void) => {
          const value = { permissions: agents.get(id) };
          change(value);
          agents.set(id, value.permissions);
        },
      });
    } },
    permission: { hook },
    session: { hook },
  };
  /**
   * One native tool call in OpenCode 2.2.7 order: `execute.before` receives the raw model input, the
   * tool executes with that input decoded against its schema, then `execute.after` runs.
   */
  async function run(id: string, raw: unknown, decoded: unknown, context: { sessionID: string; messageID: string; id: string; signal: AbortSignal }) {
    const event = { tool: id, sessionID: context.sessionID, agent: 'build', messageID: context.messageID, id: context.id, input: raw };
    hooks.get('execute.before')?.(event);
    try { return await tools.get(id)!.execute!(decoded, context); } finally { hooks.get('execute.after')?.({ ...event, status: 'completed' }); }
  }
  return { ctx, tools, providers, servers, skills, agents, hooks, run };
}
