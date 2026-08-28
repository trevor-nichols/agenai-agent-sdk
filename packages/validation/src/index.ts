// ------------------------------------------------------------------------------------------------
//                index.ts - Stable validator-neutral issue normalization
// ------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------
//                Public Issue Contracts
// ------------------------------------------------------------------------------------------------

export type ValidationPathSegment = string | number;

export interface ValidationIssue {
  readonly code: string;
  readonly path: readonly ValidationPathSegment[];
  readonly message: string;
}

export interface ValidationIssueInput {
  readonly code: string;
  readonly path?: readonly PropertyKey[] | undefined;
  readonly message: string;
  readonly expected?: string | undefined;
  readonly values?: readonly unknown[] | undefined;
  readonly minimum?: number | bigint | undefined;
  readonly maximum?: number | bigint | undefined;
  readonly origin?: string | undefined;
  readonly keys?: readonly unknown[] | undefined;
  readonly format?: string | undefined;
  readonly inclusive?: boolean | undefined;
  readonly exact?: boolean | undefined;
  readonly includes?: string | undefined;
  readonly prefix?: string | undefined;
  readonly suffix?: string | undefined;
  readonly position?: number | undefined;
  readonly divisor?: number | bigint | undefined;
  readonly note?: string | undefined;
  readonly discriminator?: string | undefined;
  readonly options?: readonly unknown[] | undefined;
}

export interface ValidationErrorInput {
  readonly issues: readonly ValidationIssueInput[];
}

export type ValidationInvalidValueKind = 'enum' | 'literal';

export interface ValidationNormalizationOptions {
  readonly resolveInvalidValueKind?: (
    issue: ValidationIssueInput,
  ) => ValidationInvalidValueKind | undefined;
}

const DEFAULT_FORMAT_MESSAGES: Readonly<
  Record<string, readonly [zod4Message: string, establishedMessage: string]>
> = {
  base64: ['Invalid base64-encoded string', 'Invalid base64'],
  cidrv4: ['Invalid IPv4 range', 'Invalid cidr'],
  cidrv6: ['Invalid IPv6 range', 'Invalid cidr'],
  cuid: ['Invalid cuid', 'Invalid cuid'],
  date: ['Invalid ISO date', 'Invalid date'],
  datetime: ['Invalid ISO datetime', 'Invalid datetime'],
  duration: ['Invalid ISO duration', 'Invalid duration'],
  email: ['Invalid email address', 'Invalid email'],
  emoji: ['Invalid emoji', 'Invalid emoji'],
  ipv4: ['Invalid IPv4 address', 'Invalid ip'],
  ipv6: ['Invalid IPv6 address', 'Invalid ip'],
  jwt: ['Invalid JWT', 'Invalid jwt'],
  nanoid: ['Invalid nanoid', 'Invalid nanoid'],
  time: ['Invalid ISO time', 'Invalid time'],
  ulid: ['Invalid ULID', 'Invalid ulid'],
  url: ['Invalid URL', 'Invalid url'],
  uuid: ['Invalid UUID', 'Invalid uuid'],
};

// ------------------------------------------------------------------------------------------------
//                Stable Issue-Dialect Normalization
// ------------------------------------------------------------------------------------------------

function pathSegments(
  path: readonly PropertyKey[] | undefined,
): ValidationPathSegment[] {
  return (path ?? []).map((segment) =>
    typeof segment === 'number' ? segment : String(segment),
  );
}

function valueAtPath(
  input: unknown,
  path: readonly ValidationPathSegment[],
): unknown {
  let value = input;
  for (const segment of path) {
    if (typeof value === 'string' && typeof segment === 'number') {
      value = value.split(',')[segment];
      continue;
    }
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return value;
}

function quotedValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

function serializedLiteral(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item,
  ) ?? String(value);
}

function receivedType(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number' && Number.isNaN(value)) return 'nan';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value instanceof Map) return 'map';
  if (value instanceof Set) return 'set';
  if (value instanceof Promise) return 'promise';
  return typeof value;
}

