import { estimateTokens } from './tokenEstimate';

/** Runtime-only reservations shared by concurrent reads in one model round. */
export interface SkillReadBudget {
  remainingTokens: number;
  reserve: (tokens: number) => boolean;
}

export function createSkillReadBudget(tokens: number): SkillReadBudget {
  let remaining = Math.max(0, Math.floor(tokens));
  return {
    get remainingTokens() { return remaining; },
    reserve: (cost) => {
      if (cost > remaining) return false;
      remaining -= cost;
      return true;
    },
  };
}

export interface SkillReadInput {
  skillId: string;
  cursor?: string;
  maxChars?: number;
  query?: string;
  reread?: boolean;
}

export interface SkillReadPage {
  content: string;
  nextCursor?: string;
  complete: boolean;
  alreadyRead: boolean;
  limited: boolean;
  remainingTokens: number;
  matched?: boolean;
}

const pages = new Map<string, Map<string, SkillReadPage>>();
const compactionRequests = new Set<string>();

export function takeSkillCompactionRequest(taskId: string): boolean {
  return compactionRequests.delete(taskId);
}

function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

function boundary(text: string, end: number): number {
  // Do not split UTF-16 surrogate pairs, including emoji at the page boundary.
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) return end - 1;
  return end;
}

export function clearSkillReadTask(taskId: string): void {
  pages.delete(taskId);
  compactionRequests.delete(taskId);
}

/** The caller reauthorizes and reads the current source before every invocation. */
export function readSkillPage(
  taskId: string,
  resource: string,
  source: string,
  input: SkillReadInput,
  budget = createSkillReadBudget(2048),
  serialize: (page: SkillReadPage) => string = JSON.stringify,
): SkillReadPage {
  const query = input.query?.trim() ?? '';
  const identity = fingerprint(JSON.stringify([input.skillId, resource, query, source]));
  let offset = 0;
  if (input.cursor) {
    const match = /^([a-f0-9]+):(\d+)$/.exec(input.cursor);
    offset = Number(match?.[2]);
    if (!match || match[1] !== identity || !Number.isSafeInteger(offset)
      || offset < 0 || offset > source.length || boundary(source, offset) !== offset) {
      throw new Error('Skill 游标已失效或不属于当前资料，请从头读取或重新检索');
    }
  }
  const key = `${identity}:${offset}:${input.maxChars ?? 4000}`;
  const seen = pages.get(taskId)?.get(key);
  if (seen && !input.reread) return { ...seen, content: '', alreadyRead: true, remainingTokens: budget.remainingTokens };
  if (offset === source.length) return { content: '', complete: true, alreadyRead: false, limited: false, remainingTokens: budget.remainingTokens };

  let start = offset;
  if (query) {
    const match = source.indexOf(query, offset);
    if (match < 0) return { content: '', complete: true, matched: false, alreadyRead: false, limited: false, remainingTokens: budget.remainingTokens };
    start = boundary(source, Math.max(offset, match - 250));
  }
  const maxEnd = boundary(source, Math.min(source.length, start + Math.max(1, Math.min(8000, input.maxChars ?? 4000))));
  const makePage = (end: number): SkillReadPage => {
    const complete = end >= source.length || (!!query && source.indexOf(query, end) < 0);
    return {
      content: source.slice(start, end),
      nextCursor: complete ? undefined : `${identity}:${end}`,
      complete,
      alreadyRead: false,
      limited: end < maxEnd,
      remainingTokens: budget.remainingTokens,
      ...(query ? { matched: true } : {}),
    };
  };
  // Estimate the entire serialized response, including escaping and metadata.
  let low = start;
  let high = maxEnd;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(serialize(makePage(boundary(source, mid)))) + 32 <= budget.remainingTokens) low = mid;
    else high = mid - 1;
  }
  const end = boundary(source, low);
  if (end <= start) {
    compactionRequests.add(taskId);
    return {
      content: '', nextCursor: `${identity}:${offset}`, complete: false, alreadyRead: false,
      limited: true, remainingTokens: budget.remainingTokens,
    };
  }
  const page = makePage(end);
  const cost = estimateTokens(serialize(page)) + 32;
  if (!budget.reserve(cost)) return { ...page, content: '', nextCursor: `${identity}:${offset}`, complete: false, limited: true };
  page.remainingTokens = budget.remainingTokens;
  let taskPages = pages.get(taskId);
  if (!taskPages) { taskPages = new Map(); pages.set(taskId, taskPages); }
  taskPages.set(key, { ...page, content: '' });
  return page;
}
