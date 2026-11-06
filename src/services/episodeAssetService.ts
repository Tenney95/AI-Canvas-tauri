/** 本集清单的提取、编辑及显式资产库绑定；模型输出从不直接入库。 */
import { t } from '../i18n';
import { useAppStore } from '../store/useAppStore';
import { readEpisodeWorkspaceScope } from './episodeWorkspaceScope';
import type { DramaAsset, DramaCharacter, DramaProp } from '../types/dramaAssets';
import {
  EPISODE_ASSET_LIMITS, episodeScriptFingerprint, normalizeEpisodeAssetRoster,
  type EpisodeAssetEntry, type EpisodeAssetKind, type EpisodeAssetRoster,
} from '../types/episodeAssets';
import { generateText } from './ai/generateText';
import { normalizeAssetKey } from './dramaAssetExtract';
import { copyGlobalDramaAssetsToProject } from './dramaAssetTransferService';
import { expandCharacterWeaponDependencies, remapCharacterWeaponIds } from './characterWeapons';
import {
  buildSeriesAssetExtractionPrompt, getAssetExtractionContextVersion, parseAssetExtractionCandidates, resolveAssetExtractionTextModel, withAssetPublication,
} from './seriesAssetExtractionService';

const listKey = (kind: EpisodeAssetKind) => {
  if (kind !== 'character' && kind !== 'prop') throw new Error(t('资产已变化，请重新选择'));
  return kind === 'character' ? 'characters' : 'props';
};
const nameKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
type Scope = 'project' | 'global';
interface EpisodeContext {
  episodeId: string;
  ownerId: string;
  script: string;
  revision: number;
  version: number;
  sourceVersion: number;
}
const candidateSources = new Map<string, { context: EpisodeContext; kind: EpisodeAssetKind }>();
const episodeSourceVersions = new Map<string, number>();
let stopSourceObservation: (() => void) | undefined;

/** 非画布当前集也要识别“修改后又恢复正文”，而非只比最后一次文本。 */
function episodeSourceVersion(episodeId: string): number {
  if (!stopSourceObservation) {
    stopSourceObservation = useAppStore.subscribe((state, previous) => {
      if (state.projects === previous.projects) return;
      for (const [id, version] of episodeSourceVersions) {
        const before = previous.projects.find((episode) => episode.id === id);
        const after = state.projects.find((episode) => episode.id === id);
        if (before?.episodeScript !== after?.episodeScript || before?.parentId !== after?.parentId) {
          episodeSourceVersions.set(id, version + 1);
        }
      }
    });
  }
  if (!episodeSourceVersions.has(episodeId)) episodeSourceVersions.set(episodeId, 0);
  return episodeSourceVersions.get(episodeId)!;
}
if (import.meta.hot) import.meta.hot.dispose(() => stopSourceObservation?.());

function readContext(episodeId: string, expectedRevision?: number): { context: EpisodeContext; roster: EpisodeAssetRoster } {
  const state = useAppStore.getState();
  const workspace = readEpisodeWorkspaceScope(state, episodeId);
  if (!workspace) throw new Error(t('项目已切换'));
  const { episode, owner } = workspace;
  const roster = normalizeEpisodeAssetRoster(episode.episodeAssetRoster);
  if (expectedRevision !== undefined && roster.revision !== expectedRevision) {
    throw new Error(t('本集清单已变化，请重新操作'));
  }
  return { roster, context: { episodeId, ownerId: owner.id,
    script: episode.episodeScript ?? '', revision: roster.revision, version: getAssetExtractionContextVersion(),
    sourceVersion: episodeSourceVersion(episodeId) } };
}

function assertContext(context: EpisodeContext): void {
  const current = readContext(context.episodeId, context.revision).context;
  if (current.ownerId !== context.ownerId || current.script !== context.script
    || current.version !== context.version || current.sourceVersion !== context.sourceVersion) throw new Error(t('提取来源已变化，请重新提取'));
}

async function saveRoster(context: EpisodeContext, roster: EpisodeAssetRoster): Promise<void> {
  assertContext(context);
  const canvasProjectId = useAppStore.getState().currentProjectId;
  if (!await useAppStore.getState().updateEpisodeAssetRoster(context.episodeId, roster, context.revision,
    { allowSameSeries: true, assertCurrent: () => assertContext(context), assertCommitCurrent: () => {
      const state = useAppStore.getState();
      const scope = readEpisodeWorkspaceScope(state, context.episodeId);
      if (!scope || state.currentProjectId !== canvasProjectId || scope.owner.id !== context.ownerId
        || (scope.episode.episodeScript ?? '') !== context.script || episodeSourceVersion(context.episodeId) !== context.sourceVersion) {
        throw new Error(t('提取来源已变化，请重新提取'));
      }
    } })) {
    throw new Error(t('保存失败'));
  }
}

