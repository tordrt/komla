import { z } from 'zod';

/** A part of a settings resource's format, such as the file itself or what a command prints. */
export interface SettingsSchemaSection {
  /** Shown above the section's fields; the resource's own section has none. */
  title?: string;
  schema: z.ZodType;
}

type JsonSchema = {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  propertyNames?: JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
};

/** A section's format as JSON Schema, for `komla settings schema --json`. */
export function settingsJsonSchema(section: SettingsSchemaSection): Record<string, unknown> {
  const options = { io: 'input', unrepresentable: 'any' } as const;
  return z.toJSONSchema(section.schema, options) as Record<string, unknown>;
}

/**
 * A settings resource's format as Markdown, one bullet per field with its type, limits, default
 * and description, for an agent to read before it writes the settings.
 */
export function describeSettingsSchema(
  resource: string,
  sections: SettingsSchemaSection[]
): string {
  const parts = sections.map((section, index) => {
    const schema = settingsJsonSchema(section) as JsonSchema;
    const heading = index === 0 ? `# ${resource}` : `## ${section.title ?? ''}`;
    const lines = [heading, ''];
    if (schema.description) lines.push(schema.description, '');
    lines.push(...fieldLines(schema, ''));
    return lines.join('\n').trimEnd();
  });
  return `${parts.join('\n\n')}\n`;
}

function fieldLines(schema: JsonSchema, indent: string): string[] {
  const target = inner(schema);
  if (target.properties) {
    const required = new Set(target.required ?? []);
    return Object.entries(target.properties).flatMap(([name, field]) => [
      `${indent}- \`${name}\`${required.has(name) ? ' (required)' : ''}: ${summary(field)}`,
      ...fieldLines(field, `${indent}  `),
    ]);
  }
  const options = objectOptions(target);
  return (
    options?.flatMap((option, index) => [
      `${indent}- Option ${index + 1}: ${summary(option)}`,
      ...fieldLines(option, `${indent}  `),
    ]) ?? []
  );
}

/** What a schema's fields belong to: itself, or the items of a list or the values of a map. */
function inner(schema: JsonSchema): JsonSchema {
  if (schema.items) return inner(schema.items);
  if (typeof schema.additionalProperties === 'object' && !schema.properties) {
    return inner(schema.additionalProperties);
  }
  return schema;
}

/** The objects a union allows, when any of them has fields to list. */
function objectOptions(schema: JsonSchema): JsonSchema[] | undefined {
  const options = schema.anyOf ?? schema.oneOf;
  return options?.some((option) => inner(option).properties) ? options : undefined;
}

function summary(schema: JsonSchema): string {
  const parts = [kind(schema)];
  if (schema.default !== undefined) parts.push(`${JSON.stringify(schema.default)} by default`);
  const text = parts.join(', ');
  if (!schema.description) return `${text}.`;
  const description = /[.!?]$/.test(schema.description)
    ? schema.description
    : `${schema.description}.`;
  return `${text}. ${description}`;
}

function kind(schema: JsonSchema): string {
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
  if (schema.enum) {
    return schema.enum.length === 1
      ? `\`${String(schema.enum[0])}\``
      : `one of ${schema.enum.map((value) => `\`${String(value)}\``).join(', ')}`;
  }
  if (objectOptions(schema)) return 'one of these objects';
  const options = schema.anyOf ?? schema.oneOf;
  if (options) return options.map(kind).join(' or ');
  return typeKind(schema);
}

function typeKind(schema: JsonSchema): string {
  switch (schema.type) {
    case 'string': {
      const text = schema.pattern ? `text matching \`${schema.pattern}\`` : 'text';
      const length = range(schema.minLength, schema.maxLength, 'character');
      return length ? `${text}, ${length}` : text;
    }
    case 'integer':
    case 'number': {
      const value = range(schema.minimum, schema.maximum);
      const name = schema.type === 'integer' ? 'whole number' : 'number';
      return value ? `${name}, ${value}` : name;
    }
    case 'boolean':
      return '`true` or `false`';
    case 'array':
      return `list of ${items(schema.items, range(schema.minItems, schema.maxItems))}`;
    case 'object':
      if (schema.properties || typeof schema.additionalProperties !== 'object') return 'object';
      return `map of ${
        schema.propertyNames?.pattern
          ? `names matching \`${schema.propertyNames.pattern}\``
          : 'names'
      } to ${inner(schema.additionalProperties).properties ? 'objects' : kind(schema.additionalProperties)}`;
    default:
      return 'any value';
  }
}

/** A list's or map's values, such as "up to 50 objects" or "items, each text". */
function items(schema: JsonSchema | undefined, count?: string): string {
  const counted = count ? `${count} ` : '';
  if (!schema) return `${counted}items`;
  const target = inner(schema);
  if (target === schema && (target.properties || objectOptions(target))) {
    return `${counted}objects${target.properties ? '' : ', each one of these'}`;
  }
  return `${counted}items, each ${kind(schema)}`;
}

// Bounds a whole number gets from JavaScript, not from the setting.
const SAFE = Number.MAX_SAFE_INTEGER;

/** Such as "1 to 50", "10 or more", "up to 12 characters", or nothing without bounds. */
function range(min?: number, max?: number, unit?: string): string {
  const low = min !== undefined && min > -SAFE && !(unit && min === 0) ? min : undefined;
  const high = max !== undefined && max < SAFE ? max : undefined;
  const units = (value: number) => (unit ? ` ${unit}${value === 1 ? '' : 's'}` : '');
  if (low !== undefined && high !== undefined) return `${low} to ${high}${units(high)}`;
  if (low !== undefined) return `${low} or more${units(2)}`;
  if (high !== undefined) return `up to ${high}${units(high)}`;
  return '';
}
