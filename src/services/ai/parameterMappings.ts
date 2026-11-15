/** 复制已解析映射的有效参数；动态值覆盖静态值，保留 0 和 false。 */
export function mapParameterFields(
  mapping: { fields: Partial<Record<string, string>>; staticFields?: Record<string, unknown> },
  values: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...(mapping.staticFields ?? {}) };
  for (const [key, field] of Object.entries(mapping.fields)) {
    const value = values[key];
    if (field && value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)) {
      output[field] = value;
    }
  }
  return output;
}