function getEntry(roster: EpisodeAssetRoster, kind: EpisodeAssetKind, id: string): EpisodeAssetEntry {
  const entry = roster[listKey(kind)].find((item) => item.id === id);
  if (!entry) throw new Error(t('本集条目已删除，请重新选择'));
  return entry;
}

function libraryAsset(kind: EpisodeAssetKind, id: string, scope: Scope): DramaCharacter | DramaProp {
  if ((scope !== 'project' && scope !== 'global') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) {
    throw new Error(t('资产已变化，请重新选择'));
  }
  const state = useAppStore.getState();
  const source = scope === 'project' ? state.dramaAssets[listKey(kind)]
    : kind === 'character' ? state.globalCharacters : state.globalProps;
  const asset = source.find((item) => item.id === id);
  if (!asset || asset.kind !== kind) throw new Error(t('资产已删除，请重新选择'));
  return asset;
}

function entryFromAsset(asset: DramaCharacter | DramaProp, id = crypto.randomUUID()): EpisodeAssetEntry {
  const now = Date.now();
  return { id, kind: asset.kind, name: asset.name, summary: asset.summary,
    visualNotes: asset.visualNotes, notes: '', appearances: asset.appearances,
    evidence: asset.firstSeen,
    ...(asset.kind === 'character' ? { identity: asset.identity, aliases: asset.aliases } : { ownerName: asset.ownerName }),
    createdAt: now, updatedAt: now };
}