function invalidTypeIssue(
  issue: ValidationIssueInput,
  path: readonly ValidationPathSegment[],
  input: unknown,
): ValidationIssue | null {
  if (
    issue.code !== 'invalid_type'
    || typeof issue.expected !== 'string'
    || !issue.message.startsWith('Invalid input: expected ')
  ) {
    return null;
  }

  const receivedValue = valueAtPath(input, path);
  if (receivedValue === undefined) {
    return { code: issue.code, path, message: 'Required' };
  }

  const expected = issue.expected === 'int' ? 'integer' : issue.expected;
  const received =
    issue.expected === 'int'
    && typeof receivedValue === 'number'
    && !Number.isInteger(receivedValue)
      ? 'float'
      : receivedType(receivedValue);

  return {
    code: issue.code,
    path,
    message: `Expected ${expected}, received ${received}`,
  };
}

function nonFiniteNumberIssue(
  issue: ValidationIssueInput,
  path: readonly ValidationPathSegment[],
  input: unknown,
): ValidationIssue | null {
  const receivedValue = valueAtPath(input, path);
  if (
    issue.code !== 'invalid_type'
    || issue.expected !== 'number'
    || issue.message !== 'Invalid input: expected number, received number'
    || (
      receivedValue !== Number.POSITIVE_INFINITY
      && receivedValue !== Number.NEGATIVE_INFINITY
    )
  ) {
    return null;
  }

  return {
    code: 'not_finite',
    path,
    message: 'Number must be finite',
  };
}

function limitDescription(
  issue: ValidationIssueInput,
  boundary: number | bigint,
  direction: 'minimum' | 'maximum',
): string {
  const exact = issue.exact === true;
  const inclusive = issue.inclusive !== false;

  if (issue.origin === 'array') {
    const comparison = exact
      ? 'exactly'
      : direction === 'minimum'
        ? inclusive ? 'at least' : 'more than'
        : inclusive ? 'at most' : 'less than';
    return `Array must contain ${comparison} ${boundary} element(s)`;
  }

  if (issue.origin === 'string') {
    const comparison = exact
      ? 'exactly'
      : direction === 'minimum'
        ? inclusive ? 'at least' : 'over'
        : inclusive ? 'at most' : 'under';
    return `String must contain ${comparison} ${boundary} character(s)`;
  }

  if (issue.origin === 'number' || issue.origin === 'int') {
    const comparison = exact
      ? 'exactly equal to'
      : direction === 'minimum'
        ? inclusive ? 'greater than or equal to' : 'greater than'
        : inclusive ? 'less than or equal to' : 'less than';
    return `Number must be ${comparison} ${boundary}`;
  }

  if (issue.origin === 'bigint') {
    const comparison = exact
      ? 'exactly'
      : direction === 'minimum'
        ? inclusive ? 'greater than or equal to' : 'greater than'
        : inclusive ? 'less than or equal to' : 'less than';
    const label = direction === 'minimum' ? 'Number' : 'BigInt';
    return `${label} must be ${comparison} ${boundary}`;
  }

  if (issue.origin === 'date') {
    const comparison = exact
      ? 'exactly'
      : direction === 'minimum'
        ? inclusive ? 'greater than or equal to' : 'greater than'
        : inclusive ? 'smaller than or equal to' : 'smaller than';
    return `Date must be ${comparison} ${new Date(Number(boundary))}`;
  }

  return 'Invalid input';
}

function limitIssue(
  issue: ValidationIssueInput,
  path: readonly ValidationPathSegment[],
): ValidationIssue | null {
  const direction =
    issue.code === 'too_small'
      ? 'minimum'
      : issue.code === 'too_big'
        ? 'maximum'
        : null;
  if (direction === null || !issue.message.startsWith('Too ')) return null;

  const boundary = issue[direction];
  if (typeof boundary !== 'number' && typeof boundary !== 'bigint') return null;

  return {
    code: issue.code,
    path,
    message: limitDescription(issue, boundary, direction),
  };
}

function notMultipleOfIssue(
  issue: ValidationIssueInput,
  path: readonly ValidationPathSegment[],
): ValidationIssue | null {
  if (
    issue.code !== 'not_multiple_of'
    || (
      typeof issue.divisor !== 'number'
      && typeof issue.divisor !== 'bigint'
    )
    || issue.message !== `Invalid number: must be a multiple of ${issue.divisor}`
  ) {
    return null;
  }

  return {
    code: issue.code,
    path,
    message: `Number must be a multiple of ${issue.divisor}`,
  };
}

