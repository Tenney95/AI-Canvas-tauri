/**
 * AINodeDialog AI 生成弹窗 — 点击节点后弹出的浮动面板，包含 Prompt 输入、模型选择、参数配置、生成按钮
 */
import { memo, useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import type { BaseNodeData, ModelOption } from '../../types';
import { generateText, generateImage, generateVideo, generateAudio, buildPanoramaPrompt } from '../../services/aiService';
import { downloadUrlAndSave } from '../../services/fileService';
import PromptPanel from './shared/PromptPanel';
import type { MentionEditorHandle } from './shared/MentionEditor';
import ConnectedNodesPreview from './shared/ConnectedNodesPreview';

function AINodeDialog() {
  const { activeNodeId, dialogPosition, closeNodeDialog, updateNodeData, recordOutputHistory, showToast, workflows, currentProjectId } = useAppStore(
    useShallow((s) => ({
      activeNodeId: s.activeNodeId,
      dialogPosition: s.dialogPosition,
      closeNodeDialog: s.closeNodeDialog,
      updateNodeData: s.updateNodeData,
      recordOutputHistory: s.recordOutputHistory,
      showToast: s.showToast,
      workflows: s.workflows,
      currentProjectId: s.currentProjectId,
    })),
  );

  // 仅订阅当前激活的节点（而非整个 nodes 数组），拖拽其他节点时不会触发本弹窗重渲染
  const node = useAppStore((s) => (s.activeNodeId ? s.nodes.find((n) => n.id === s.activeNodeId) : undefined));
  const data: BaseNodeData | undefined = node?.data;
  const nodeType = data?.type;

  const panelRef = useRef<HTMLDivElement>(null);
  const editorApiRef = useRef<MentionEditorHandle>(null);

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
  // overridePrompt: / 指令菜单直接触发时传入的整合后模板，不走 store → 对话框不闪烁
  const onSubmit = useCallback(async (overridePrompt?: string) => {
    const effectivePrompt = overridePrompt ?? (() => {
      const latestNode = useAppStore.getState().nodes.find((n) => n.id === activeNodeId);
      const latestData: BaseNodeData | undefined = latestNode?.data;
      return (latestData?.prompt as string) || '';
    })();
    if (!effectivePrompt.trim()) {
      showToast('请输入提示词', 'error');
      return;
    }
    if (!data?.model || !data?.provider) {
      showToast('请先在底部模型选择器中选择一个模型', 'error');
      return;
    }
    const submittingNodeId = activeNodeId!;
    const submittingProjectId = currentProjectId;
    const isStillCurrentSubmission = () => {
      const state = useAppStore.getState();
      return (
        state.currentProjectId === submittingProjectId
        && state.nodes.some((n) => n.id === submittingNodeId)
      );
    };
    updateNodeData(activeNodeId!, { status: 'loading', error: undefined });
    try {
      if (nodeType === 'ai-image') {
        const imageSize = (data.imageSize as string) || '2K';
        const aspectRatio = (data.aspectRatio as string) || '1:1';
        const result = await generateImage({
          prompt: effectivePrompt,
          model: data.model!,
          provider: data.provider!,
          imageSize,
          aspectRatio,
          workflowId: data.workflowId,
          workflowInputs: data.workflowInputs,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        // 下载远程 URL 到本地项目目录
        const saved = currentProjectId
          ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-image', data.label).catch(() => null)
          : null;
        const mediaUrl = saved?.assetUrl || result.url;
        updateNodeData(activeNodeId!, {
          imageUrl: mediaUrl,
          sourceUrl: result.url,
          filePath: saved?.filePath,
          thumbnailUrl: result.url,
          output: result.url,
          status: 'success',
          imageWidth: result.width,
          imageHeight: result.height,
        });
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: data.label,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: result.url,
          nodeType: 'ai-image',
          model: data.model!,
          provider: data.provider!,
          status: 'success',
          mediaUrl: result.url,
          filePath: saved?.filePath,
          params: { imageSize, aspectRatio },
        });
        showToast('图片生成完成');
      } else if (nodeType === 'ai-panorama') {
        const imageSize = (data.imageSize as string) || '2K';
        const aspectRatio = (data.aspectRatio as string) || '2:1';
        const fullPrompt = buildPanoramaPrompt(effectivePrompt);
        const result = await generateImage({
          prompt: fullPrompt,
          model: data.model!,
          provider: data.provider!,
          imageSize,
          aspectRatio,
          workflowId: data.workflowId,
          workflowInputs: data.workflowInputs,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        const saved = currentProjectId
          ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-panorama', data.label).catch(() => null)
          : null;
        const mediaUrl = saved?.assetUrl || result.url;
        updateNodeData(activeNodeId!, {
          imageUrl: mediaUrl,
          sourceUrl: result.url,
          filePath: saved?.filePath,
          thumbnailUrl: result.url,
          output: result.url,
          status: 'success',
          imageWidth: result.width,
          imageHeight: result.height,
        });
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: data.label,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: result.url,
          nodeType: 'ai-panorama',
          model: data.model!,
          provider: data.provider!,
          status: 'success',
          mediaUrl: result.url,
          filePath: saved?.filePath,
          params: { imageSize, aspectRatio },
        });
        showToast('全景图生成完成');
      } else if (nodeType === 'ai-video') {
        const videoResolution = (data.videoResolution as number) || 832;
        const videoFps = (data.videoFps as number) || 24;
        const videoFrames = (data.videoFrames as number) || 77;
        const result = await generateVideo({
          prompt: effectivePrompt,
          model: data.model!,
          provider: data.provider!,
          videoResolution,
          videoFps,
          videoFrames,
          workflowId: data.workflowId,
          workflowInputs: data.workflowInputs,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        // 下载远程 URL 到本地项目目录
        const saved = currentProjectId
          ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-video', data.label).catch(() => null)
          : null;
        const mediaUrl = saved?.assetUrl || result.url;
        updateNodeData(activeNodeId!, {
          videoUrl: mediaUrl,
          sourceUrl: result.url,
          filePath: saved?.filePath,
          thumbnailUrl: result.url,
          output: result.url,
          status: 'success',
        });
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: data.label,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: result.url,
          nodeType: 'ai-video',
          model: data.model!,
          provider: data.provider!,
          status: 'success',
          mediaUrl: result.url,
          filePath: saved?.filePath,
          params: { videoResolution, videoFps, videoFrames },
        });
        showToast('视频生成完成');
      } else if (nodeType === 'ai-audio') {
        const result = await generateAudio({
          prompt: effectivePrompt,
          model: data.model!,
          provider: data.provider!,
          workflowId: data.workflowId,
          workflowInputs: data.workflowInputs,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        // 下载远程 URL 到本地项目目录
        const saved = currentProjectId
          ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-audio', data.label).catch(() => null)
          : null;
        const mediaUrl = saved?.assetUrl || result.url;
        updateNodeData(activeNodeId!, {
          audioUrl: mediaUrl,
          sourceUrl: result.url,
          filePath: saved?.filePath,
          thumbnailUrl: result.url,
          output: result.url,
          status: 'success',
        });
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: data.label,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: result.url,
          nodeType: 'ai-audio',
          model: data.model!,
          provider: data.provider!,
          status: 'success',
          mediaUrl: result.url,
          filePath: saved?.filePath,
        });
        showToast('音频生成完成');
      } else {
        const result = await generateText({
          prompt: effectivePrompt,
          model: data.model!,
          provider: data.provider!,
        });
        updateNodeData(activeNodeId!, { output: result, status: 'success' });
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: data.label,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: result,
          nodeType: 'ai-text',
          model: data.model!,
          provider: data.provider!,
          status: 'success',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : (typeof err === 'string' && err.trim() ? err : '生成失败');
      if (msg === '任务已被取消') {
        return;
      }
      if (!isStillCurrentSubmission()) return;
      updateNodeData(activeNodeId!, { status: 'error', error: msg });
      recordOutputHistory(activeNodeId!, {
        nodeId: activeNodeId!,
        nodeLabel: data.label,
        timestamp: Date.now(),
        prompt: effectivePrompt,
        output: '',
        nodeType: nodeType as 'ai-text' | 'ai-image' | 'ai-video' | 'ai-audio' | 'ai-panorama',
        model: data.model!,
        provider: data.provider!,
        status: 'error',
        error: msg,
      });
      showToast(msg, 'error');
    }
  }, [activeNodeId, nodeType, data?.model, data?.provider, data?.label, data?.imageSize, data?.aspectRatio, data?.videoResolution, data?.videoFps, data?.videoFrames, data?.workflowId, data?.workflowInputs, currentProjectId, updateNodeData, recordOutputHistory, showToast]);

  // 直接将输入内容作为节点输出（跳过模型调用）
  const onPassThrough = useCallback(() => {
    if (!data?.prompt?.trim() || !data?.type) return;
    updateNodeData(activeNodeId!, { output: data.prompt, status: 'success' });
    recordOutputHistory(activeNodeId!, {
      nodeId: activeNodeId!,
      nodeLabel: data.label,
      timestamp: Date.now(),
      prompt: data.prompt,
      output: data.prompt,
      nodeType: data.type,
      model: data.model || 'passthrough',
      provider: data.provider || 'passthrough',
      status: 'success',
    });
  }, [activeNodeId, data?.prompt, data?.label, data?.type, data?.model, data?.provider, updateNodeData, recordOutputHistory]);

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

  const onStyleChange = useCallback(
    (styleId: string) => updateNodeData(activeNodeId!, { style: styleId }),
    [activeNodeId, updateNodeData]
  );

  // Early return must come after ALL hooks
  if (!activeNodeId || !node || !data || !nodeType) return null;

  const handleInsertMention = (mentionStr: string) => {
    // 优先在编辑器的「当前光标位置」插入引用芯片（点击 float 时编辑器焦点仍在）
    const m = mentionStr.match(/^@\{([^:]+):([^}]+)\}$/);
    if (m && editorApiRef.current) {
      editorApiRef.current.insertMentionAtCursor(m[1], m[2]);
      return;
    }
    // 兜底：编辑器未就绪或非节点引用 → 追加到末尾（读 store 实时 prompt，避免覆盖刚输入内容）
    const liveData = useAppStore.getState().nodes.find((n) => n.id === activeNodeId)?.data;
    const currentPrompt = ((liveData?.prompt ?? data.prompt) as string) || '';
    const newPrompt = currentPrompt ? `${currentPrompt} ${mentionStr}` : mentionStr;
    updateNodeData(activeNodeId, { prompt: newPrompt });
  };

  return (
    <>
      {/* Transparent overlay — captures clicks outside to close */}
      <div className="ai-dialog-backdrop" onMouseDown={closeNodeDialog} />

      {/* Connected nodes preview — above backdrop, below dialog (model-dropdown covers it) */}
      <div
        className="ai-dialog-preview-float"
        style={dialogPosition ? {
          left: `${dialogPosition.x}px`,
          top: `${dialogPosition.y - 10 - 42}px`,
          transform: 'translateX(-50%)',
        } : undefined}
      >
        <ConnectedNodesPreview nodeId={activeNodeId} onInsertMention={handleInsertMention} />
      </div>

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
          editorRef={editorApiRef}
          nodeType={nodeType}
          nodeId={activeNodeId}
          prompt={data.prompt || ''}
          placeholder={`描述任何你想要生成的内容，按 @ 引用素材，/呼出指令\n(Enter 生成，Shift+Enter 换行)`}
          selectedModel={data.model}
          selectedProvider={data.provider}
          selectedWorkflowId={data.workflowId}
          canGenerate={data.status !== 'loading'}
          onChange={onPromptChange}
          onSubmit={onSubmit}
          onModelSelect={onModelSelect}
          onWorkflowSelect={onWorkflowSelect}
          onPassThrough={(nodeType !== 'ai-image' && nodeType !== 'ai-video' && nodeType !== 'ai-audio') ? onPassThrough : undefined}
          imageSize={(data.imageSize as string) || '2K'}
          aspectRatio={(data.aspectRatio as string) || (nodeType === 'ai-panorama' ? '2:1' : '1:1')}
          onChangeImageSize={onChangeImageSize}
          onChangeAspectRatio={onChangeAspectRatio}
          videoResolution={(data.videoResolution as number) || 832}
          videoFps={(data.videoFps as number) || 24}
          videoFrames={(data.videoFrames as number) || 77}
          onChangeVideoResolution={onChangeVideoResolution}
          onChangeVideoFps={onChangeVideoFps}
          onChangeVideoFrames={onChangeVideoFrames}
          workflows={workflows}
          selectedStyle={data.style as string | undefined}
          onStyleChange={onStyleChange}
        />
      </div>
    </>
  );
}

export default memo(AINodeDialog);
