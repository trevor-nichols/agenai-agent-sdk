import { createAcpSchemaValidator, type AcpJsonObject, type AcpStandardMcpServer } from '@agen-ai/acp-transport';
import type { AcpNegotiatedAgent } from './connection/contracts.js';
import type { AcpSessionMcpBindingOptions } from './contracts.js';
import { freezeHostData, hostObject, hostPath, hostText } from './host/validation.js';

export function resolveAcpSessionMcpBinding(value: AcpSessionMcpBindingOptions | undefined): AcpSessionMcpBindingOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'transport' && key !== 'create')
    || (value.transport !== 'http' && value.transport !== 'sse') || typeof value.create !== 'function') {
    throw new TypeError('ACP session MCP bindings require an explicit transport and factory.');
  }
  return Object.freeze({ transport: value.transport, create: value.create.bind(value) });
}

export function supportsAcpSessionMcpBinding(binding: AcpSessionMcpBindingOptions | undefined, negotiated: AcpNegotiatedAgent): boolean {
  const capabilities = negotiated.agentCapabilities.mcpCapabilities as AcpJsonObject | undefined;
  return binding !== undefined && capabilities?.[binding.transport] === true;
}

/** Approved setup only. ACP does not report connected MCP inventory. */
export function resolveAcpMcpServers(value: readonly AcpStandardMcpServer[] = []): readonly AcpStandardMcpServer[] {
  if (!Array.isArray(value) || value.length > 32 || Buffer.byteLength(JSON.stringify(value), 'utf8') > 512 * 1_024) {
    throw new TypeError('ACP MCP setup exceeds its bounded server configuration.');
  }
  const copy = structuredClone(value);
  createAcpSchemaValidator('stable', 'schema-v1.23.0').validate('agent', 'session/new', 'request', { cwd: '/', mcpServers: copy });
  const names = new Set<string>();
  for (const server of copy) {
    const name = hostText(server.name, 200);
    if (names.has(name)) throw new TypeError('ACP MCP setup contains duplicate server names.');
    names.add(name);
    if (server.type === 'http' || server.type === 'sse') {
      const url = new URL(hostText(server.url, 2_048));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('ACP MCP URL is invalid.');
      if (server.headers.length > 128) throw new TypeError('ACP MCP headers exceed the configured bound.');
      for (const header of server.headers) { hostText(header.name, 256); hostText(header.value, 16_384, true); }
    } else {
      if (server.type !== undefined) throw new TypeError('ACP MCP setup contains an unsupported transport.');
      const stdio = hostObject(server) as AcpJsonObject;
      hostPath(stdio.command);
      if (!Array.isArray(stdio.args) || stdio.args.length > 128 || !Array.isArray(stdio.env) || stdio.env.length > 128) throw new TypeError('ACP MCP process configuration exceeds its bound.');
      for (const arg of stdio.args) hostText(arg, 16_384, true);
      for (const entry of stdio.env) { const env = hostObject(entry); hostText(env.name, 256); hostText(env.value, 16_384, true); }
    }
    freezeHostData(server);
  }
  return Object.freeze(copy);
}

export function assertAcpMcpSupport(servers: readonly AcpStandardMcpServer[], negotiated: AcpNegotiatedAgent): void {
  const capabilities = negotiated.agentCapabilities.mcpCapabilities as AcpJsonObject | undefined;
  for (const server of servers) {
    if ((server.type === 'http' || server.type === 'sse') && capabilities?.[server.type] !== true) {
      throw new TypeError('The ACP peer does not support an approved MCP transport.');
    }
  }
}
