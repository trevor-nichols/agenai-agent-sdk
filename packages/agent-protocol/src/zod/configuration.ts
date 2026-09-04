// ------------------------------------------------------------------------------------------------
//                configuration.ts - Safe configuration schemas - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_CONFIGURATION_APPLICATION_TIMINGS,
  AGENT_CONFIGURATION_DESCRIPTION_MAX_LENGTH,
  AGENT_CONFIGURATION_FIELDS_MAX_LENGTH,
  AGENT_CONFIGURATION_LABEL_MAX_LENGTH,
  AGENT_CONFIGURATION_OPTIONS_MAX_LENGTH,
  AGENT_CONFIGURATION_SCOPES,
  AGENT_CONFIGURATION_TEXT_VALUE_MAX_LENGTH,
  type AgentConfigurationCatalog,
  type AgentConfigurationSelectionInput,
} from '../configuration/types.js';
import {
  AgentCanonicalIdValueSchema,
  createAgentCanonicalNonBlankStringSchema,
} from './foundation.js';

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const LabelSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_CONFIGURATION_LABEL_MAX_LENGTH,
);
const DescriptionSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_CONFIGURATION_DESCRIPTION_MAX_LENGTH,
);
const CanonicalTextValueSchema = z
  .string()
  .max(AGENT_CONFIGURATION_TEXT_VALUE_MAX_LENGTH)
  .regex(/^(?:$|\S|\S[\s\S]*\S)$/u);

const AgentConfigurationSelectOptionSchema = z
  .object({
    optionId: AgentCanonicalIdValueSchema,
    label: LabelSchema,
    description: DescriptionSchema.optional(),
  })
  .strict()
  .readonly();

const fieldBase = {
  key: AgentCanonicalIdValueSchema,
  revision: PositiveSafeIntegerSchema,
  label: LabelSchema,
  description: DescriptionSchema.optional(),
  scope: z.enum(AGENT_CONFIGURATION_SCOPES),
  applicationTiming: z.enum(AGENT_CONFIGURATION_APPLICATION_TIMINGS),
  mutable: z.boolean(),
} as const;

export const AgentConfigurationFieldPortableSchema = z.discriminatedUnion(
  'fieldKind',
  [
    z
      .object({
        ...fieldBase,
        fieldKind: z.literal('boolean'),
        currentValue: z.boolean(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...fieldBase,
        fieldKind: z.literal('single_select'),
        currentValue: AgentCanonicalIdValueSchema,
        options: z
          .array(AgentConfigurationSelectOptionSchema)
          .min(1)
          .max(AGENT_CONFIGURATION_OPTIONS_MAX_LENGTH)
          .readonly(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...fieldBase,
        fieldKind: z.literal('bounded_integer'),
        currentValue: SafeIntegerSchema,
        minimum: SafeIntegerSchema,
        maximum: SafeIntegerSchema,
      })
      .strict()
      .readonly(),
    z
      .object({
        ...fieldBase,
        fieldKind: z.literal('bounded_text'),
        currentValue: CanonicalTextValueSchema,
        maxLength: z
          .number()
          .int()
          .positive()
          .max(AGENT_CONFIGURATION_TEXT_VALUE_MAX_LENGTH),
        multiline: z.boolean(),
      })
      .strict()
      .readonly(),
  ],
);

export const AgentConfigurationCatalogPortableSchema = z
  .object({
    revision: PositiveSafeIntegerSchema,
    fields: z
      .array(AgentConfigurationFieldPortableSchema)
      .max(AGENT_CONFIGURATION_FIELDS_MAX_LENGTH)
      .readonly(),
  })
  .strict()
  .readonly();

export const AgentConfigurationCatalogSchema: z.ZodType<AgentConfigurationCatalog> =
  AgentConfigurationCatalogPortableSchema.superRefine((catalog, context) => {
    const keys = new Set<string>();
    let previousKey = '';
    catalog.fields.forEach((field, fieldIndex) => {
      if (keys.has(field.key)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'key'],
          message: 'Configuration field keys must be unique.',
        });
      }
      if (
        fieldIndex > 0
        && compareStringsByUnicodeCodePoint(previousKey, field.key) >= 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'key'],
          message: 'Configuration fields must be ordered by key.',
        });
      }
      keys.add(field.key);
      previousKey = field.key;

      if (field.fieldKind === 'single_select') {
        const optionIds = new Set<string>();
        field.options.forEach((option, optionIndex) => {
          if (optionIds.has(option.optionId)) {
            context.addIssue({
              code: 'custom',
              path: ['fields', fieldIndex, 'options', optionIndex, 'optionId'],
              message: 'Configuration option IDs must be unique within a field.',
            });
          }
          if (
            optionIndex > 0
            && compareStringsByUnicodeCodePoint(
              field.options[optionIndex - 1]!.optionId,
              option.optionId,
            ) >= 0
          ) {
            context.addIssue({
              code: 'custom',
              path: ['fields', fieldIndex, 'options', optionIndex, 'optionId'],
              message: 'Configuration options must use canonical optionId order.',
            });
          }
          optionIds.add(option.optionId);
        });
        if (!optionIds.has(field.currentValue)) {
          context.addIssue({
            code: 'custom',
            path: ['fields', fieldIndex, 'currentValue'],
            message: 'Current configuration value must be an offered option.',
          });
        }
      }
      if (
        field.fieldKind === 'bounded_integer'
        && (
          field.minimum > field.maximum
          || field.currentValue < field.minimum
          || field.currentValue > field.maximum
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'currentValue'],
          message: 'Integer configuration bounds and current value are inconsistent.',
        });
      }
      if (
        field.fieldKind === 'bounded_text'
        && field.currentValue.length > field.maxLength
      ) {
        context.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'currentValue'],
          message: 'Current text configuration value exceeds the field maximum.',
        });
      }
    });
  });

export const AgentConfigurationValueSchema = z.discriminatedUnion('fieldKind', [
  z.object({ fieldKind: z.literal('boolean'), value: z.boolean() }).strict().readonly(),
  z.object({ fieldKind: z.literal('single_select'), optionId: AgentCanonicalIdValueSchema }).strict().readonly(),
  z.object({ fieldKind: z.literal('bounded_integer'), value: SafeIntegerSchema }).strict().readonly(),
  z.object({ fieldKind: z.literal('bounded_text'), value: CanonicalTextValueSchema }).strict().readonly(),
]);

export const AgentConfigurationSelectionInputSchema: z.ZodType<AgentConfigurationSelectionInput> =
  z
    .object({
      key: AgentCanonicalIdValueSchema,
      expectedCatalogRevision: PositiveSafeIntegerSchema,
      expectedFieldRevision: PositiveSafeIntegerSchema,
      value: AgentConfigurationValueSchema,
    })
    .strict()
    .readonly();
