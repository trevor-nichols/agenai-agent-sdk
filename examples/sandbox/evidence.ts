// ------------------------------------------------------------------------------------------------
//                evidence.ts - Independent resource absence observations
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { get } from "node:http";
import type { SandboxRecoveryRecord } from "@agen-ai/sandbox";

export async function inspectResources(endpoint: string, record: SandboxRecoveryRecord, checkpoint: string,
  roles: readonly SandboxRecoveryRecord["resources"][number]["role"][] = ["compute", "storage", "export", "network"]) {
  const observations = [];
  for (const resource of record.resources.filter((resource) => roles.includes(resource.role))) {
    const id = resource.identity.kind === "identified" ? resource.identity.id : resource.name;
    const route = resource.role === "storage" ? `/volumes/${encodeURIComponent(id)}`
      : resource.role === "network" ? `/networks/${encodeURIComponent(id)}` : `/containers/${encodeURIComponent(id)}/json`;
    const status = await new Promise<number>((resolve, reject) => {
      const request = get({ socketPath: endpoint.slice(7), path: `/v1.52${route}`, agent: false }, (response) => {
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 1024 * 1024) request.destroy(new Error("Independent Engine observation exceeded its byte bound."));
        });
        response.on("error", reject);
        response.on("end", () => response.statusCode === undefined ? reject(new Error("Missing Engine HTTP status.")) : resolve(response.statusCode));
      });
      const timer = setTimeout(() => request.destroy(new Error("Independent Engine observation timed out.")), 10_000);
      request.on("error", reject);
      request.once("close", () => clearTimeout(timer));
    });
    observations.push({ checkpoint, role: resource.role, id, httpStatus: status });
    assert.equal(status, 404, `Expected ${resource.role} absence at ${checkpoint}.`);
  }
  return observations;
}

export function failureSummary(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error).slice(0, 2048);
  return { name: error.name, message: error.message.slice(0, 2048),
    ...(depth < 4 && error.cause !== undefined ? { cause: failureSummary(error.cause, depth + 1) } : {}),
    ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.map((entry) => failureSummary(entry, depth + 1)) } : {}),
  };
}