function invalidUnionDiscriminatorIssue(
  issue: ValidationIssueInput,
  path: readonly ValidationPathSegment[],
): ValidationIssue | null {
  if (
    issue.code !== 'invalid_union'
    || issue.note !== 'No matching discriminator'
    || typeof issue.discriminator !== 'string'
    || !Array.isArray(issue.options)
  ) {
    return null;
  }

  return {
    code: 'invalid_union_discriminator',
    path,
    message: issue.message,
  };
}

function invalidFormatMessage(issue: ValidationIssueInput): string {
  if (
    issue.format === 'regex'
    && issue.message.startsWith('Invalid string: must match pattern ')
  ) {
    return 'Invalid';
  }

  if (
    issue.format === 'includes'
    && issue.includes !== undefined
    && issue.message === `Invalid string: must include "${issue.includes}"`
  ) {
    const position =
      typeof issue.position === 'number'
        ? ` at one or more positions greater than or equal to ${issue.position}`
        : '';
    return `Invalid input: must include "${issue.includes}"${position}`;
  }
  if (
    issue.format === 'starts_with'
    && issue.prefix !== undefined
    && issue.message === `Invalid string: must start with "${issue.prefix}"`
  ) {
    return `Invalid input: must start with "${issue.prefix}"`;
  }
  if (
    issue.format === 'ends_with'
    && issue.suffix !== undefined
    && issue.message === `Invalid string: must end with "${issue.suffix}"`
  ) {
    return `Invalid input: must end with "${issue.suffix}"`;
  }

  const defaultMessage =
    issue.format === undefined
      ? undefined
      : DEFAULT_FORMAT_MESSAGES[issue.format];
  if (defaultMessage !== undefined && issue.message === defaultMessage[0]) {
    return defaultMessage[1];
  }

  return issue.message;
}

function normalizeIssue(
  issue: ValidationIssueInput,
  input: unknown,
  options: ValidationNormalizationOptions,
): ValidationIssue {
  const path = pathSegments(issue.path);

  const nonFiniteNumber = nonFiniteNumberIssue(issue, path, input);
  if (nonFiniteNumber !== null) return nonFiniteNumber;

  const invalidType = invalidTypeIssue(issue, path, input);
  if (invalidType !== null) return invalidType;

  if (issue.code === 'invalid_value' && Array.isArray(issue.values)) {
    const invalidValueKind =
      issue.values.length === 1
        ? options.resolveInvalidValueKind?.(issue) ?? 'literal'
        : 'enum';
    if (invalidValueKind === 'literal') {
      return {
        code: 'invalid_literal',
        path,
        message: `Invalid literal value, expected ${serializedLiteral(issue.values[0])}`,
      };
    }

    const receivedValue = valueAtPath(input, path);
    if (receivedValue === undefined) {
      return {
        code: 'invalid_type',
        path,
        message: 'Required',
      };
    }

    return {
      code: 'invalid_enum_value',
      path,
      message: `Invalid enum value. Expected ${issue.values.map(quotedValue).join(' | ')}, received ${quotedValue(receivedValue)}`,
    };
  }

  const limit = limitIssue(issue, path);
  if (limit !== null) return limit;

  const notMultipleOf = notMultipleOfIssue(issue, path);
  if (notMultipleOf !== null) return notMultipleOf;

  const invalidUnionDiscriminator = invalidUnionDiscriminatorIssue(issue, path);
  if (invalidUnionDiscriminator !== null) return invalidUnionDiscriminator;

  if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
    return {
      code: issue.code,
      path,
      message: `Unrecognized key(s) in object: ${issue.keys.map(quotedValue).join(', ')}`,
    };
  }

  if (issue.code === 'invalid_format') {
    return {
      code: 'invalid_string',
      path,
      message: invalidFormatMessage(issue),
    };
  }

  return {
    code: issue.code,
    path,
    message: issue.message,
  };
}

export function normalizeValidationIssues(
  issues: readonly ValidationIssueInput[],
  input: unknown,
  options: ValidationNormalizationOptions = {},
): readonly ValidationIssue[] {
  return issues.map((issue) => normalizeIssue(issue, input, options));
}

export function normalizeValidationError(
  error: ValidationErrorInput,
  input: unknown,
  options: ValidationNormalizationOptions = {},
): readonly ValidationIssue[] {
  return normalizeValidationIssues(error.issues, input, options);
}
