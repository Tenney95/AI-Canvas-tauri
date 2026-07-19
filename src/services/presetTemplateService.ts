import type {
  PresetAdvancedConfig,
  PresetParameterDefinition,
  PresetParameterValue,
} from '../types';

export type PresetParameterValues = Record<string, PresetParameterValue>;

export const CURRENT_PROMPT_VARIABLE = 'currentPrompt';
export const LEGACY_PROMPT_VARIABLE = '文章内容';

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const PARAMETER_KEY_PATTERN = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

function isBlank(value: PresetParameterValue | undefined): boolean {
  return value === undefined || (typeof value === 'string' && !value.trim());
}

function coerceDefaultValue(parameter: PresetParameterDefinition): PresetParameterValue {
  if (parameter.defaultValue !== undefined) return parameter.defaultValue;
  if (parameter.type === 'boolean') return false;
  if (parameter.type === 'number') return '';
  if (parameter.type === 'select') return parameter.options?.[0] ?? '';
  return '';
}

export function createPresetParameterValues(
  parameters: PresetParameterDefinition[],
): PresetParameterValues {
  return Object.fromEntries(
    parameters.map((parameter) => [parameter.key, coerceDefaultValue(parameter)]),
  );
}

export function extractPresetTemplateVariables(template: string): string[] {
  return [...new Set(
    Array.from(template.matchAll(TEMPLATE_VARIABLE_PATTERN), (match) => match[1].trim()),
  )];
}

export function renderPresetTemplate(
  template: string,
  values: PresetParameterValues,
  currentPrompt: string,
): string {
  return template.replace(TEMPLATE_VARIABLE_PATTERN, (match, rawKey: string) => {
    const key = rawKey.trim();
    if (key === CURRENT_PROMPT_VARIABLE || key === LEGACY_PROMPT_VARIABLE) {
      return currentPrompt;
    }
    if (!(key in values)) return match;
    return String(values[key]);
  });
}

export function validatePresetParameterValues(
  parameters: PresetParameterDefinition[],
  values: PresetParameterValues,
): string[] {
  const errors: string[] = [];
  for (const parameter of parameters) {
    const value = values[parameter.key];
    if (parameter.required && isBlank(value)) {
      errors.push('请填写“' + (parameter.label || parameter.key) + '”');
      continue;
    }
    if (parameter.type === 'number' && !isBlank(value) && !Number.isFinite(Number(value))) {
      errors.push('“' + (parameter.label || parameter.key) + '”必须是数字');
    }
    if (
      parameter.type === 'select'
      && !isBlank(value)
      && !(parameter.options ?? []).includes(String(value))
    ) {
      errors.push('“' + (parameter.label || parameter.key) + '”的选项无效');
    }
  }
  return errors;
}

export function validatePresetAdvancedConfig(config: PresetAdvancedConfig): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();

  for (const [index, parameter] of config.parameters.entries()) {
    const displayIndex = index + 1;
    const key = parameter.key.trim();
    if (!parameter.label.trim()) errors.push('参数 ' + displayIndex + ' 缺少名称');
    if (!key) {
      errors.push('参数 ' + displayIndex + ' 缺少变量名');
    } else if (!PARAMETER_KEY_PATTERN.test(key)) {
      errors.push('参数“' + (parameter.label || displayIndex) + '”的变量名格式无效');
    } else if (keys.has(key)) {
      errors.push('变量名“' + key + '”重复');
    }
    keys.add(key);

    if (parameter.type === 'select') {
      const options = (parameter.options ?? []).map((option) => option.trim()).filter(Boolean);
      if (options.length === 0) {
        errors.push('参数“' + (parameter.label || displayIndex) + '”至少需要一个选项');
      }
    }
  }

  if (config.steps.length === 0) {
    errors.push('高级快捷指令至少需要一个执行步骤');
    return errors;
  }

  const allowedVariables = new Set([CURRENT_PROMPT_VARIABLE, LEGACY_PROMPT_VARIABLE, ...keys]);
  for (const [index, step] of config.steps.entries()) {
    const displayIndex = index + 1;
    if (!step.name.trim()) errors.push('步骤 ' + displayIndex + ' 缺少名称');
    if (!step.promptTemplate.trim()) errors.push('步骤 ' + displayIndex + ' 缺少提示词模板');
    for (const variable of extractPresetTemplateVariables(step.promptTemplate)) {
      if (!allowedVariables.has(variable)) {
        errors.push('步骤 ' + displayIndex + ' 使用了未定义变量“' + variable + '”');
      }
    }
  }

  return errors;
}
