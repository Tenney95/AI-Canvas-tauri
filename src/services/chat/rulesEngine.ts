/**
 * rulesEngine — 本地规则引擎
 * 将用户自然语言文本解析为 CommandIntent[]，不依赖 LLM。
 * 当 cloudParseEnabled === false 或作为 LLM 解析的前置快速路径使用。
 */
import type { CommandIntent, CommandId, NodeSelector } from '../../types/chat';
import type { NodeType } from '../../types';

// ============================================
// Pattern definitions
// ============================================

interface RulePattern {
  regex: RegExp;
  commandId: CommandId;
  confidence: number;
  /** 从匹配结果提取 selector / params */
  extract: (match: RegExpMatchArray) => {
    selector?: NodeSelector;
    params?: unknown;
  };
}

const PATTERNS: RulePattern[] = [
  // ── undo / redo ──
  {
    regex: /^(撤销|撤回|回退|undo)$/i,
    commandId: 'undo',
    confidence: 0.95,
    extract: () => ({}),
  },
  {
    regex: /^(重做|恢复|前进|redo)$/i,
    commandId: 'redo',
    confidence: 0.95,
    extract: () => ({}),
  },

  // ── select ──
  {
    regex: /^(选中|选择|定位|聚焦)\s*(第)?\s*(\d+)\s*(号|个)?\s*(节点)?/,
    commandId: 'select',
    confidence: 0.9,
    extract: (m) => ({
      selector: { op: 'displayId', value: parseInt(m[3], 10) },
    }),
  },
  {
    regex: /^(选中|选择)?\s*所有\s*(文本|图片|视频|音频|宫格)\s*(节点)?/,
    commandId: 'select',
    confidence: 0.85,
    extract: (m) => ({
      selector: { op: 'type', value: TYPE_MAP[m[3]] || m[3] },
    }),
  },
  {
    regex: /^(选中|选择)?\s*所有\s*(失败|出错|错误)\s*(节点)?/,
    commandId: 'select',
    confidence: 0.85,
    extract: () => ({
      selector: { op: 'status', value: 'error' },
    }),
  },

  // ── query ──
  {
    regex: /^(查看|检查|查询|列出|有几个|有哪些|显示)\s*(所有)?\s*(失败|出错|错误|文本|图片|视频|音频|宫格)\s*(节点)?/,
    commandId: 'query',
    confidence: 0.85,
    extract: (m) => {
      const target = m[3];
      if (target === '失败' || target === '出错' || target === '错误') {
        return { selector: { op: 'status', value: 'error' } };
      }
      return { selector: { op: 'type', value: TYPE_MAP[target] || target } };
    },
  },
  {
    regex: /^(查看|检查|查询|画布上)?\s*(现在有|有几个|有哪些)\s*(节点)?/,
    commandId: 'query',
    confidence: 0.8,
    extract: () => ({}),
  },

  // ── deleteNodes ──
  {
    // “帮我把画布中的视频节点删除掉”——目标在前、动作在后的口语句式
    regex: /^(?:请|麻烦)?\s*(?:帮我)?\s*(?:把)?\s*(?:画布(?:中|上)(?:的)?)?\s*(?:所有|全部)?\s*(文本|图片|视频|音频|宫格)\s*(?:节点)?\s*(?:删除|移除|清除|删掉)\s*(?:掉)?[。！!]?$/,
    commandId: 'deleteNodes',
    confidence: 0.9,
    extract: (m) => ({
      selector: { op: 'type', value: TYPE_MAP[m[1]] },
    }),
  },
  {
    regex: /^(删除|移除|清除|删掉)\s*(所有)?\s*(失败|出错|错误)\s*(节点)?/,
    commandId: 'deleteNodes',
    confidence: 0.9,
    extract: () => ({
      selector: { op: 'status', value: 'error' },
    }),
  },
  {
    regex: /^(删除|移除|清除|删掉)\s*(所有)?\s*(文本|图片|视频|音频|宫格)\s*(节点)?/,
    commandId: 'deleteNodes',
    confidence: 0.85,
    extract: (m) => ({
      selector: { op: 'type', value: TYPE_MAP[m[3]] || m[3] },
    }),
  },
  {
    regex: /^(删除|移除|清除|删掉)\s*(第)?\s*(\d+)\s*(号|个)?\s*(节点)?/,
    commandId: 'deleteNodes',
    confidence: 0.85,
    extract: (m) => ({
      selector: { op: 'displayId', value: parseInt(m[3], 10) },
    }),
  },
  {
    regex: /^(删除|移除|清除|删掉)\s*(所有|全部)?\s*(节点)?$/,
    commandId: 'deleteNodes',
    confidence: 0.7,
    extract: () => ({}),
  },

  // ── cancelTask ──
  {
    regex: /^(取消|停止|中断)\s*(生成|任务|当前)/,
    commandId: 'cancelTask',
    confidence: 0.9,
    extract: () => ({}),
  },
];

/** 中文类型名 → NodeType */
const TYPE_MAP: Record<string, NodeType> = {
  '文本': 'ai-text',
  '图片': 'ai-image',
  '视频': 'ai-video',
  '音频': 'ai-audio',
  '宫格': 'ai-storyboard',
};

