import type { ValidationIssue, ValidationPathSegment } from '../foundation/types.js';
import {
  AGENT_STRUCTURED_OUTPUT_ISSUE_CODE_MAX_LENGTH,
  AGENT_STRUCTURED_OUTPUT_ISSUE_MESSAGE_MAX_LENGTH,
  AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_BYTES_LIMIT,
  AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_SEGMENTS_LIMIT,
  AGENT_STRUCTURED_OUTPUT_ISSUES_BYTES_LIMIT,
  AGENT_STRUCTURED_OUTPUT_ISSUES_LIMIT,
} from './constants.js';

const encoder = new TextEncoder();

function boundedText(value: string, maxLength: number): string {
  let result = '';
  let length = 0;
  for (const point of value) {
    if (length === maxLength) break;
    result += point;
    length += 1;
  }
  return result;
}

export class StructuredOutputIssues {
  readonly issues: ValidationIssue[] = [];

  get full(): boolean {
    return this.issues.length >= AGENT_STRUCTURED_OUTPUT_ISSUES_LIMIT;
  }

  add(code: string, message: string, inputPath: readonly ValidationPathSegment[] = []): void {
    if (this.full) return;
    const path: ValidationPathSegment[] = [];
    for (const segment of inputPath) {
      if (path.length === AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_SEGMENTS_LIMIT) break;
      if (typeof segment === 'string' && segment.length > AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_BYTES_LIMIT
        || typeof segment === 'number' && !Number.isFinite(segment)) break;
      const candidate = [...path, segment];
      if (encoder.encode(JSON.stringify(candidate)).byteLength > AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_BYTES_LIMIT) break;
      path.push(segment);
    }
    const issue: ValidationIssue = {
      code: boundedText(code, AGENT_STRUCTURED_OUTPUT_ISSUE_CODE_MAX_LENGTH),
      path,
      message: boundedText(message, AGENT_STRUCTURED_OUTPUT_ISSUE_MESSAGE_MAX_LENGTH),
    };
    if (encoder.encode(JSON.stringify([...this.issues, issue])).byteLength <= AGENT_STRUCTURED_OUTPUT_ISSUES_BYTES_LIMIT) {
      this.issues.push(issue);
    }
  }
}

function ownData(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

export function normalizeAgentStructuredOutputIssues(input: readonly ValidationIssue[]): readonly ValidationIssue[] {
  const normalized = new StructuredOutputIssues();
  if (!Array.isArray(input)) return Object.freeze([]);
  const length = ownData(input, 'length');
  if (typeof length !== 'number') return Object.freeze([]);
  for (let index = 0; index < Math.min(length, AGENT_STRUCTURED_OUTPUT_ISSUES_LIMIT); index += 1) {
    const issue = ownData(input, index);
    if (issue === null || typeof issue !== 'object') continue;
    const code = ownData(issue, 'code');
    const message = ownData(issue, 'message');
    const sourcePath = ownData(issue, 'path');
    if (typeof code !== 'string' || typeof message !== 'string' || !Array.isArray(sourcePath)) continue;
    const pathLength = ownData(sourcePath, 'length');
    if (typeof pathLength !== 'number') continue;
    const path: ValidationPathSegment[] = [];
    for (let offset = 0; offset < Math.min(pathLength, AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_SEGMENTS_LIMIT); offset += 1) {
      const segment = ownData(sourcePath, offset);
      if (typeof segment !== 'string' && (typeof segment !== 'number' || !Number.isFinite(segment))) break;
      path.push(segment);
    }
    normalized.add(code, message, path);
  }
  return Object.freeze(normalized.issues.map((issue) => Object.freeze({ ...issue, path: Object.freeze([...issue.path]) })));
}
