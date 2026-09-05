import type { AgentApprovalInputRequest, ProviderModelCatalogSummary, ProviderModelChoice } from '../../types/agent';
import type { WebReadAccessScope } from '../../types/chat';
import { webReadScopeKey } from './webReadSessionService';

export const PROVIDER_CATALOG_TTL_MS = 10 * 60_000;
export const MAX_PROVIDER_CATALOG_MODELS = 5_000;
export const MAX_PROVIDER_MODEL_SELECTION = 16;
export const PROVIDER_CATALOG_PAGE_SIZE = 20;
const categories = ['text', 'image', 'video', 'audio'] as const;
type Catalog = { summary: ProviderModelCatalogSummary; options: ProviderModelChoice[]; scope: string;
  tasks: Set<string>; timer: ReturnType<typeof setTimeout> };
const catalogs = new Map<string, Catalog>();
let preparedRequests = new WeakMap<object, AgentApprovalInputRequest>();

function remove(id: string) {
  const catalog = catalogs.get(id);
  if (catalog) clearTimeout(catalog.timer);
  catalogs.delete(id);
}
export function createProviderModelCatalog(scope: WebReadAccessScope, models: ProviderModelChoice[]): ProviderModelCatalogSummary {
  if (!models.length || models.length > MAX_PROVIDER_CATALOG_MODELS) throw new Error('模型目录数量超出上限');
  const unique = new Map<string, ProviderModelChoice>();
  for (const model of models) {
    if (typeof model.id !== 'string' || typeof model.name !== 'string' || !categories.includes(model.category)
      || !model.id.trim() || !model.name.trim() || model.id.length > 160 || model.name.length > 160
      || [...model.id + model.name].some((char) => char.charCodeAt(0) < 32)) throw new Error('模型目录包含无效候选项');
    const normalized = { id: model.id.trim(), name: model.name.trim(), category: model.category };
    if (unique.has(normalized.id) && unique.get(normalized.id)!.category !== normalized.category) throw new Error('模型目录包含冲突的模型 ID');
    unique.set(normalized.id, normalized);
  }
  let total = [...catalogs.values()].reduce((sum, value) => sum + value.options.length, 0);
  for (const [id, catalog] of catalogs) {
    if (catalogs.size < 16 && total + unique.size <= 20_000) break;
    total -= catalog.options.length;
    remove(id);
  }
  const options = [...unique.values()];
  const categoryCounts = { text: 0, image: 0, video: 0, audio: 0 };
  for (const model of options) categoryCounts[model.category]++;
  const catalogId = crypto.randomUUID();
  const summary = { catalogId, total: options.length, categoryCounts, expiresAt: Date.now() + PROVIDER_CATALOG_TTL_MS,
    maxSelection: MAX_PROVIDER_MODEL_SELECTION };
  catalogs.set(catalogId, { summary, options, scope: webReadScopeKey(scope), tasks: new Set([scope.taskId]),
    timer: setTimeout(() => remove(catalogId), PROVIDER_CATALOG_TTL_MS) });
  return structuredClone(summary);
}
export function getProviderModelCatalog(scope: WebReadAccessScope, catalogId: string) {
  const catalog = catalogs.get(catalogId);
  if (!catalog || catalog.summary.expiresAt <= Date.now()) {
    remove(catalogId);
    throw new Error('模型目录已失效，请重新读取目录');
  }
  if (catalog.scope !== webReadScopeKey(scope)) throw new Error('模型目录作用域不匹配');
  catalog.tasks.add(scope.taskId);
  return { summary: structuredClone(catalog.summary), options: structuredClone(catalog.options) };
}
export function validateProviderModelSelection(options: ProviderModelChoice[], ids: string[] = []): ProviderModelChoice[] {
  if (!ids.length) throw new Error('用户没有选择任何模型');
  if (ids.length > MAX_PROVIDER_MODEL_SELECTION || new Set(ids).size !== ids.length) {
    throw new Error(`请选择 1 至 ${MAX_PROVIDER_MODEL_SELECTION} 个不重复的模型`);
  }
  const models = new Map(options.map((model) => [model.id, model]));
  if (ids.some((id) => !models.has(id))) throw new Error('选择包含目录之外的模型');
  return ids.map((id) => ({ ...models.get(id)! }));
}
/** Resolution is keyed by the validated input object, never by a model-provided scope. */
export function prepareProviderCatalogSelection<T extends { catalogId?: string; models?: ProviderModelChoice[] }>(input: T, scope: WebReadAccessScope): T {
  if (!!input.catalogId === !!input.models) throw new Error('请只提供 catalogId 或 models 其中一项');
  const resolved = { ...input };
  if (input.catalogId) {
    const catalog = getProviderModelCatalog(scope, input.catalogId);
    preparedRequests.set(resolved, { kind: 'provider_models', options: catalog.options, catalog: catalog.summary,
      maxSelection: MAX_PROVIDER_MODEL_SELECTION });
  }
  return resolved;
}
export function getPreparedProviderCatalogApproval(input: unknown): AgentApprovalInputRequest | undefined {
  return input && typeof input === 'object' ? preparedRequests.get(input) : undefined;
}
export function queryProviderModels(options: ProviderModelChoice[], query = '', category = '', page = 1) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = options.filter((model) => (!category || model.category === category)
    && (!needle || `${model.id} ${model.name}`.toLocaleLowerCase().includes(needle)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PROVIDER_CATALOG_PAGE_SIZE));
  const currentPage = Math.max(1, Math.min(pageCount, Math.floor(page) || 1));
  return { total: filtered.length, page: currentPage, pageCount,
    options: filtered.slice((currentPage - 1) * PROVIDER_CATALOG_PAGE_SIZE, currentPage * PROVIDER_CATALOG_PAGE_SIZE) };
}
export function toggleProviderModelSelection(current: string[], ids: string[], maxSelection = MAX_PROVIDER_MODEL_SELECTION): string[] {
  if (ids.every((id) => current.includes(id))) return current.filter((id) => !ids.includes(id));
  return [...new Set([...current, ...ids])].slice(0, Math.min(maxSelection, MAX_PROVIDER_MODEL_SELECTION));
}
export function clearProviderModelCatalogsForTask(taskId: string) {
  for (const [id, catalog] of catalogs) if (catalog.tasks.has(taskId)) remove(id);
}
export function clearProviderModelCatalogsForTests() {
  for (const id of catalogs.keys()) remove(id);
  preparedRequests = new WeakMap();
}
