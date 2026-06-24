/**
 * MultiSelectToolbar 多选工具栏 — 选中 ≥2 个节点时悬浮显示，支持批量执行和对齐操作
 */
import { memo, useMemo, useCallback, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { getNodeBounds, getParentOffset } from '../../utils/nodeBounds.js';
import type { Node as RFNode } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import AnimatedButton from '../shared/AnimatedButton';
import { generateText, generateImage, generateVideo, generateAudio } from '../../services/aiService';
import { downloadUrlAndSave } from '../../services/fileService';

// ── Align & Distribute config ──
type AlignKey = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
type DistributeKey = 'horizontal' | 'vertical';
type ActionKey = AlignKey | DistributeKey;

interface ToolbarAction {
  icon: string;
  label: string;
  key: ActionKey;
}

const ALIGN_ACTIONS: ToolbarAction[] = [
  { icon: 'material-symbols:align-horizontal-left-rounded', label: '左对齐', key: 'left' },
  { icon: 'material-symbols:align-horizontal-center-rounded', label: '水平居中', key: 'center' },
  { icon: 'material-symbols:align-horizontal-right-rounded', label: '右对齐', key: 'right' },
  { icon: 'material-symbols:align-vertical-top-rounded', label: '顶对齐', key: 'top' },
  { icon: 'material-symbols:align-vertical-center-rounded', label: '垂直居中', key: 'middle' },
  { icon: 'material-symbols:align-vertical-bottom-rounded', label: '底对齐', key: 'bottom' },
];

const DISTRIBUTE_ACTIONS: ToolbarAction[] = [
  { icon: 'material-symbols:horizontal-distribute-rounded', label: '横向平均分布', key: 'horizontal' },
  { icon: 'material-symbols:vertical-distribute-rounded', label: '纵向平均分布', key: 'vertical' },
];

/** 稳定空数组引用 —— 非多选时返回它，避免拖拽期间无谓重渲染 */
const EMPTY_NODES: RFNode<BaseNodeData>[] = [];

function MultiSelectToolbar() {
  const selectedNodeIds = useAppStore(useShallow((s) => s.selectedNodeIds));
  // 仅当选中 ≥2 个节点时才订阅 nodes；否则返回稳定空引用，
  // 这样单节点拖拽（每帧改 nodes）完全不会触发本工具栏重渲染。
  const nodes = useAppStore((s) => (s.selectedNodeIds.length >= 2 ? s.nodes : EMPTY_NODES));
  const setNodes = useAppStore((s) => s.setNodes);
  const recordOutputHistory = useAppStore((s) => s.recordOutputHistory);
  const { flowToScreenPosition } = useReactFlow();
  const [batchRunning, setBatchRunning] = useState(false);

  const selectedCount = selectedNodeIds.length;

  // ── Compute toolbar screen position (centered above selection bounds) ──
  const toolbarScreenPos = useMemo(() => {
    if (selectedCount < 2) return null;
    const sel = nodes.filter((n) => selectedNodeIds.includes(n.id));
    if (sel.length < 2) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of sel) {
      const b = getNodeBounds(node, nodes);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.right > maxX) maxX = b.right;
      if (b.bottom > maxY) maxY = b.bottom;
    }
    return flowToScreenPosition({ x: (minX + maxX) / 2, y: minY });
  }, [selectedNodeIds, nodes, flowToScreenPosition, selectedCount]);

  // ── Alignment ──
  const doAlign = useCallback(
    (key: AlignKey) => {
      const currentNodes = useAppStore.getState().nodes;
      const currentIds = useAppStore.getState().selectedNodeIds;
      if (currentIds.length < 2) return;

      const sel = currentNodes.filter((n) => currentIds.includes(n.id) && n.type !== 'group');
      if (sel.length < 2) return;

      const isX = key === 'left' || key === 'center' || key === 'right';

      useAppStore.getState().commitToHistory();

      const updated = currentNodes.map((n) => {
        if (!currentIds.includes(n.id) || n.type === 'group') return n;
        const b = getNodeBounds(n, currentNodes);
        const po = getParentOffset(n, currentNodes);
        const newPos = { ...n.position };

        if (isX) {
          const target =
            key === 'left' ? Math.min(...sel.map((s) => getNodeBounds(s, currentNodes).x))
            : key === 'center' ? sel.reduce((sum, s) => sum + getNodeBounds(s, currentNodes).centerX, 0) / sel.length
            : Math.max(...sel.map((s) => getNodeBounds(s, currentNodes).right));
          const edgeOffset = key === 'left' ? 0 : key === 'center' ? b.width / 2 : b.width;
          newPos.x = target - po.x - edgeOffset;
        } else {
          const target =
            key === 'top' ? Math.min(...sel.map((s) => getNodeBounds(s, currentNodes).y))
            : key === 'middle' ? sel.reduce((sum, s) => sum + getNodeBounds(s, currentNodes).centerY, 0) / sel.length
            : Math.max(...sel.map((s) => getNodeBounds(s, currentNodes).bottom));
          const edgeOffset = key === 'top' ? 0 : key === 'middle' ? b.height / 2 : b.height;
          newPos.y = target - po.y - edgeOffset;
        }

        return { ...n, position: newPos };
      });

      setNodes(updated as RFNode<BaseNodeData & Record<string, unknown>>[]);
    },
    [setNodes],
  );

  // ── Distribute ──
  const doDistribute = useCallback(
    (key: DistributeKey) => {
      const currentNodes = useAppStore.getState().nodes;
      const currentIds = useAppStore.getState().selectedNodeIds;
      if (currentIds.length < 3) return;

      const sel = currentNodes
        .filter((n) => currentIds.includes(n.id) && n.type !== 'group')
        .map((n) => ({ node: n, bounds: getNodeBounds(n, currentNodes) }));
      if (sel.length < 3) return;

      const isX = key === 'horizontal';

      useAppStore.getState().commitToHistory();

      // sort by target axis position (center)
      const sorted = [...sel].sort((a, b) =>
        isX ? a.bounds.centerX - b.bounds.centerX : a.bounds.centerY - b.bounds.centerY,
      );

      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const step = isX
        ? (last.bounds.centerX - first.bounds.centerX) / (sorted.length - 1)
        : (last.bounds.centerY - first.bounds.centerY) / (sorted.length - 1);

      const posMap = new Map<string, number>();
      sorted.forEach((item, i) => {
        posMap.set(item.node.id, isX ? first.bounds.centerX + step * i : first.bounds.centerY + step * i);
      });

      const updated = currentNodes.map((n) => {
        if (!currentIds.includes(n.id) || n.type === 'group' || !posMap.has(n.id)) return n;
        const b = getNodeBounds(n, currentNodes);
        const po = getParentOffset(n, currentNodes);
        const newPos = { ...n.position };
        const target = posMap.get(n.id)!;

        if (isX) {
          newPos.x = target - po.x - b.width / 2;
        } else {
          newPos.y = target - po.y - b.height / 2;
        }

        return { ...n, position: newPos };
      });

      setNodes(updated as RFNode<BaseNodeData & Record<string, unknown>>[]);
    },
    [setNodes],
  );

  // ── Batch Execute ──
  const executeBatch = useCallback(async () => {
    const state = useAppStore.getState();
    const currentNodes = state.nodes;
    const currentIds = state.selectedNodeIds;
    const { updateNodeData, showToast: toast, currentProjectId } = state;

    const toRun = currentNodes.filter(
      (n) =>
        currentIds.includes(n.id) &&
        n.type !== 'group' &&
        n.data?.type &&
        ['ai-text', 'ai-image', 'ai-video', 'ai-audio'].includes(n.data.type) &&
        n.data?.model &&
        n.data?.provider &&
        (n.data?.prompt || '').trim() &&
        n.data?.status !== 'loading',
    );

    if (toRun.length === 0) {
      toast('选中的节点中没有可执行的（需要配置模型且有 prompt）', 'error');
      return;
    }

    setBatchRunning(true);
    let ok = 0, fail = 0;

    for (const node of toRun) {
      const d = node.data!;
      const nt = d.type as 'ai-text' | 'ai-image' | 'ai-video' | 'ai-audio';
      const prompt = (d.prompt as string) || '';

      updateNodeData(node.id, { status: 'loading', error: undefined });
      try {
        if (nt === 'ai-text') {
          const result = await generateText({ prompt, model: d.model!, provider: d.provider! });
          updateNodeData(node.id, { output: result, status: 'success' });
          recordOutputHistory(node.id, {
            nodeId: node.id,
            nodeLabel: d.label,
            timestamp: Date.now(),
            prompt,
            output: result,
            nodeType: 'ai-text',
            model: d.model!,
            provider: d.provider!,
            status: 'success',
          });
        } else if (nt === 'ai-image') {
          const result = await generateImage({
            prompt, model: d.model!, provider: d.provider!,
            imageSize: (d.imageSize as string) || '2K',
            aspectRatio: (d.aspectRatio as string) || '1:1',
            workflowId: d.workflowId, workflowInputs: d.workflowInputs,
            nodeId: node.id,
          });
          const saved = currentProjectId
            ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-image', d.label).catch(() => null)
            : null;
          const mediaUrl = saved?.assetUrl || result.url;
          updateNodeData(node.id, {
            imageUrl: mediaUrl, sourceUrl: result.url,
            filePath: saved?.filePath, thumbnailUrl: result.url,
            output: result.url, status: 'success',
            imageWidth: result.width, imageHeight: result.height,
          });
          recordOutputHistory(node.id, {
            nodeId: node.id, nodeLabel: d.label, timestamp: Date.now(),
            prompt, output: result.url, nodeType: 'ai-image',
            model: d.model!, provider: d.provider!, status: 'success',
            mediaUrl: result.url, filePath: saved?.filePath,
            params: { imageSize: d.imageSize, aspectRatio: d.aspectRatio },
          });
        } else if (nt === 'ai-video') {
          const result = await generateVideo({
            prompt, model: d.model!, provider: d.provider!,
            videoResolution: (d.videoResolution as number) || 832,
            videoFps: (d.videoFps as number) || 24,
            videoFrames: (d.videoFrames as number) || 77,
            workflowId: d.workflowId, workflowInputs: d.workflowInputs,
            nodeId: node.id,
          });
          const saved = currentProjectId
            ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-video', d.label).catch(() => null)
            : null;
          const mediaUrl = saved?.assetUrl || result.url;
          updateNodeData(node.id, {
            videoUrl: mediaUrl, sourceUrl: result.url,
            filePath: saved?.filePath, thumbnailUrl: result.url,
            output: result.url, status: 'success',
          });
          recordOutputHistory(node.id, {
            nodeId: node.id, nodeLabel: d.label, timestamp: Date.now(),
            prompt, output: result.url, nodeType: 'ai-video',
            model: d.model!, provider: d.provider!, status: 'success',
            mediaUrl: result.url, filePath: saved?.filePath,
            params: { videoResolution: d.videoResolution, videoFps: d.videoFps, videoFrames: d.videoFrames },
          });
        } else {
          const result = await generateAudio({
            prompt, model: d.model!, provider: d.provider!,
            workflowId: d.workflowId, workflowInputs: d.workflowInputs,
            nodeId: node.id,
          });
          const saved = currentProjectId
            ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-audio', d.label).catch(() => null)
            : null;
          const mediaUrl = saved?.assetUrl || result.url;
          updateNodeData(node.id, {
            audioUrl: mediaUrl, sourceUrl: result.url,
            filePath: saved?.filePath, thumbnailUrl: result.url,
            output: result.url, status: 'success',
          });
          recordOutputHistory(node.id, {
            nodeId: node.id, nodeLabel: d.label, timestamp: Date.now(),
            prompt, output: result.url, nodeType: 'ai-audio',
            model: d.model!, provider: d.provider!, status: 'success',
            mediaUrl: result.url, filePath: saved?.filePath,
          });
        }
        ok++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : (typeof err === 'string' && err.trim() ? err : '生成失败');
        updateNodeData(node.id, { status: 'error', error: msg });
        recordOutputHistory(node.id, {
          nodeId: node.id, nodeLabel: d.label, timestamp: Date.now(),
          prompt, output: '', nodeType: nt,
          model: d.model!, provider: d.provider!, status: 'error', error: msg,
        });
        fail++;
      }
    }

    setBatchRunning(false);
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} 个成功`);
    if (fail > 0) parts.push(`${fail} 个失败`);
    toast(`批量生成完成：${parts.join('，')}`, fail > 0 ? 'error' : undefined);
  }, []);

  if (selectedCount < 2 || !toolbarScreenPos) return null;

  return (
    <div
      className="fixed z-[9999] pointer-events-auto flex items-center gap-1 bg-canvas-card/95 border border-canvas-border backdrop-blur-xl rounded-lg px-2 py-1 shadow-xl"
      style={{
        left: toolbarScreenPos.x,
        top: toolbarScreenPos.y - 52,
        transform: 'translate(-50%, -100%)',
      }}
    >
      {/* Batch execute */}
      <AnimatedButton
        data-tooltip="批量生成"
        disabled={batchRunning}
        onClick={executeBatch}
        className="w-8 h-8 rounded flex items-center justify-center transition-colors hover:text-green-300 hover:bg-green-500/15 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Icon icon="material-symbols:play-arrow-rounded" width={28} height={28} />
      </AnimatedButton>

      <div className="w-px h-5 bg-canvas-border" />

      {/* Align buttons */}
      {ALIGN_ACTIONS.map(({ icon, label, key }) => (
        <AnimatedButton
          key={key}
          data-tooltip={label}
          onClick={() => doAlign(key as AlignKey)}
          className="w-8 h-8 rounded flex items-center justify-center transition-colors text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover"
        >
          <Icon icon={icon} width={18} height={18} />
        </AnimatedButton>
      ))}

      {/* Distribute buttons (need ≥3 nodes) */}
      {selectedCount >= 3 && (
        <>
          <div className="w-px h-5 bg-canvas-border" />
          {DISTRIBUTE_ACTIONS.map(({ icon, label, key }) => (
            <AnimatedButton
              key={key}
              data-tooltip={label}
              onClick={() => doDistribute(key as DistributeKey)}
              className="w-8 h-8 rounded flex items-center justify-center transition-colors text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover"
            >
              <Icon icon={icon} width={18} height={18} />
            </AnimatedButton>
          ))}
        </>
      )}
    </div>
  );
}

export default memo(MultiSelectToolbar);
