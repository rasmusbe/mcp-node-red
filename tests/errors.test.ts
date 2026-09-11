import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatZodError } from '../src/errors.js';

function errorFrom(schema: z.ZodTypeAny, value: unknown): z.ZodError {
  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error('expected the schema to reject the value');
  }
  return result.error;
}

describe('formatZodError', () => {
  it('should render a missing field as one line', () => {
    const error = errorFrom(z.object({ flowId: z.string() }), {});

    expect(formatZodError('get_flow', error)).toBe(
      'Invalid input for get_flow:\n- flowId: Required'
    );
  });

  it('should join a nested path with dots', () => {
    const schema = z.object({
      nodes: z.array(z.object({ type: z.string() })),
      label: z.string(),
    });

    const error = errorFrom(schema, {
      nodes: [{ type: 'inject' }, { type: 'debug' }, { type: 'function' }, {}],
      label: 3,
    });

    expect(formatZodError('update_flow', error)).toBe(
      [
        'Invalid input for update_flow:',
        '- nodes.3.type: Required',
        '- label: Expected string, received number',
      ].join('\n')
    );
  });

  it('should report the issues of every union alternative', () => {
    // The shape get_node_help accepts: a type, or a module and a set.
    const schema = z.union([
      z.object({ type: z.string(), raw: z.boolean().optional() }),
      z.object({ module: z.string(), set: z.string(), raw: z.boolean().optional() }),
    ]);

    expect(formatZodError('get_node_help', errorFrom(schema, {}))).toBe(
      [
        'Invalid input for get_node_help:',
        '- type: Required',
        '- module: Required',
        '- set: Required',
      ].join('\n')
    );
  });

  it('should report an issue shared by two union alternatives once', () => {
    const schema = z.union([
      z.object({ id: z.string(), a: z.string() }),
      z.object({ id: z.string(), b: z.string() }),
    ]);

    expect(formatZodError('example', errorFrom(schema, {}))).toBe(
      ['Invalid input for example:', '- id: Required', '- a: Required', '- b: Required'].join('\n')
    );
  });

  it('should render an empty path as (root)', () => {
    const error = errorFrom(z.object({ flowId: z.string() }), 'not an object');

    expect(formatZodError('get_flow', error)).toBe(
      'Invalid input for get_flow:\n- (root): Expected object, received string'
    );
  });
});
