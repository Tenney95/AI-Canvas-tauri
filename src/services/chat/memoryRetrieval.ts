import {
  PROJECT_MEMORY_KIND_PRIORITY,
  type ProjectMemory,
} from '../../types/memory';

const DAY_MS = 24 * 60 * 60 * 1000;

function terms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().normalize('NFKC');
  const output = new Set<string>();
  for (const word of normalized.match(/[a-z0-9_-]{2,}/g) ?? []) output.add(word);
  const cjk = [...normalized].filter((char) => /[\u3400-\u9fff]/.test(char));
  for (const char of cjk) output.add(char);
  for (let index = 0; index < cjk.length - 1; index += 1) {
    output.add(`${cjk[index]}${cjk[index + 1]}`);
  }
  return output;
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / Math.max(1, left.size);
}

function diversitySimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

interface ScoredMemory {
  memory: ProjectMemory;
  score: number;
  terms: Set<string>;
}

export interface RankProjectMemoriesOptions {
  now?: number;
  limit?: number;
  mmrLambda?: number;
}

export function rankProjectMemories(
  memories: ProjectMemory[],
  projectId: string,
  query: string,
  options: RankProjectMemoriesOptions = {},
): ProjectMemory[] {
  const now = options.now ?? Date.now();
  const queryTerms = terms(query);
  const scored: ScoredMemory[] = memories
    .filter((memory) => memory.projectId === projectId && memory.enabled)
    .map((memory) => {
      const memoryTerms = terms(memory.content);
      const lexical = similarity(queryTerms, memoryTerms);
      const kind = (3 - PROJECT_MEMORY_KIND_PRIORITY[memory.kind]) / 3;
      const ageDays = Math.max(0, now - memory.updatedAt) / DAY_MS;
      const recency = 2 ** (-ageDays / 30);
      return {
        memory,
        terms: memoryTerms,
        score: queryTerms.size > 0
          ? lexical * 0.78 + kind * 0.14 + recency * 0.08
          : kind * 0.7 + recency * 0.3,
      };
    });

  const selected: ScoredMemory[] = [];
  const remaining = [...scored];
  const limit = Math.max(1, options.limit ?? remaining.length);
  const lambda = Math.min(1, Math.max(0, options.mmrLambda ?? 0.78));
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const redundancy = selected.length === 0
        ? 0
        : Math.max(...selected.map((item) => diversitySimilarity(candidate.terms, item.terms)));
      const mmr = lambda * candidate.score - (1 - lambda) * redundancy;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected.map((item) => item.memory);
}

