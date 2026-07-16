/**
 * Agent 工具输入使用的 JSON Schema 子集。
 *
 * 当前不引入第三方校验依赖，只支持工具契约实际需要的类型、required、enum、
 * 长度/数值限制、数组 items 和 additionalProperties=false。
 */
export interface AgentToolSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, AgentToolSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: AgentToolSchema;
  enum?: Array<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface AgentToolValidationResult {
  valid: boolean;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateValue(
  schema: AgentToolSchema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} 必须是允许值之一`);
    return;
  }

  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push(`${path} 必须是对象`);
        return;
      }
      const properties = schema.properties ?? {};
      for (const requiredKey of schema.required ?? []) {
        if (!(requiredKey in value)) {
          errors.push(`${path}.${requiredKey} 为必填字段`);
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) errors.push(`${path}.${key} 是未知字段`);
        }
      }
      for (const [key, childSchema] of Object.entries(properties)) {
        if (key in value) validateValue(childSchema, value[key], `${path}.${key}`, errors);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path} 必须是数组`);
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path} 至少需要 ${schema.minItems} 项`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path} 最多允许 ${schema.maxItems} 项`);
      }
      if (schema.items) {
        value.forEach((item, index) => validateValue(schema.items!, item, `${path}[${index}]`, errors));
      }
      break;
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path} 必须是字符串`);
        return;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${path} 长度不能小于 ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${path} 长度不能超过 ${schema.maxLength}`);
      }
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path} 必须是有限数字`);
        return;
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        errors.push(`${path} 必须是整数`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path} 不能小于 ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path} 不能大于 ${schema.maximum}`);
      }
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} 必须是布尔值`);
      break;
  }
}

export function validateAgentToolInput(
  schema: AgentToolSchema,
  value: unknown,
): AgentToolValidationResult {
  const errors: string[] = [];
  validateValue(schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}
