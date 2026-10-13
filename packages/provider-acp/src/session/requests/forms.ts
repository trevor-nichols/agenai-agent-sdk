import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import {
  parseAgentRequest,
  parseAgentRequestFieldId,
  type AgentElicitationField,
  type AgentElicitationRequest,
  type AgentRequestId,
  type AgentRequestResolution,
} from '@agen-ai/agent-protocol';

import { AcpProviderSessionError } from '../errors.js';
import { nativeObject, nativeString } from '../native.js';

interface NativeChoice { readonly value: string; readonly label: string; readonly description?: string }
interface PreparedField {
  readonly key: string;
  readonly field: AgentElicitationField;
  readonly choices: readonly NativeChoice[];
}

function parseAgentElicitationRequest(input: unknown): AgentElicitationRequest {
  const request = parseAgentRequest(input);
  if (request.requestKind !== 'elicitation') unsupported('Expected an elicitation request.');
  return request;
}

function unsupported(message: string): never {
  throw new AcpProviderSessionError('acp_form_unsupported', message);
}

function keys(value: AcpJsonObject, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (key !== '_meta' && !allowed.includes(key)) unsupported(`ACP form property ${key} is unsupported.`);
  }
}

function optionalString(value: AcpJsonValue | undefined, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return nativeString(value, name);
}

function count(value: AcpJsonValue | undefined, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) unsupported(`ACP ${name} must be a nonnegative safe integer.`);
  return value;
}

function choices(property: AcpJsonObject): readonly NativeChoice[] | undefined {
  const plain = property.enum;
  const titled = property.oneOf ?? property.anyOf;
  if (plain != null && titled != null) unsupported('ACP form choices cannot combine enum and titled options.');
  if (plain == null && titled == null) return undefined;
  const input = plain ?? titled;
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) unsupported('ACP forms require between one and 100 choices.');
  const result = input.map((value) => {
    if (plain != null) {
      const text = nativeString(value, 'form choice');
      return { value: text, label: /\S/u.test(text) ? text : JSON.stringify(text) };
    }
    const option = nativeObject(value, 'form choice');
    keys(option, ['const', 'title', 'description']);
    const description = optionalString(option.description, 'choice description');
    return {
      value: nativeString(option.const, 'choice value'),
      label: nativeString(option.title, 'choice title'),
      ...(description === undefined ? {} : { description }),
    };
  });
  if (new Set(result.map((option) => option.value)).size !== result.length) unsupported('ACP form choice values must be unique.');
  return result;
}

function stringValue(property: AcpJsonObject, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  const minimum = count(property.minLength, 'minimum string length') ?? 0;
  const maximum = count(property.maxLength, 'maximum string length');
  const options = choices(property);
  return length >= minimum && (maximum === undefined || length <= maximum)
    && (options === undefined || options.some((option) => option.value === value));
}

function propertyValue(property: AcpJsonObject, value: unknown): boolean {
  if (property.type === 'string') return stringValue(property, value);
  if (property.type === 'boolean') return typeof value === 'boolean';
  if (property.type === 'number' || property.type === 'integer') {
    return typeof value === 'number' && Number.isFinite(value)
      && (property.type !== 'integer' || Number.isSafeInteger(value))
      && (property.minimum == null || value >= Number(property.minimum))
      && (property.maximum == null || value <= Number(property.maximum));
  }
  if (property.type === 'array') {
    const items = nativeObject(property.items, 'form array items');
    const options = choices(items);
    return Array.isArray(value) && value.length >= (count(property.minItems, 'minimum selections') ?? 0)
      && value.length <= (count(property.maxItems, 'maximum selections') ?? 100)
      && value.every((entry) => typeof entry === 'string' && options?.some((option) => option.value === entry));
  }
  return false;
}

