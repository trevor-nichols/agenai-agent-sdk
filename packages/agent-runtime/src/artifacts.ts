// ------------------------------------------------------------------------------------------------
//                artifacts.ts - Process-local artifact candidates - Dependencies: protocol, crypto
// ------------------------------------------------------------------------------------------------

import { createHash } from "node:crypto";

import {
  parseAgentArtifactDescriptor,
  type AgentArtifactDescriptor,
} from "@agenai/agent-protocol";

import { containsAgentControlCharacter } from "./internal/controlCharacters.js";

// ------------------------------------------------------------------------------------------------
//                Candidate Contracts
// ------------------------------------------------------------------------------------------------

export const AGENT_ARTIFACT_CANDIDATE_MAX_BYTES = 10 * 1024 * 1024;

export type AgentArtifactDeliveryRequirement =
  | "best_effort"
  | "required_before_reference";

export type AgentArtifactCandidateSource =
  | Readonly<{ kind: "bytes"; bytes: Uint8Array }>
  | Readonly<{ kind: "file"; filePath: string }>;

export interface AgentArtifactCandidate {
  readonly descriptor: AgentArtifactDescriptor;
  readonly source: AgentArtifactCandidateSource;
  readonly delivery: AgentArtifactDeliveryRequirement;
}

export interface CreateAgentArtifactCandidateInput {
  readonly descriptor: AgentArtifactDescriptor;
  readonly source: AgentArtifactCandidateSource;
  readonly delivery: AgentArtifactDeliveryRequirement;
}

export const AGENT_ARTIFACT_CANDIDATE_ERROR_CODES = [
  "invalid_descriptor",
  "invalid_source",
  "source_too_large",
  "byte_size_mismatch",
  "digest_mismatch",
  "invalid_delivery",
] as const;

export type AgentArtifactCandidateErrorCode =
  (typeof AGENT_ARTIFACT_CANDIDATE_ERROR_CODES)[number];

export class AgentArtifactCandidateError extends TypeError {
  constructor(readonly code: AgentArtifactCandidateErrorCode) {
    super(`Agent artifact candidate is invalid: ${code}.`);
    this.name = "AgentArtifactCandidateError";
  }
}

// ------------------------------------------------------------------------------------------------
//                Candidate Construction
// ------------------------------------------------------------------------------------------------

function candidateError(code: AgentArtifactCandidateErrorCode): never {
  throw new AgentArtifactCandidateError(code);
}

function bytesCandidateDescriptor(
  descriptor: AgentArtifactDescriptor,
  bytes: Uint8Array,
): AgentArtifactDescriptor {
  if (bytes.byteLength > AGENT_ARTIFACT_CANDIDATE_MAX_BYTES) {
    candidateError("source_too_large");
  }
  if (
    descriptor.byteSize !== undefined &&
    descriptor.byteSize !== bytes.byteLength
  ) {
    candidateError("byte_size_mismatch");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (descriptor.digest !== undefined && descriptor.digest.value !== digest) {
    candidateError("digest_mismatch");
  }
  return parseAgentArtifactDescriptor({
    ...descriptor,
    byteSize: bytes.byteLength,
    digest: { algorithm: "sha256", value: digest },
  });
}

function fileCandidateSource(filePath: string): AgentArtifactCandidateSource {
  if (
    filePath.length < 1 ||
    filePath.length > 4_096 ||
    filePath !== filePath.trim() ||
    containsAgentControlCharacter(filePath)
  ) {
    candidateError("invalid_source");
  }
  return Object.freeze({ kind: "file" as const, filePath });
}

export function createAgentArtifactCandidate(
  input: CreateAgentArtifactCandidateInput,
): AgentArtifactCandidate {
  let descriptor: AgentArtifactDescriptor;
  try {
    descriptor = parseAgentArtifactDescriptor(input.descriptor);
  } catch {
    candidateError("invalid_descriptor");
  }

  if (!["best_effort", "required_before_reference"].includes(input.delivery)) {
    candidateError("invalid_delivery");
  }
  if (
    descriptor.kind === "plan" &&
    input.delivery !== "required_before_reference"
  ) {
    candidateError("invalid_delivery");
  }

  if (input.source === null || typeof input.source !== "object") {
    candidateError("invalid_source");
  }
  let source: AgentArtifactCandidateSource;
  if (input.source.kind === "bytes") {
    if (!(input.source.bytes instanceof Uint8Array))
      candidateError("invalid_source");
    source = Object.freeze({
      kind: "bytes" as const,
      bytes: new Uint8Array(input.source.bytes),
    });
  } else if (input.source.kind === "file") {
    source = fileCandidateSource(input.source.filePath);
  } else {
    candidateError("invalid_source");
  }
  if (source.kind === "bytes")
    descriptor = bytesCandidateDescriptor(descriptor, source.bytes);

  return Object.freeze({ descriptor, source, delivery: input.delivery });
}
