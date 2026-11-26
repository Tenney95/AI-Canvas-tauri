/** 新项目本机交换记录、修订历史和发布回执的校验。 */
import type { ProjectModelTransferExchange } from '../../types/projectModelTransfer';
import { projectModelSourceToken } from './projectModelStagingRepository';
import { safeExchangePath } from '../projectExchangeDomain';
import { parseProjectExchangeBundleV2 } from '../projectExchangeV2Format';
import { PROJECT_EXCHANGE_LIMITS } from '../projectExchangeFormat';

const error = (code: string) => new Error('项目模型隔离传输未完成：' + code);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const operation = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function compare(left: unknown, right: unknown): boolean { return projectModelSourceToken(left) === projectModelSourceToken(right); }
function reference(value: { canonicalVersion: number; revisionId: string }): void {
  if (![1, 2].includes(value.canonicalVersion) || !hash(value.revisionId)) throw error('invalid-head-reference');
}
function closed(value: object, fields: readonly string[]): void {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((field) => !fields.includes(field))) throw error('unsupported-transfer-fields');
}
function validateExchange(value: ProjectModelTransferExchange | null): void {
  if (value === null) return;
  closed(value, ['lineageId', 'localHead', 'stateVersion', 'bundle', 'identities', 'fileBindings', 'published']);
  if (!id(value.lineageId) || !integer(value.stateVersion) || value.stateVersion < 1 || !Array.isArray(value.published)
    || !Array.isArray(value.identities) || !Array.isArray(value.fileBindings) || value.bundle?.version !== 2 || value.bundle.lineageId !== value.lineageId
    || value.identities.length > PROJECT_EXCHANGE_LIMITS.entities || value.fileBindings.length > PROJECT_EXCHANGE_LIMITS.media
    || !compare(value.localHead, value.bundle.head)) throw error('invalid-exchange-state');
  reference(value.localHead);
  const logical = new Set<string>(), local = new Set<string>();
  for (const mapping of value.identities) {
    closed(mapping, ['kind', 'sourceId', 'localId']);
    const sourceKey = JSON.stringify([mapping.kind, mapping.sourceId]), localKey = JSON.stringify([mapping.kind, mapping.localId]);
    if (!['project', 'episode', 'canvas', 'storage-root'].includes(mapping.kind) || !id(mapping.sourceId) || !id(mapping.localId)
      || logical.has(sourceKey) || local.has(localKey)) throw error('invalid-exchange-identities');
    logical.add(sourceKey); local.add(localKey);
  }
  const fileIds = new Set<string>(), paths = new Set<string>(), localPaths = new Set<string>();
  for (const binding of value.fileBindings) {
    closed(binding, ['id', 'rootRef', 'relativePath', 'localRelativePath']);
    if (!id(binding.id) || !id(binding.rootRef)) throw error('invalid-file-binding');
    safeExchangePath(binding.relativePath); safeExchangePath(binding.localRelativePath);
    const path = JSON.stringify([binding.rootRef, binding.relativePath]), localPath = JSON.stringify([binding.rootRef, binding.localRelativePath.normalize('NFC').toLowerCase()]);
    if (fileIds.has(binding.id) || paths.has(path) || localPaths.has(localPath)) throw error('duplicate-file-binding');
    fileIds.add(binding.id); paths.add(path); localPaths.add(localPath);
  }
  for (const item of value.published) {
    closed(item, ['operationId', 'packageDigest', 'outputRef', 'head']);
    if (!operation(item.operationId) || !hash(item.packageDigest) || !opaque(item.outputRef)) throw error('invalid-publication-receipt');
    reference(item.head);
  }
}
/** 仅读取新项目本机记录：早期原生导出误把统计字段写入 published，外部归档仍走严格合同。 */
export function readNativeProjectExchange(value: ProjectModelTransferExchange | null): ProjectModelTransferExchange | null {
  if (value === null) return null;
  closed(value, ['lineageId', 'localHead', 'stateVersion', 'bundle', 'identities', 'fileBindings', 'published']);
  if (!Array.isArray(value.published)) throw error('invalid-exchange-state');
  const published = value.published.map((receipt) => {
    if (!receipt || !Object.hasOwn(receipt, 'archiveBytes')) return receipt;
    closed(receipt, ['operationId', 'packageDigest', 'outputRef', 'head', 'archiveBytes']);
    const { archiveBytes, ...canonical } = receipt as typeof receipt & { archiveBytes: unknown };
    if (typeof archiveBytes !== 'number' || !Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) throw error('invalid-publication-receipt');
    return canonical;
  });
  const normalized = { ...value, published };
  validateExchange(normalized);
  return normalized;
}
export async function verifiedExchange(value: ProjectModelTransferExchange | null, previous: ProjectModelTransferExchange | null = null): Promise<void> {
  validateExchange(value);
  if (!value) { if (previous) throw error('cannot-drop-exchange-history'); return; }
  if (value.stateVersion !== (previous?.stateVersion ?? 0) + 1) throw error('exchange-state-version-conflict');
  value.bundle = await parseProjectExchangeBundleV2(value.bundle);
  const head = value.bundle.revisions.find((revision) => revision.canonicalVersion === value.bundle.head.canonicalVersion
    && revision.revisionId === value.bundle.head.revisionId);
  if (!head || head.canonicalVersion !== 2) throw error('missing-head');
  const files = head.snapshot.entities.filter((entity) => entity.kind === 'file');
  if (files.length !== value.fileBindings.length || files.some((file) => !value.fileBindings.some((binding) => binding.id === file.id
    && binding.rootRef === file.data.rootRef && binding.relativePath === file.data.relativePath
    && value.identities.some((mapping) => mapping.kind === 'storage-root' && mapping.sourceId === binding.rootRef)))) throw error('file-binding-closure');
  if (!previous) return;
  if (value.lineageId !== previous.lineageId) throw error('lineage-changed');
  if (!previous.identities.every((old) => value.identities.some((mapping) => compare(old, mapping)))) throw error('accepted-identities-changed');
  const keyOf = (item: { canonicalVersion: number; revisionId: string }) => JSON.stringify([item.canonicalVersion, item.revisionId]);
  const graph = new Map([...value.bundle.revisions, ...value.bundle.ancestors].map((entry) => [keyOf(entry), entry]));
  const previousGraph = new Map([...previous.bundle.revisions, ...previous.bundle.ancestors].map((entry) => [keyOf(entry), entry]));
  type Entry = NonNullable<ReturnType<typeof graph.get>>;
  const parents = (entry: Entry) => entry.canonicalVersion === 1
    ? entry.parentRevisionIds.map((revisionId) => ({ canonicalVersion: 1 as const, revisionId })) : entry.parents;
  const header = (entry: Entry) => 'snapshot' in entry
    ? Object.fromEntries(Object.entries(entry).filter(([field]) => field !== 'snapshot')) : entry;
  // 旧版会随包携带从旧 head 不可达的支线；这些记录不构成它的已接受父链。
  const previouslyReachable = new Set<string>(), previousPending = [previous.localHead];
  while (previousPending.length) {
    const key = keyOf(previousPending.pop()!), old = previousGraph.get(key);
    if (!old || previouslyReachable.has(key)) continue;
    previouslyReachable.add(key); previousPending.push(...parents(old));
  }
  // 只有明确声明的历史边界以外才可移出已接受图。边界不能替代仍须可达的上一个 head。
  const outsideBoundary = new Set<string>(), cut = [...(value.bundle.historyBoundary ?? [])];
  while (cut.length) {
    const key = keyOf(cut.pop()!), old = previousGraph.get(key);
    if (!old || outsideBoundary.has(key)) continue;
    outsideBoundary.add(key); cut.push(...parents(old));
  }
  for (const old of [...previous.bundle.revisions, ...previous.bundle.ancestors]) {
    const retained = graph.get(keyOf(old));
    if (!retained) {
      if (previouslyReachable.has(keyOf(old)) && !outsideBoundary.has(keyOf(old))) throw error('accepted-history-truncated');
      continue;
    }
    if (!compare(header(old), header(retained)) || 'snapshot' in old && 'snapshot' in retained && !compare(old, retained)) throw error('immutable-revision-conflict');
  }
  const pending = [value.localHead], seen = new Set<string>();
  let reaches = false;
  while (pending.length) {
    const current = pending.pop()!, keyValue = keyOf(current);
    const revision = graph.get(keyValue);
    if (!revision) continue;
    if (keyValue === keyOf(previous.localHead)) { reaches = true; break; }
    if (seen.has(keyValue)) continue; seen.add(keyValue);
    pending.push(...parents(revision));
  }
  if (!reaches) throw error('new-head-does-not-preserve-current');
  if (!previous.published.every((receipt) => value.published.some((item) => compare(item, receipt)))) throw error('publication-history-truncated');
}
