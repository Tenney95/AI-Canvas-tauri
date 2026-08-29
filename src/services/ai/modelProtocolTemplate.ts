/**
 * ai/modelProtocolTemplate — 声明式协议的模板渲染（含 $whenPresent / $forEach 指令）。
 *
 * 模板只能读取白名单里的受信变量，没有求值、表达式、动态别名或动态键；
 * `$forEach` 只允许展开参考素材 URL 数组，且展开项上限由共享常量约束。
 */
import type { ProtocolJsonValue } from '../../types/aiTypes';
import { readModelProtocolPathValues } from './modelProtocolResponse';
import {
  CONDITIONAL_VALUE_KEY,
  FOR_EACH_KEY,
  FOR_EACH_VARIABLE_ROOTS,
  FULL_TEMPLATE_RE,
  MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS,
  OMIT_TEMPLATE_VALUE,
  TEMPLATE_RE,
  WHEN_PRESENT_KEY,
  isRecord,
} from './modelProtocolShared';

function resolveContextPath(context: Record<string, unknown>, path: string): unknown {
  return readModelProtocolPathValues(context, path)[0];
}

export function renderTemplateString(
  template: string,
  context: Record<string, unknown>,
): ProtocolJsonValue | typeof OMIT_TEMPLATE_VALUE {
  const fullMatch = FULL_TEMPLATE_RE.exec(template);
  if (fullMatch) {
    const resolved = resolveContextPath(context, fullMatch[1]);
    if (resolved === undefined) return OMIT_TEMPLATE_VALUE;
    return resolved as ProtocolJsonValue;
  }
  return template.replace(TEMPLATE_RE, (_match, path: string) => {
    const resolved = resolveContextPath(context, path);
    if (resolved === undefined) throw new Error(`调用协议变量 ${path} 没有可用值`);
    if (typeof resolved === 'object') throw new Error(`调用协议变量 ${path} 不能嵌入字符串`);
    return String(resolved);
  });
}

function renderForEachDirective(
  directive: Record<string, ProtocolJsonValue>,
  context: Record<string, unknown>,
  options: { conditionalDirectives?: boolean },
): ProtocolJsonValue[] {
  if (!options.conditionalDirectives) {
    throw new Error('调用协议数组展开项只能用于请求体数组元素');
  }
  const sourceTemplate = directive[FOR_EACH_KEY];
  const sourcePath = typeof sourceTemplate === 'string'
    ? FULL_TEMPLATE_RE.exec(sourceTemplate)?.[1]
    : undefined;
  if (!sourcePath || sourcePath.includes('.') || !FOR_EACH_VARIABLE_ROOTS.has(sourcePath)) {
    throw new Error('调用协议数组展开变量无效');
  }
  const source = renderTemplateString(sourceTemplate as string, context);
  if (source === OMIT_TEMPLATE_VALUE || source === null) return [];
  if (!Array.isArray(source)) {
    throw new Error(`调用协议数组展开变量 ${sourcePath} 必须是字符串数组`);
  }
  if (source.length > MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS) {
    throw new Error(
      `调用协议数组展开变量 ${sourcePath} 最多允许 ${MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS} 项`,
    );
  }
  const template = directive[CONDITIONAL_VALUE_KEY];
  return source.flatMap((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`调用协议数组展开变量 ${sourcePath} 只能包含非空字符串`);
    }
    // Inside $value the source root denotes the current element. This keeps the
    // protocol language closed: no eval, expressions, dynamic aliases or keys.
    const rendered = renderTemplate(template, { ...context, [sourcePath]: item }, {
      conditionalDirectives: true,
    });
    if (rendered === OMIT_TEMPLATE_VALUE) return [];
    if (!rendered || typeof rendered !== 'object' || Array.isArray(rendered)) {
      throw new Error('调用协议数组展开项必须渲染为 JSON 对象');
    }
    return [rendered];
  });
}

export function renderTemplate(
  value: ProtocolJsonValue,
  context: Record<string, unknown>,
  options: {
    conditionalDirectives?: boolean;
    arrayItem?: boolean;
  } = {},
): ProtocolJsonValue | typeof OMIT_TEMPLATE_VALUE {
  if (typeof value === 'string') return renderTemplateString(value, context);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isRecord(item) && Object.hasOwn(item, FOR_EACH_KEY)) {
        return renderForEachDirective(item as Record<string, ProtocolJsonValue>, context, options);
      }
      const rendered = renderTemplate(item, context, {
        conditionalDirectives: options.conditionalDirectives,
        arrayItem: true,
      });
      return rendered === OMIT_TEMPLATE_VALUE ? [] : [rendered];
    });
  }
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, FOR_EACH_KEY)) {
      throw new Error('调用协议数组展开项只能用于请求体数组元素');
    }
    if (Object.hasOwn(value, WHEN_PRESENT_KEY) || Object.hasOwn(value, CONDITIONAL_VALUE_KEY)) {
      if (!options.conditionalDirectives || !options.arrayItem) {
        throw new Error('调用协议条件项只能用于请求体数组元素');
      }
      const condition = renderTemplateString(String(value[WHEN_PRESENT_KEY]), context);
      const isMissing = condition === OMIT_TEMPLATE_VALUE
        || condition === null
        || (typeof condition === 'string' && !condition.trim())
        || (Array.isArray(condition) && condition.length === 0);
      if (isMissing) return OMIT_TEMPLATE_VALUE;
      return renderTemplate(value[CONDITIONAL_VALUE_KEY], context, {
        conditionalDirectives: true,
      });
    }
    const entries: Array<[string, ProtocolJsonValue]> = [];
    for (const [key, item] of Object.entries(value)) {
      const rendered = renderTemplate(item, context, {
        conditionalDirectives: options.conditionalDirectives,
      });
      if (rendered !== OMIT_TEMPLATE_VALUE) entries.push([key, rendered]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}