/** Stable business identity makes a saved-library / failed-roster retry idempotent. */
async function stableAssetId(identity: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `episode-${Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export async function extractEpisodeAssetCandidates(input: {
  episodeId: string; kind: EpisodeAssetKind;
}): Promise<EpisodeAssetEntry[]> {
  const { context } = readContext(input.episodeId);
  const key = listKey(input.kind);
  if (!context.script.trim()) throw new Error(t('请先填写本集剧本'));
  const model = resolveAssetExtractionTextModel(input.episodeId);
  if (!model) throw new Error(t('请先为当前项目配置文本模型'));
  const prompt = [buildSeriesAssetExtractionPrompt(input.kind, context.script),
    '本集提取要求：只分析上面的本集正文；firstSeen 填首次出现场次及可核对的原文短引，appearances 列本集出现场次；没有明确依据时不补全设定。',
  ].join('\n\n');
  const raw = await generateText({ prompt, model: model.model, provider: model.provider });
  assertContext(context);
  const parsed = parseAssetExtractionCandidates(input.kind, raw);
  const assets = input.kind === 'character' ? parsed.characters : parsed.props;
  if (assets.length > EPISODE_ASSET_LIMITS.entriesPerKind) throw new Error(t('本集条目数量超过限制'));
  const parsedEntries = assets.map((asset) => entryFromAsset(asset));
  const entries = normalizeEpisodeAssetRoster({ version: 1, revision: context.revision,
    characters: input.kind === 'character' ? parsedEntries : [], props: input.kind === 'prop' ? parsedEntries : [] })[key];
  if (entries.length !== assets.length) throw new Error(t('模型返回内容无法解析为资产，请重试'));
  // Keep only a bounded number of pending previews; editing copies preserve IDs.
  for (const entry of entries) candidateSources.set(entry.id, { context, kind: input.kind });
  while (candidateSources.size > EPISODE_ASSET_LIMITS.entriesPerKind * 10) {
    candidateSources.delete(candidateSources.keys().next().value!);
  }
  return entries;
}

export async function mergeEpisodeAssetCandidates(episodeId: string, kind: EpisodeAssetKind,
  candidates: readonly EpisodeAssetEntry[], expectedRevision: number): Promise<void> {
  const { context, roster } = readContext(episodeId, expectedRevision);
  listKey(kind);
  if (!candidates.length) return;
  for (const entry of candidates) {
    const candidate = candidateSources.get(entry.id);
    const source = candidate?.context;
    if (!source || candidate?.kind !== kind || source.episodeId !== episodeId || source.revision !== expectedRevision
      || source.ownerId !== context.ownerId || source.script !== context.script || source.version !== context.version
      || source.sourceVersion !== context.sourceVersion
      || entry.kind !== kind) throw new Error(t('提取来源已变化，请重新提取'));
  }
  const existing = roster[listKey(kind)];
  const names = new Set(existing.map((entry) => nameKey(entry.name)));
  const ids = new Set([...roster.characters, ...roster.props].map((entry) => entry.id));
  const additions = candidates.filter((entry) => {
    const key = nameKey(entry.name);
    if (ids.has(entry.id) || names.has(key)) return false;
    ids.add(entry.id); names.add(key); return true;
  }).map((entry) => ({ ...entry, boundDramaAssetId: undefined }));
  if (existing.length + additions.length > EPISODE_ASSET_LIMITS.entriesPerKind) {
    throw new Error(t('本集条目数量超过限制'));
  }
  await saveRoster(context, { ...roster, [listKey(kind)]: [...existing, ...additions],
    sourceFingerprints: { ...roster.sourceFingerprints, [kind]: episodeScriptFingerprint(context.script) } });
  for (const entry of candidates) candidateSources.delete(entry.id);
}

export async function saveEpisodeAssetEntry(episodeId: string, entry: EpisodeAssetEntry,
  expectedRevision: number): Promise<void> {
  const { context, roster } = readContext(episodeId, expectedRevision);
  const key = listKey(entry.kind);
  const previous = roster[key].find((item) => item.id === entry.id);
  if (!previous && roster[key].length >= EPISODE_ASSET_LIMITS.entriesPerKind) throw new Error(t('本集条目数量超过限制'));
  const now = Date.now();
  const next = { ...entry, createdAt: previous?.createdAt ?? now, updatedAt: now,
    boundDramaAssetId: previous?.boundDramaAssetId };
  const normalized = normalizeEpisodeAssetRoster({ version: 1, revision: roster.revision,
    characters: entry.kind === 'character' ? [next] : [], props: entry.kind === 'prop' ? [next] : [] });
  if (normalized[key].length !== 1) throw new Error(t('请输入名称'));
  if (!previous && [...roster.characters, ...roster.props].some((item) => item.id === entry.id)) {
    throw new Error(t('资产已变化，请重新选择'));
  }
  await saveRoster(context, { ...roster, [key]: previous
    ? roster[key].map((item) => item.id === entry.id ? normalized[key][0] : item)
    : [...roster[key], normalized[key][0]] });
}

export async function removeEpisodeAssetEntry(episodeId: string, entryId: string, kind: EpisodeAssetKind,
  expectedRevision: number): Promise<void> {
  const { context, roster } = readContext(episodeId, expectedRevision);
  getEntry(roster, kind, entryId);
  await saveRoster(context, { ...roster, [listKey(kind)]: roster[listKey(kind)].filter((item) => item.id !== entryId) });
}

async function materializeTarget(context: EpisodeContext, kind: EpisodeAssetKind,
  targetId: string, scope: Scope): Promise<string> {
  const source = libraryAsset(kind, targetId, scope);
  if (scope === 'project') return source.id;
  const copiedId = await stableAssetId(`global:${context.ownerId}:${kind}:${targetId}`);
  assertContext(context);
  const existing = useAppStore.getState().dramaAssets[listKey(kind)].find((asset) => asset.id === copiedId);
  if (existing) return existing.id;
  const initial = useAppStore.getState();
  const globals = [...initial.globalCharacters, ...initial.globalScenes, ...initial.globalProps];
  const sources = expandCharacterWeaponDependencies([source], globals);
  const stableIds = await Promise.all(sources.map((asset) => stableAssetId(`global:${context.ownerId}:${asset.kind}:${asset.id}`)));
  const assertCurrent = () => {
    assertContext(context);
    const state = useAppStore.getState();
    const current = [...state.globalCharacters, ...state.globalScenes, ...state.globalProps];
    if (sources.some((asset) => current.find((item) => item.kind === asset.kind && item.id === asset.id) !== asset)) {
      throw new Error(t('资产已变化，请重新选择'));
    }
  };
  assertCurrent();
  await copyGlobalDramaAssetsToProject({ ownerId: context.ownerId, assets: sources, allAssets: sources, commit: async (assets) => {
    assertCurrent();
    if (assets.length !== sources.length || assets.some((asset, index) => asset.kind !== sources[index].kind)) {
      throw new Error(t('资产已变化，请重新选择'));
    }
    const rootIds = new Map(assets.map((asset, index) => [`${asset.kind}:${asset.id}`, stableIds[index]]));
    const remapped = assets.map((asset) => ({ ...remapCharacterWeaponIds(asset, rootIds), id: rootIds.get(`${asset.kind}:${asset.id}`)! }));
    const library = useAppStore.getState().dramaAssets;
    const existingAssets = [...library.characters, ...library.scenes, ...library.props];
    const additions = remapped.filter((asset) => {
      const previous = existingAssets.find((item) => item.id === asset.id);
      if (!previous) return true;
      // 已物化的武器可由多个角色复用；重试不覆盖本地编辑或创建重复卡片。
      if (previous.kind !== 'prop' || previous.propType !== 'weapon' || asset.kind !== 'prop' || asset.propType !== 'weapon') {
        throw new Error(t('资产已变化，请重新选择'));
      }
      return false;
    });
    await useAppStore.getState().importDramaAssets(additions, { assertCurrent });
  } }, { assertCurrent });
  assertContext(context);
  return libraryAsset(kind, copiedId, 'project').id;
}

export async function bindEpisodeAsset(episodeId: string, entryId: string, kind: EpisodeAssetKind,
  targetId: string | null, scope: Scope, expectedRevision?: number): Promise<void> {
  const { context, roster } = readContext(episodeId, expectedRevision);
  getEntry(roster, kind, entryId);
  if (scope !== 'project' && scope !== 'global') throw new Error(t('资产已变化，请重新选择'));
  return withAssetPublication(context.ownerId, async () => {
    const boundId = targetId === null ? undefined : await materializeTarget(context, kind, targetId, scope);
    assertContext(context);
    if (boundId) libraryAsset(kind, boundId, 'project');
    await saveRoster(context, { ...roster, [listKey(kind)]: roster[listKey(kind)].map((entry) => entry.id === entryId
      ? { ...entry, boundDramaAssetId: boundId, updatedAt: Date.now() } : entry) });
  });
}

export async function addLibraryAssetToEpisode(episodeId: string, kind: EpisodeAssetKind, targetId: string,
  scope: Scope, expectedRevision?: number): Promise<void> {
  const { context, roster } = readContext(episodeId, expectedRevision);
  return withAssetPublication(context.ownerId, async () => {
    if (roster[listKey(kind)].length >= EPISODE_ASSET_LIMITS.entriesPerKind) throw new Error(t('本集条目数量超过限制'));
    libraryAsset(kind, targetId, scope);
    const boundId = await materializeTarget(context, kind, targetId, scope);
    assertContext(context);
    if (roster[listKey(kind)].some((entry) => entry.boundDramaAssetId === boundId)) return;
    const entry = { ...entryFromAsset(libraryAsset(kind, boundId, 'project')), boundDramaAssetId: boundId };
    await saveRoster(context, { ...roster, [listKey(kind)]: [...roster[listKey(kind)], entry] });
  });
}

function assetFromEntry(entry: EpisodeAssetEntry, id: string): DramaCharacter | DramaProp {
  const now = Date.now();
  const base = { id, name: entry.name, key: normalizeAssetKey(entry.name), summary: entry.summary,
    visualNotes: entry.visualNotes, storyRole: entry.notes || undefined, appearances: entry.appearances,
    firstSeen: entry.evidence, importance: 'supporting' as const, confirmed: true,
    createdAt: now, updatedAt: now, source: 'manual' as const };
  return entry.kind === 'character' ? { ...base, kind: 'character', identity: entry.identity || entry.summary,
    aliases: entry.aliases } : { ...base, kind: 'prop', ownerName: entry.ownerName };
}

/** Returns the number of newly bound entries, including recovery after a prior roster-save failure. */
export async function promoteEpisodeAssetEntries(episodeId: string, kind: EpisodeAssetKind,
  entryIds: readonly string[]): Promise<number> {
  const { context, roster } = readContext(episodeId);
  listKey(kind);
  return withAssetPublication(context.ownerId, async () => {
    const entries = [...new Set(entryIds)].map((id) => getEntry(roster, kind, id));
    if (!entries.length) return 0;
    const assets = await Promise.all(entries.map(async (entry) => ({ entry,
      id: await stableAssetId(`candidate:${context.ownerId}:${episodeId}:${entry.id}`) })));
    assertContext(context);
    const library = useAppStore.getState().dramaAssets[listKey(kind)];
    const names = new Map(library.map((asset) => [nameKey(asset.name), asset.id]));
    const additions: DramaAsset[] = [];
    const bindings = new Map<string, string>();
    for (const { entry, id } of assets) {
      if (entry.boundDramaAssetId && library.some((asset) => asset.id === entry.boundDramaAssetId)) continue;
      const existing = library.find((asset) => asset.id === id);
      if (!existing) {
        if (names.has(nameKey(entry.name))) throw new Error(t('资产库中已有同名条目，请绑定已有资产'));
        names.set(nameKey(entry.name), id);
        additions.push(assetFromEntry(entry, id));
      }
      bindings.set(entry.id, id);
    }
    const assertCurrent = () => assertContext(context);
    if (additions.length) await useAppStore.getState().importDramaAssets(additions, { assertCurrent });
    assertCurrent();
    for (const id of bindings.values()) libraryAsset(kind, id, 'project');
    if (bindings.size) await saveRoster(context, { ...roster, [listKey(kind)]: roster[listKey(kind)].map((entry) => {
      const id = bindings.get(entry.id);
      return id ? { ...entry, boundDramaAssetId: id, updatedAt: Date.now() } : entry;
    }) });
    return bindings.size;
  });
}
