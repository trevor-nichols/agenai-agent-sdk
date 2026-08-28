// ------------------------------------------------------------------------------------------------
//                zod.ts - Schema-aware issue normalization - Dependencies: Zod 4, validator-neutral core
// ------------------------------------------------------------------------------------------------

import {
  normalizeValidationIssues,
  type ValidationErrorInput,
  type ValidationInvalidValueKind,
  type ValidationIssue,
  type ValidationIssueInput,
  type ValidationNormalizationOptions,
} from './index.js';
import type { ZodType } from 'zod/v4';

// ------------------------------------------------------------------------------------------------
//                Zod Schema Context Resolution
// ------------------------------------------------------------------------------------------------

interface ZodSchemaNode {
  readonly _zod?: {
    readonly def?: Readonly<Record<string, unknown>>;
  };
}

// Zod 4 emits identical issues for single-option enums and literals, so the
// exact-pinned schema definition is the authoritative source of that distinction.
function schemaNode(value: unknown): ZodSchemaNode | null {
  return value !== null && typeof value === 'object' && '_zod' in value
    ? value as ZodSchemaNode
    : null;
}

function schemaDefinition(
  schema: unknown,
): Readonly<Record<string, unknown>> | null {
  return schemaNode(schema)?._zod?.def ?? null;
}

function nestedSchema(
  definition: Readonly<Record<string, unknown>>,
  key: string,
): ZodSchemaNode | null {
  return schemaNode(definition[key]);
}

function collectInvalidValueKinds(
  schema: unknown,
  path: readonly PropertyKey[],
  pathIndex: number,
  depth: number,
): readonly ValidationInvalidValueKind[] {
  if (depth > path.length * 4 + 32) return [];

  const definition = schemaDefinition(schema);
  const schemaType = definition?.type;
  if (definition === null || typeof schemaType !== 'string') return [];

  if (
    schemaType === 'optional'
    || schemaType === 'nullable'
    || schemaType === 'default'
    || schemaType === 'prefault'
    || schemaType === 'catch'
    || schemaType === 'readonly'
    || schemaType === 'nonoptional'
    || schemaType === 'promise'
  ) {
    const innerType = nestedSchema(definition, 'innerType');
    return innerType === null
      ? []
      : collectInvalidValueKinds(
        innerType,
        path,
        pathIndex,
        depth + 1,
      );
  }

  if (schemaType === 'pipe') {
    return [
      ...collectInvalidValueKinds(
        nestedSchema(definition, 'in'),
        path,
        pathIndex,
        depth + 1,
      ),
      ...collectInvalidValueKinds(
        nestedSchema(definition, 'out'),
        path,
        pathIndex,
        depth + 1,
      ),
    ];
  }

  if (schemaType === 'union') {
    const options = Array.isArray(definition.options)
      ? definition.options
      : [];
    return options.flatMap((option) =>
      collectInvalidValueKinds(option, path, pathIndex, depth + 1)
    );
  }

  if (schemaType === 'intersection') {
    return [
      ...collectInvalidValueKinds(
        nestedSchema(definition, 'left'),
        path,
        pathIndex,
        depth + 1,
      ),
      ...collectInvalidValueKinds(
        nestedSchema(definition, 'right'),
        path,
        pathIndex,
        depth + 1,
      ),
    ];
  }

  if (schemaType === 'lazy' && typeof definition.getter === 'function') {
    return collectInvalidValueKinds(
      definition.getter(),
      path,
      pathIndex,
      depth + 1,
    );
  }

  if (pathIndex === path.length) {
    if (schemaType === 'enum') return ['enum'];
    if (schemaType === 'literal') return ['literal'];
    return [];
  }

  const segment = path[pathIndex];
  if (schemaType === 'object') {
    const rawShape =
      typeof definition.shape === 'function'
        ? definition.shape()
        : definition.shape;
    const shape =
      rawShape !== null && typeof rawShape === 'object'
        ? rawShape as Readonly<Record<PropertyKey, unknown>>
        : {};
    const child = schemaNode(shape[segment]);
    const fallback = child ?? nestedSchema(definition, 'catchall');
    return fallback === null
      ? []
      : collectInvalidValueKinds(
        fallback,
        path,
        pathIndex + 1,
        depth + 1,
      );
  }

  if (schemaType === 'array') {
    const element = nestedSchema(definition, 'element');
    return element === null
      ? []
      : collectInvalidValueKinds(
        element,
        path,
        pathIndex + 1,
        depth + 1,
      );
  }

  if (schemaType === 'tuple' && typeof segment === 'number') {
    const items = Array.isArray(definition.items) ? definition.items : [];
    const item = schemaNode(items[segment]) ?? nestedSchema(definition, 'rest');
    return item === null
      ? []
      : collectInvalidValueKinds(
        item,
        path,
        pathIndex + 1,
        depth + 1,
      );
  }

  if (
    schemaType === 'record'
    || schemaType === 'map'
    || schemaType === 'set'
  ) {
    const valueType =
      nestedSchema(definition, 'valueType')
      ?? nestedSchema(definition, 'element');
    return valueType === null
      ? []
      : collectInvalidValueKinds(
        valueType,
        path,
        pathIndex + 1,
        depth + 1,
      );
  }

  return [];
}

export function resolveZodInvalidValueKind(
  schema: ZodType,
  path: readonly PropertyKey[],
): ValidationInvalidValueKind | undefined {
  const kinds = new Set(
    collectInvalidValueKinds(schema, path, 0, 0),
  );
  return kinds.size === 1 ? kinds.values().next().value : undefined;
}

function zodNormalizationOptions(
  schema: ZodType,
): ValidationNormalizationOptions {
  return {
    resolveInvalidValueKind: (issue) =>
      resolveZodInvalidValueKind(schema, issue.path ?? []),
  };
}

// ------------------------------------------------------------------------------------------------
//                Zod-Aware Normalization
// ------------------------------------------------------------------------------------------------

export function normalizeZodValidationIssues(
  schema: ZodType,
  issues: readonly ValidationIssueInput[],
  input: unknown,
): readonly ValidationIssue[] {
  return normalizeValidationIssues(
    issues,
    input,
    zodNormalizationOptions(schema),
  );
}

export function normalizeZodValidationError(
  schema: ZodType,
  error: ValidationErrorInput,
  input: unknown,
): readonly ValidationIssue[] {
  return normalizeZodValidationIssues(schema, error.issues, input);
}
