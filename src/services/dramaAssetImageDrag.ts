import { t } from '../i18n';
import { computeImageNodeDimensions, generateId, useAppStore, type AppState } from '../store/useAppStore';
import type { BaseNodeData } from '../types';
import type { DramaAsset, DramaAssetKind } from '../types/dramaAssets';
import type { CanvasContext } from '../types/project';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import { canvasMediaImportsPaused, completeCanvasDerivation, isCanvasDerivationFresh,
  registerCanvasImport, trackCanvasMediaImport } from './canvasDerivationGuard';
import { findDramaAssetByKind, listGlobalDramaAssets, resolveDramaAssetImageRef } from './dramaAssetPrompt';
import { copyNodeMedia, discardCopiedNodeMedia, needsNodeMediaCopy } from './nodeMediaCopy';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';

export const DRAMA_ASSET_IMAGE_DRAG_TYPE = 'application/x-ai-canvas-drama-asset-image';

interface ReferenceIdentity {
  scope: 'project' | 'global';
  kind: DramaAssetKind;
  assetId: string;
  referenceId?: string;
}

let activeDrag: (ReferenceIdentity & {
  token: string;
  context: CanvasContext;
  projectSession: object;
  src: string;
  label: string;
}) | undefined;

export function getDramaAssetReferenceSrc(asset: DramaAsset, nodes: AppState['nodes'], referenceId?: string) {
  // 角色库以保存的参考图为准。旧角色和绑定素材可以从对应节点取图。
  const saved = asset.kind === 'character' && referenceId !== undefined
    ? asset.referenceImages?.find((reference) => reference.id === referenceId)?.imageUrl
    : undefined;
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  const resolved = resolveDramaAssetImageRef(asset, nodes, referenceId)?.imageUrl;
  return typeof resolved === 'string' ? resolved.trim() || undefined : undefined;
}

function currentReference(identity: ReferenceIdentity, state: AppState) {
  const asset = identity.scope === 'global'
    ? listGlobalDramaAssets(state).find((item) => item.kind === identity.kind && item.id === identity.assetId)
    : findDramaAssetByKind(state.dramaAssets, identity.kind, identity.assetId);
  return asset && getDramaAssetReferenceSrc(asset, identity.scope === 'project' ? state.nodes : [], identity.referenceId);
}

export function startDramaAssetImageDrag(transfer: DataTransfer, identity: ReferenceIdentity, src: string, label: string) {
  activeDrag = undefined;
  const state = useAppStore.getState();
  if (!state.assetsPanelOpen || state.assetsPanelMode !== 'drawer' || state.projectWorkspaceView === 'script') return false;
  const context = captureLegacyCanvasContext(state);
  if (!context || currentReference(identity, state) !== src) return false;

  const token = crypto.randomUUID();
  // DataTransfer 只承载当前窗口签发的一次性标识。文件和 URL 从现有资产记录解析。
  transfer.clearData();
  transfer.setData(DRAMA_ASSET_IMAGE_DRAG_TYPE, token);
  transfer.effectAllowed = 'copy';
  activeDrag = { ...identity, token, context, projectSession: state.getProjectSessionToken(), src, label };
  return true;
}

export function endDramaAssetImageDrag() {
  activeDrag = undefined;
}

export async function dropDramaAssetImage(token: string, position: { x: number; y: number }) {
  const drag = activeDrag;
  if (!drag || drag.token !== token) return;
  endDramaAssetImageDrag();

  const state = useAppStore.getState();
  if (canvasMediaImportsPaused() || state.getProjectSessionToken() !== drag.projectSession
    || !isProjectExpectedContextCurrent(drag.context, state)) return;
  if (currentReference(drag, state) !== drag.src) {
    state.showToast(t('参考图不可用'), 'error');
    return;
  }
  const source: BaseNodeData = {
    type: 'source-image', role: 'source', status: 'success', label: drag.label, imageUrl: drag.src,
    filePath: localMediaUrlToPath(drag.src),
  };
  const guard = registerCanvasImport(state);
  if (!guard) return;
  const canInsert = (current: AppState) => current.projectWorkspaceView !== 'script'
    && current.getProjectSessionToken() === drag.projectSession
    && !canvasMediaImportsPaused() && isCanvasDerivationFresh(guard, current);
  await trackCanvasMediaImport(guard.projectId, (async () => {
    let prepared = source;
    let inserted = false;
    try {
      if (needsNodeMediaCopy(source)) prepared = await copyNodeMedia(source, guard.projectId);
      if (!canInsert(useAppStore.getState())) return;
      const dimensions = await computeImageNodeDimensions(prepared.imageUrl ?? drag.src);
      const current = useAppStore.getState();
      if (!canInsert(current)) return;
      if (currentReference(drag, current) !== drag.src) {
        current.showToast(t('参考图不可用'), 'error');
        return;
      }
      current.addNode({ id: `node-${generateId()}`, type: 'source-image', position, data: { ...prepared, ...dimensions } });
      inserted = true;
    } catch {
      const current = useAppStore.getState();
      if (canInsert(current)) current.showToast(t('素材复制失败，请重试'), 'error');
    } finally {
      if (!inserted && prepared !== source) await discardCopiedNodeMedia(prepared, source);
      completeCanvasDerivation(guard);
    }
  })());
}