/** Validates the complete bounded native schema before either a host or canonical UI sees it. */
export function validateAcpFormSchema(schema: AcpJsonObject): void {
  keys(schema, ['type', 'title', 'description', 'properties', 'required']);
  if (schema.type !== undefined && schema.type !== 'object') unsupported('ACP forms must have object schemas.');
  optionalString(schema.title, 'form title');
  optionalString(schema.description, 'form description');
  const properties = schema.properties === undefined ? {} : nativeObject(schema.properties, 'form properties');
  if (Object.keys(properties).length > 16) unsupported('ACP forms cannot exceed 16 fields.');
  if (schema.required != null && (!Array.isArray(schema.required)
    || schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key))
    || new Set(schema.required).size !== schema.required.length)) unsupported('ACP form required fields are invalid.');
  for (const value of Object.values(properties)) {
    const property = nativeObject(value, 'form property');
    const type = nativeString(property.type, 'form property type');
    const common = ['type', 'title', 'description', 'default'];
    optionalString(property.title, 'field title');
    optionalString(property.description, 'field description');
    if (type === 'string') {
      keys(property, [...common, 'minLength', 'maxLength', 'pattern', 'format', 'enum', 'oneOf']);
      if (property.pattern != null || property.format != null) unsupported('ACP form string patterns and formats are unsupported.');
      const minimum = count(property.minLength, 'minimum string length') ?? 0;
      const maximum = count(property.maxLength, 'maximum string length');
      if (maximum !== undefined && minimum > maximum) unsupported('ACP form string bounds conflict.');
      choices(property);
    } else if (type === 'number' || type === 'integer') {
      keys(property, [...common, 'minimum', 'maximum']);
      for (const bound of ['minimum', 'maximum']) {
        const number = property[bound];
        if (number != null && (typeof number !== 'number' || !Number.isFinite(number)
          || (type === 'integer' && !Number.isSafeInteger(number)))) unsupported('ACP form numeric bounds are invalid.');
      }
      if (property.minimum != null && property.maximum != null && Number(property.minimum) > Number(property.maximum)) unsupported('ACP form numeric bounds conflict.');
    } else if (type === 'boolean') keys(property, common);
    else if (type === 'array') {
      keys(property, [...common, 'minItems', 'maxItems', 'items']);
      const items = nativeObject(property.items, 'form array items');
      keys(items, ['type', 'enum', 'anyOf']);
      if (items.type !== undefined && items.type !== 'string') unsupported('ACP multi-select items must be strings.');
      if (!choices(items)) unsupported('ACP multi-select items must offer choices.');
      const minimum = count(property.minItems, 'minimum selections') ?? 0;
      const maximum = count(property.maxItems, 'maximum selections');
      if (maximum !== undefined && minimum > maximum) unsupported('ACP selection bounds conflict.');
    } else unsupported(`ACP form field type ${type} is unsupported.`);
    if (property.default != null && !propertyValue(property, property.default)) unsupported('ACP form default does not satisfy its schema.');
  }
}

export function validateAcpFormContent(schema: AcpJsonObject, content: AcpJsonObject): void {
  validateAcpFormSchema(schema);
  const properties = schema.properties === undefined ? {} : nativeObject(schema.properties, 'form properties');
  if (Object.keys(content).some((key) => !Object.hasOwn(properties, key))) unsupported('ACP form response contains an unknown field.');
  for (const key of schema.required as string[] | null | undefined ?? []) {
    if (!Object.hasOwn(content, key)) unsupported('ACP form response omits a required field.');
  }
  for (const [key, value] of Object.entries(content)) {
    if (!propertyValue(nativeObject(properties[key], 'form property'), value)) unsupported('ACP form response does not satisfy its schema.');
  }
}

export interface PreparedAcpForm {
  readonly prompt: string;
  readonly schema: AcpJsonObject;
  readonly fields: readonly PreparedField[];
}

