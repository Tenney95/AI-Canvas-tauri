import { describe, expect, it } from 'vitest';
import {
  validateAgentToolInput,
  type AgentToolSchema,
} from '../../../src/services/chat/agentToolSchemas';

const schema: AgentToolSchema = {
  type: 'object',
  required: ['name', 'count', 'mode', 'tags'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 8 },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    mode: { type: 'string', enum: ['safe', 'fast'] },
    tags: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string', minLength: 1 },
    },
  },
};

describe('validateAgentToolInput', () => {
  it('accepts input that matches the supported schema subset', () => {
    expect(validateAgentToolInput(schema, {
      name: 'canvas',
      count: 2,
      mode: 'safe',
      tags: ['a', 'b'],
    })).toEqual({ valid: true, errors: [] });
  });

  it('rejects missing and unknown fields', () => {
    const result = validateAgentToolInput(schema, {
      count: 1,
      mode: 'safe',
      tags: ['a'],
      requiresConfirm: false,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('$.name 为必填字段');
    expect(result.errors).toContain('$.requiresConfirm 是未知字段');
  });

  it('rejects enum, length, integer, range and array violations together', () => {
    const result = validateAgentToolInput(schema, {
      name: 'x',
      count: 3.5,
      mode: 'unsafe',
      tags: [],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      '$.name 长度不能小于 2',
      '$.count 必须是整数',
      '$.mode 必须是允许值之一',
      '$.tags 至少需要 1 项',
    ]));
  });

  it('rejects non-finite numeric values', () => {
    const result = validateAgentToolInput({ type: 'number' }, Number.NaN);

    expect(result).toEqual({ valid: false, errors: ['$ 必须是有限数字'] });
  });
});
