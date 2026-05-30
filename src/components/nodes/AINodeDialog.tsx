/**
 * AINodeDialog AI 生成弹窗 — 点击节点后弹出的浮动面板，包含 Prompt 输入、模型选择、参数配置、生成按钮
 */
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { BaseNodeData, ModelOption } from '../../types';
import { generateText, generateImage, generateVideo } from '../../services/aiService';
import PromptPanel from './shared/PromptPanel';

function AINodeDialog() {
  const { nodes, activeNodeId, dialogPosition, closeNodeDialog, updateNodeData, showToast, workflows } = useAppStore();

  const node = useMemo(() => nodes.find((n) => n.id === activeNodeId), [nodes, activeNodeId]);
  const data: BaseNodeData | undefined = node?.data;
  const nodeType = data?.type;

  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeNodeDialog();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [closeNodeDialog]);

  // All hooks must be called before any early return
  const onPromptChange = useCallback(
    (value: string) => {
      // Extract workflow IO node assignments from the prompt string
      // Format: @wf{ioNodeId|title|type}(value content)
      // ioNodeId can contain ":" (e.g. "57:27"), fields are pipe-separated to avoid ambiguity
      const workflowInputs: Record<string, string> = {};
      const wfRegex = /@wf\{([^|]+)\|([^|]+)\|([^|}]+)\}\(([\s\S]*?)\)/g;
      let match: RegExpExecArray | null;
      while ((match = wfRegex.exec(value)) !== null) {
        const ioNodeId = match[1]; // Full ID (may contain ":")
        const valueText = match[4].replace(/\n$/, '');
        workflowInputs[ioNodeId] = valueText;
      }
      updateNodeData(activeNodeId!, { prompt: value, workflowInputs: Object.keys(workflowInputs).length > 0 ? workflowInputs : undefined });
    },
    [activeNodeId, updateNodeData]
  );

  // 调用选中模型生成（文本 or 图片）
  const onSubmit = useCallback(async () => {
    if (!data?.prompt?.trim() || !data?.model || !data?.provider) return;
    updateNodeData(activeNodeId!, { status: 'loading', error: undefined });
    try {
      if (nodeType === 'ai-image') {
        const imageSize = (data.imageSize as string) || '2K';
        const aspectRatio = (data.aspectRatio as string) || '1:1';
        const result = await generateImage({
          prompt: data.prompt,
          model: data.model,
          provider: data.provider,
          imageSize,
          aspectRatio,
          workflowId: data.workflowId,
          workflowInputs: data.workflowInputs,
        });
        updateNodeData(activeNodeId!, {
          imageUrl: result.url,
          thumbnailUrl: result.url,
          output: result.url,
          status: 'success',
          imageWidth: result.width,
          imageHeight: result.height,
        });
        showToast('图片生成完成');
      } else if (nodeType === 'ai-video') {
        const result = await generateVideo({
          prompt: data.prompt,
          model: data.model,
          provider: data.provider,
          videoResolution: (data.videoResolution as number) || 832,
          videoFps: (data.videoFps as number) || 24,
          videoFrames: (data.videoFrames as number) || 77,
          workflowId: data.workflowId,
          workflowInputs: data.workflowInputs,
        });
        updateNodeData(activeNodeId!, {
          videoUrl: result.url,
          thumbnailUrl: result.url,
          output: result.url,
          status: 'success',
        });
        showToast('视频生成完成');
      } else {
        const result = await generateText({
          prompt: data.prompt,
          model: data.model,
          provider: data.provider,
        });
        updateNodeData(activeNodeId!, { output: result, status: 'success' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '生成失败';
      updateNodeData(activeNodeId!, { status: 'error', error: msg });
      showToast(msg, 'error');
    }
  }, [activeNodeId, nodeType, data?.prompt, data?.model, data?.provider, data?.imageSize, data?.aspectRatio, data?.videoResolution, data?.videoFps, data?.videoFrames, data?.workflowId, data?.workflowInputs, updateNodeData, showToast]);

  // 直接将输入内容作为节点输出（跳过模型调用）
  const onPassThrough = useCallback(() => {
    if (!data?.prompt?.trim()) return;
    updateNodeData(activeNodeId!, { output: data.prompt, status: 'success' });
  }, [activeNodeId, data?.prompt, updateNodeData]);

  const onModelSelect = useCallback(
    (model: ModelOption) => {
      updateNodeData(activeNodeId!, { model: model.value, provider: model.provider });
    },
    [activeNodeId, updateNodeData]
  );

  const onWorkflowSelect = useCallback(
    (workflowId: string | undefined) => {
      updateNodeData(activeNodeId!, {
        workflowId,
        ...(workflowId ? { provider: 'comfyui', model: 'comfyui/workflow' } : {}),
      });
    },
    [activeNodeId, updateNodeData]
  );

  const onChangeImageSize = useCallback(
    (value: string) => updateNodeData(activeNodeId!, { imageSize: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeAspectRatio = useCallback(
    (value: string) => {
      const updateData: Partial<BaseNodeData> = { aspectRatio: value };

      if (value === '自适应') {
        updateData.nodeWidth = 280;
        updateData.nodeHeight = 280; // Adaptive default for image nodes
      } else {
        const parts = value.split(':');
        if (parts.length === 2) {
          const w = parseFloat(parts[0]);
          const h = parseFloat(parts[1]);
          if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
            const maxDimension = 280; // Bounding box base size
            if (w >= h) {
              updateData.nodeWidth = maxDimension;
              updateData.nodeHeight = Math.round(maxDimension * (h / w));
            } else {
              updateData.nodeHeight = maxDimension;
              updateData.nodeWidth = Math.round(maxDimension * (w / h));
            }
          }
        }
      }

      updateNodeData(activeNodeId!, updateData);
    },
    [activeNodeId, updateNodeData]
  );

  const onChangeVideoResolution = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { videoResolution: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeVideoFps = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { videoFps: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeVideoFrames = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { videoFrames: value }),
    [activeNodeId, updateNodeData]
  );

  // Early return must come after ALL hooks
  if (!activeNodeId || !node || !data || !nodeType) return null;

  return (
    <>
      {/* Transparent overlay — captures clicks outside to close */}
      <div className="ai-dialog-backdrop" onMouseDown={closeNodeDialog} />

      <div
        ref={panelRef}
        className="ai-dialog-float"
        style={{
          left: dialogPosition ? `${dialogPosition.x}px` : '50%',
          top: dialogPosition ? `${dialogPosition.y - 20}px` : '50%',
          transform: dialogPosition ? 'translateX(-50%)' : 'translate(-50%, -50%)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <PromptPanel
          nodeType={nodeType}
          nodeId={activeNodeId}
          prompt={data.prompt || ''}
          placeholder={
            nodeType === 'ai-image'
              ? '描述任何你想要生成的内容，按 @ 引用素材，/呼出指令   (Enter 生成，Shift+Enter 换行)'
              : '输入提示词开始创作   (Enter 生成，Shift+Enter 换行)'
          }
          selectedModel={data.model}
          selectedProvider={data.provider}
          selectedWorkflowId={data.workflowId}
          canGenerate={data.status !== 'loading'}
          onChange={onPromptChange}
          onSubmit={onSubmit}
          onModelSelect={onModelSelect}
          onWorkflowSelect={onWorkflowSelect}
          onPassThrough={(nodeType !== 'ai-image' &&  nodeType !== 'ai-video') ? onPassThrough : undefined}
          imageSize={(data.imageSize as string) || '2K'}
          aspectRatio={(data.aspectRatio as string) || '1:1'}
          onChangeImageSize={onChangeImageSize}
          onChangeAspectRatio={onChangeAspectRatio}
          videoResolution={(data.videoResolution as number) || 832}
          videoFps={(data.videoFps as number) || 24}
          videoFrames={(data.videoFrames as number) || 77}
          onChangeVideoResolution={onChangeVideoResolution}
          onChangeVideoFps={onChangeVideoFps}
          onChangeVideoFrames={onChangeVideoFrames}
          workflows={workflows}
        />
      </div>
    </>
  );
}

export default memo(AINodeDialog);