export function prepareAcpForm(params: AcpJsonObject): PreparedAcpForm {
  const schema = nativeObject(params.requestedSchema, 'requested form schema');
  validateAcpFormSchema(schema);
  const properties = schema.properties === undefined ? {} : nativeObject(schema.properties, 'form properties');
  const required = new Set(schema.required as string[] | null | undefined ?? []);
  const fields = Object.entries(properties).map(([key, value], index): PreparedField => {
    const property = nativeObject(value, 'form property');
    if (property.default != null) unsupported('Canonical ACP forms do not support default values.');
    const base = {
      fieldId: parseAgentRequestFieldId(`acp:field:${index + 1}`),
      label: optionalString(property.title, 'field title') ?? key,
      ...(property.description == null ? {} : { description: nativeString(property.description, 'field description') }),
      required: required.has(key),
      sensitivity: 'ordinary' as const,
    };
    let offered = choices(property);
    let field: AgentElicitationField;
    if (property.type === 'boolean') field = { ...base, kind: 'boolean' };
    else if (property.type === 'string' && offered) {
      if (property.minLength != null || property.maxLength != null) {
        if (offered.some((option) => !stringValue(property, option.value))) unsupported('ACP form choices conflict with string bounds.');
      }
      field = { ...base, kind: 'single_select', allowOther: false,
        options: offered.map((option, choiceIndex) => ({ ...option, value: `acp:choice:${choiceIndex + 1}` })) };
    } else if (property.type === 'string') {
      unsupported('Canonical ACP forms cannot faithfully represent native free-text answers. Configure a native host form UI.');
    } else if (property.type === 'array') {
      offered = choices(nativeObject(property.items, 'multi-select items'))!;
      const minimum = count(property.minItems, 'minimum selections') ?? 0;
      if ((base.required && minimum !== 1) || (!base.required && minimum !== 0)) unsupported('Canonical ACP multi-select fields do not represent this minimum selection count.');
      const maximum = count(property.maxItems, 'maximum selections') ?? offered.length;
      if (maximum < 1 || maximum > offered.length) unsupported('ACP canonical multi-select bounds exceed its available choices.');
      field = { ...base, kind: 'multi_select', allowOther: false, maxSelections: maximum,
        options: offered.map((option, choiceIndex) => ({ ...option, value: `acp:choice:${choiceIndex + 1}` })) };
    } else unsupported('Canonical ACP forms do not support numeric fields.');
    return { key, field, choices: offered ?? [] };
  });
  const prompt = [nativeString(params.message, 'form message'), optionalString(schema.title, 'form title'), optionalString(schema.description, 'form description')]
    .filter((part) => part !== undefined && part !== '').join('\n\n');
  parseAgentElicitationRequest({ requestKind: 'elicitation', requestId: 'acp:preflight', prompt, fields: fields.length ? fields.map((field) => field.field)
    : [{ fieldId: 'acp:preflight', kind: 'boolean', label: 'Accept', required: true, sensitivity: 'ordinary' }] });
  return { prompt, schema, fields };
}

export class AcpFormFlow {
  private phase: 'intent' | 'fields' = 'intent';
  request: AgentElicitationRequest;

  constructor(private readonly form: PreparedAcpForm, private readonly nextRequestId: () => AgentRequestId) {
    this.request = parseAgentElicitationRequest({ requestKind: 'elicitation', requestId: nextRequestId(), prompt: form.prompt,
      fields: [{ fieldId: 'acp:form-intent', kind: 'single_select', label: 'Response', required: true, sensitivity: 'ordinary', allowOther: false,
        options: [{ value: 'provide_answers', label: form.fields.length ? 'Provide answers' : 'Accept' }, { value: 'decline', label: 'Decline' }] }] });
  }

  resolve(resolution: AgentRequestResolution): AcpJsonObject | undefined {
    if (resolution.requestKind !== 'elicitation') unsupported('ACP form resolution must be elicitation.');
    if (resolution.disposition === 'canceled') return { action: 'cancel' };
    if (this.phase === 'intent') {
      const answer = resolution.answers[0];
      if (answer?.kind !== 'single_select') unsupported('ACP form intent requires an offered selection.');
      if (answer.value === 'decline') return { action: 'decline' };
      if (answer.value !== 'provide_answers') unsupported('ACP form intent selection was not offered.');
      if (this.form.fields.length === 0) return { action: 'accept', content: {} };
      this.phase = 'fields';
      this.request = parseAgentElicitationRequest({ requestKind: 'elicitation', requestId: this.nextRequestId(), prompt: this.form.prompt,
        fields: this.form.fields.map((field) => field.field) });
      return undefined;
    }
    const content: AcpJsonObject = Object.fromEntries(resolution.answers.flatMap((answer): [string, AcpJsonValue][] => {
      const field = this.form.fields.find((entry) => entry.field.fieldId === answer.fieldId)!;
      if (answer.kind === 'text' || answer.kind === 'boolean') return [[field.key, answer.value]];
      if (answer.kind === 'single_select') {
        if (answer.value === undefined) return [];
        const index = field.field.kind === 'single_select' ? field.field.options.findIndex((option) => option.value === answer.value) : -1;
        return [[field.key, field.choices[index]!.value]];
      }
      if (answer.kind === 'multi_select') return [[field.key, answer.values.map((value) => {
        const index = field.field.kind === 'multi_select' ? field.field.options.findIndex((option) => option.value === value) : -1;
        return field.choices[index]!.value;
      })]];
      return unsupported('ACP forms do not map confirmation fields.');
    }));
    validateAcpFormContent(this.form.schema, content);
    return { action: 'accept', content };
  }
}