const COMMAND_IDS = new Set<CommandId>([
  'query', 'select', 'deleteNodes', 'undo', 'redo', 'connect', 'groupByType',
  'translatePrompt', 'regenerate', 'describe', 'cancelTask',
]);

const NODE_TYPES = new Set<NodeType>([
  'ai-text', 'ai-image', 'ai-video', 'ai-audio', 'ai-panorama',
  'ai-markdown', 'ai-storyboard', 'source-image', 'source-video',
  'source-audio', 'source-text', 'comment',
]);

type NodeStatus = 'idle' | 'loading' | 'success' | 'error';
const NODE_STATUSES = new Set<NodeStatus>(['idle', 'loading', 'success', 'error']);

function normalizeLlmSelector(value: unknown): NodeSelector | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const op = raw.op === 'byType'
    ? 'type'
    : raw.op === 'byStatus'
      ? 'status'
      : raw.op === 'byDisplayId'
        ? 'displayId'
        : raw.op;

  if (op === 'selected') return { op: 'selected' };
  if (op === 'displayId') {
    const displayId = typeof raw.value === 'number' ? raw.value : Number(raw.value);
    return Number.isInteger(displayId) ? { op: 'displayId', value: displayId } : undefined;
  }
  if (op === 'type' && typeof raw.value === 'string' && NODE_TYPES.has(raw.value as NodeType)) {
    return { op: 'type', value: raw.value as NodeType };
  }
  if (op === 'status' && typeof raw.value === 'string' && NODE_STATUSES.has(raw.value as NodeStatus)) {
    return { op: 'status', value: raw.value as NodeStatus };
  }
  if ((op === 'and' || op === 'or') && Array.isArray(raw.items)) {
    const items = raw.items.map(normalizeLlmSelector).filter((item): item is NodeSelector => !!item);
    return items.length > 0 ? { op, items } : undefined;
  }
  if (op === 'not') {
    const item = normalizeLlmSelector(raw.item);
    return item ? { op: 'not', item } : undefined;
  }
  return undefined;
}

export interface LlmIntentResponse {
  reply: string;
  intents: CommandIntent[];
}

/** 解析 LLM 回复末尾的 ```intent JSON 块，并规范化常见 selector 别名。 */
export function parseLlmIntentResponse(input: string): LlmIntentResponse {
  const intents: CommandIntent[] = [];
  const blockPattern = /```intent\s*([\s\S]*?)```/gi;

  for (const match of input.matchAll(blockPattern)) {
    try {
      const raw = JSON.parse(match[1]) as Record<string, unknown>;
      if (typeof raw.commandId !== 'string' || !COMMAND_IDS.has(raw.commandId as CommandId)) continue;
      const selector = normalizeLlmSelector(raw.selector);
      intents.push({
        commandId: raw.commandId as CommandId,
        selector,
        params: raw.params,
        parseSource: 'llm',
        confidence: 0.95,
      });
    } catch {
      // 单个意图块无效时跳过，保留自然语言回复。
    }
  }

  return {
    reply: input.replace(blockPattern, '').trim(),
    intents,
  };
}

// ============================================
// Public API
// ============================================

export interface RulesEngineResult {
  intents: CommandIntent[];
  /** 是否有高置信度（≥0.8）匹配 */
  hasHighConfidence: boolean;
}

/**
 * 解析用户输入，返回匹配的 CommandIntent 列表。
 * 按置信度降序排列，优先返回高置信度规则。
 */
export function parseRules(input: string): RulesEngineResult {
  const trimmed = input.trim();
  if (!trimmed) return { intents: [], hasHighConfidence: false };

  const intents: CommandIntent[] = [];

  for (const pattern of PATTERNS) {
    const match = trimmed.match(pattern.regex);
    if (match) {
      const { selector, params } = pattern.extract(match);
      intents.push({
        commandId: pattern.commandId,
        selector,
        params,
        parseSource: 'rule',
        confidence: pattern.confidence,
      });
    }
  }

  // 按置信度降序
  intents.sort((a, b) => b.confidence - a.confidence);

  // 只保留同一 commandId 的最高置信度匹配
  const seen = new Set<CommandId>();
  const deduped = intents.filter((i) => {
    if (seen.has(i.commandId)) return false;
    seen.add(i.commandId);
    return true;
  });

  const hasHighConfidence = deduped.length > 0 && deduped[0].confidence >= 0.8;

  return { intents: deduped, hasHighConfidence };
}

/**
 * 快速检查：这条文本是否可能是一个画布操作指令（而非纯聊天）。
 */
export function isLikelyCommand(input: string): boolean {
  const cmdKeywords = [
    '选中', '选择', '定位', '聚焦',
    '删除', '移除', '清除', '删掉',
    '查看', '检查', '查询', '列出',
    '撤销', '撤回', '回退', '重做', '恢复',
    '取消', '停止', '中断',
  ];
  const trimmed = input.trim();
  return cmdKeywords.some((kw) => trimmed.includes(kw));
}
