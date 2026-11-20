/**
 * PromptChipViewer — 提供提示词引用胶囊界面与交互。
 */
import type { ReactNode } from 'react';
import ViewportImage from '../../shared/ViewportImage';
import { t } from '../../../i18n';
import { Icon } from '@iconify/react';
import type {
  CharacterReferenceImage,
  DramaAssetLibrary,
  DramaAsset,
  DramaCharacter,
} from '../../../types/dramaAssets';
import { getFileCategory } from '../../../services/fileService';
import { parseDramaMentionId } from '../../../types/dramaAssets';
import { findDramaAsset, resolveDramaActionMediaRef, resolveDramaAssetImageRef } from '../../../services/dramaAssetPrompt';
import {
  bestNodeThumb, getNodeChipIconPath, getNodeMetaMap, numberMediaReferenceLabels,
  NODE_CHIP_STYLE, WORKFLOW_CHIP_STYLE, WORKFLOW_CHIP_ICON,
} from './mentionEditorDom';
import { parseShotlistRowMentionId } from '../../../types/shotlist';
import { parseComfyRefmodMentions } from '../../../utils/comfyRefmodMention';

export interface PromptChipRenderOptions {
  nodes?: Array<{ id: string; data?: Record<string, unknown> }>;
  dramaAssets?: DramaAssetLibrary;
  globalAssets?: readonly DramaAsset[];
  globalCharacters?: readonly DramaCharacter[];
  nodeMetaMap?: ReturnType<typeof getNodeMetaMap>;
  emptyText?: string;
  /** 独立窗口可能只同步缩略投影；缺少完整元数据时保留令牌中的标签。 */
  fallbackToTokenLabel?: boolean;
}

function promptChipPattern() {
  return /@asset\{([^}]+)\}|@drama\{([^:}]+):([^}]*)\}|@\{([^:}]+):([^}]*)\}|@wf\{([^|}]+)\|([^|}]+)\|([^|}]+)\}|@skill\{([^|}]+)\|([^}]*)\}|@model\{([^|}]+)\|([^}]*)\}|@image\{(chat-ref-[a-f0-9-]{36}\.(?:png|jpg|webp))\|([^}]*)\}|@refmod\{([^}]*)\}/g;
}

/** 与可编辑胶囊相同，按括号深度读取完整工作流值，保留其中的引用令牌。 */
function readWorkflowValue(prompt: string, start: number): { value?: string; end: number } {
  if (prompt[start] !== '(') return { end: start };
  let depth = 1;
  let index = start + 1;
  while (index < prompt.length && depth > 0) {
    if (prompt[index] === '(') depth += 1;
    else if (prompt[index] === ')') depth -= 1;
    index += 1;
  }
  // 未闭合时保留后面的原始正文，不吞掉其它引用。
  return depth === 0 ? { value: prompt.slice(start + 1, index - 1), end: index } : { end: start };
}

/** 为 Markdown 提供完整的原始引用范围，工作流括号值与头部保持原子身份。 */
export function findPromptChipRanges(prompt: string): Array<{ start: number; end: number }> {
  const regex = promptChipPattern();
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    if (match[6] !== undefined) regex.lastIndex = readWorkflowValue(prompt, regex.lastIndex).end;
    ranges.push({ start: match.index, end: regex.lastIndex });
  }
  return ranges;
}

/** 把包含 @提及标记的提示词渲染为与 MentionEditor 一致的彩色标签芯片 */
export function renderPromptWithChips(
  prompt: string,
  options: PromptChipRenderOptions = {},
): ReactNode {
  if (!prompt || !prompt.trim()) {
    return options.emptyText ?? t('暂无生成信息');
  }

  const regex = promptChipPattern();
  if (!regex.test(prompt)) {
    return prompt;
  }
  regex.lastIndex = 0;

  const nodes = options.nodes;
  const dramaAssets = options.dramaAssets;
  const globalAssets = options.globalAssets ?? options.globalCharacters;
  const metaMap = options.nodeMetaMap || (nodes ? getNodeMetaMap(nodes as never) : new Map());

  // 与 MentionEditor 共用按媒体类型分别编号的规则。
  const references: Parameters<typeof numberMediaReferenceLabels>[0] = [];
  let scanMatch: RegExpExecArray | null;
  while ((scanMatch = regex.exec(prompt)) !== null) {
    if (scanMatch[1] !== undefined) {
      let path = scanMatch[1];
      try { path = decodeURIComponent(scanMatch[1]); } catch { /* 保留原值 */ }
      const name = path.split(/[\\/]/).pop() || '';
      references.push(getFileCategory(name) === 'image' ? { kind: 'image', key: `asset:${encodeURIComponent(path)}` } : undefined);
    } else if (scanMatch[2] !== undefined) {
      const dramaId = scanMatch[2];
      const { assetId, actionId, actionMediaId, voiceClipId } = parseDramaMentionId(dramaId);
      const asset = dramaAssets ? findDramaAsset(dramaAssets, assetId, globalAssets) : undefined;
      const action = actionId !== undefined ? resolveDramaActionMediaRef(asset, actionId, actionMediaId) : undefined;
      references.push({ kind: voiceClipId !== undefined ? 'audio' : action?.kind === 'video' ? 'video' : 'image', key: `drama:${dramaId}` });
    } else if (scanMatch[4] !== undefined) {
      const nodeId = scanMatch[4];
      const meta = metaMap.get(nodeId);
      references.push(meta?.mediaReference || (meta?.imageReferenceKey
        ? { kind: 'image', key: meta.imageReferenceKey }
        : !meta && !parseShotlistRowMentionId(nodeId) ? { kind: 'image', key: `node:${nodeId}` } : undefined));
    } else if (scanMatch[13] !== undefined) {
      references.push({ kind: 'image', key: `chat-image:${scanMatch[13]}` });
    } else {
      references.push(undefined);
    }
    if (scanMatch[6] !== undefined) regex.lastIndex = readWorkflowValue(prompt, regex.lastIndex).end;
  }
  const referenceLabels = numberMediaReferenceLabels(references);
  regex.lastIndex = 0;

  const elements: ReactNode[] = [];
  let lastIndex = 0;
  let matchIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(prompt)) !== null) {
    if (match.index > lastIndex) {
      elements.push(prompt.slice(lastIndex, match.index));
    }
    const currentIdx = matchIdx++;

    if (match[1] !== undefined) {
      let path = match[1];
      try { path = decodeURIComponent(match[1]); } catch { /* 保留原值 */ }
      const name = path.split(/[\\/]/).pop() || 'asset';
      const isImage = getFileCategory(name) === 'image';
      const referenceLabel = referenceLabels[currentIdx];
      const displayName = name.length > 18 ? `${name.slice(0, 16)}…` : name;

      elements.push(
        <span key={`asset-${match.index}`} className="prompt-chip chip-asset cursor-pointer" data-asset-path={path} title={name} role="button" tabIndex={0}>
          <span className="prompt-chip-icon">{isImage ? '🖼' : '📄'}</span>
          <span className="prompt-chip-id">{displayName}</span>
          {referenceLabel !== undefined && (
            <span className="prompt-chip-id prompt-chip-image-index prompt-chip-media-index text-canvas-text-secondary">{referenceLabel}</span>
          )}
        </span>,
      );
      lastIndex = regex.lastIndex;
    } else if (match[2] !== undefined) {
      const dramaId = match[2];
      const dramaName = match[3] || t('资产');
      let kind = 'character';
      let thumb: string | undefined;
      let icon = t('人');

      if (dramaAssets) {
        const { assetId, referenceImageId, actionId, actionMediaId, voiceClipId } = parseDramaMentionId(dramaId);
        const found = findDramaAsset(dramaAssets, assetId, globalAssets);
        if (voiceClipId !== undefined) {
          kind = 'voice';
          icon = '♪';
        } else if (actionId !== undefined) {
          const media = resolveDramaActionMediaRef(found, actionId, actionMediaId);
          kind = media?.kind === 'video' ? 'action-video' : 'action-image';
          thumb = media && media.kind !== 'video' ? media.url : undefined;
          icon = t('动');
        } else if (found) {
          kind = found.kind;
          icon = kind === 'character' ? t('人') : kind === 'scene' ? t('场') : t('道');
          const picked = referenceImageId && found.kind === 'character'
            ? found.referenceImages?.find((img: CharacterReferenceImage) => img.id === referenceImageId)
            : undefined;
          if (referenceImageId !== undefined) {
            thumb = picked ? resolveDramaAssetImageRef(found, nodes ?? [], referenceImageId)?.imageUrl : undefined;
          } else if (!assetId.startsWith('global/') && found.imageNodeId && nodes) {
            const node = nodes.find((n) => n.id === found.imageNodeId);
            thumb = bestNodeThumb(node?.data ?? {}) || found.imageUrl;
          } else {
            thumb = found.imageUrl;
          }
        }
      }

      const chipStyle = kind === 'voice' ? 'chip-audio' : kind === 'action-video' ? 'chip-video' : 'chip-image';
      const displayName = dramaName.length > 16 ? `${dramaName.slice(0, 14)}…` : dramaName;
      const referenceLabel = referenceLabels[currentIdx];

      elements.push(
        <span
          key={`drama-${match.index}`}
          className={`prompt-chip ${chipStyle} cursor-pointer`}
          data-drama-id={dramaId}
          data-drama-label={dramaName}
          title={dramaName}
          role="button" tabIndex={0}
        >
          <span className="prompt-chip-icon">
            {thumb ? <ViewportImage src={thumb} className="prompt-chip-thumb" alt="" /> : icon}
          </span>
          <span className="prompt-chip-id">{displayName}</span>
          {referenceLabel !== undefined && (
            <span className="prompt-chip-id prompt-chip-image-index prompt-chip-media-index text-canvas-text-secondary">{referenceLabel}</span>
          )}
        </span>,
      );
      lastIndex = regex.lastIndex;
    } else if (match[4] !== undefined) {
      const nodeId = match[4];
      const label = match[5] || t('生成图像');
      const shot = parseShotlistRowMentionId(nodeId);
      const meta = metaMap.get(nodeId);
      const node = nodes?.find((n) => n.id === (shot?.nodeId || (nodeId.includes('/cell/') ? nodeId.split('/')[0] : nodeId)));
      const rawNodeType = shot ? 'ai-shotlist' : meta?.type || (node?.data?.type as string) || 'ai-image';
      const nodeType = rawNodeType.replace(/^source-/, 'ai-');
      const iconPath = getNodeChipIconPath(nodeType);
      const thumbUrl = meta?.thumbnailUrl || (node ? bestNodeThumb(node.data ?? {}) || (node.data?.imageUrl as string) : undefined);
      const isMedia = nodeType === 'ai-image' || nodeType === 'ai-video' || nodeType === 'ai-storyboard';
      const showThumbnail = !iconPath && isMedia && !!thumbUrl;
      const displayId = shot ? undefined : meta?.displayId ?? (node?.data?.displayId as number | undefined);
      const liveLabel = shot ? meta?.label || (options.fallbackToTokenLabel ? label : t('{label}（镜头已失效）', { label })) : label;
      const displayLabel = displayId != null ? `#${displayId}` : liveLabel;
      const title = displayId != null ? `${label} (#${displayId})` : liveLabel;
      const referenceLabel = referenceLabels[currentIdx];

      elements.push(
        <span
          key={`node-${match.index}`}
          className={`prompt-chip prompt-chip-node ${NODE_CHIP_STYLE[nodeType] || 'chip-image'} cursor-pointer`}
          data-ref-id={nodeId}
          data-ref-label={label}
          title={title}
          role="button" tabIndex={0}
        >
          <span className={`prompt-chip-icon${showThumbnail ? ' has-thumbnail' : ''}`} aria-hidden="true">
            {showThumbnail ? <ViewportImage src={thumbUrl} className="prompt-chip-thumb" alt="" /> : iconPath ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={iconPath} />
              </svg>
            ) : '@'}
          </span>
          <span className="prompt-chip-id">{displayLabel}</span>
          {referenceLabel !== undefined && (
            <span className="prompt-chip-id prompt-chip-image-index prompt-chip-media-index text-canvas-text-secondary">{referenceLabel}</span>
          )}
        </span>,
      );
      lastIndex = regex.lastIndex;
    } else if (match[6] !== undefined) {
      const ioId = match[6];
      const ioTitle = match[7];
      const ioType = match[8] || 'prompt';
      const input = readWorkflowValue(prompt, regex.lastIndex);
      elements.push(
        <span key={`wf-${match.index}`} className={`prompt-chip prompt-chip-wf ${WORKFLOW_CHIP_STYLE[ioType] || WORKFLOW_CHIP_STYLE.prompt}`} data-wf-id={ioId}
          data-wf-title={ioTitle} data-wf-preview-value={input.value} role="button" tabIndex={0}>
          <span className="prompt-chip-wf-prefix">
            <span className="prompt-chip-icon">{WORKFLOW_CHIP_ICON[ioType] || '?'}</span>
            <span className="prompt-chip-wf-id">#{ioId}</span>
            <span className="prompt-chip-wf-colon">:</span>
          </span>
          <span className={input.value === undefined ? 'prompt-chip-wf-title' : 'prompt-chip-wf-value'}>{input.value ?? ioTitle}</span>
        </span>,
      );
      lastIndex = input.end;
      regex.lastIndex = input.end;
    } else if (match[9] !== undefined) {
      const skillId = match[9];
      let skillName = match[10];
      try { skillName = decodeURIComponent(match[10]); } catch { /* 保留原值 */ }
      elements.push(
        <span key={`skill-${match.index}`} className="prompt-chip chip-skill cursor-pointer" data-skill-id={skillId} data-skill-name={skillName} title={skillName} role="button" tabIndex={0}>
          <span className="prompt-chip-icon prompt-chip-skill-icon" aria-hidden="true">✦</span>
          <span className="prompt-chip-skill-name">{skillName.length > 20 ? `${skillName.slice(0, 18)}...` : skillName}</span>
        </span>,
      );
      lastIndex = regex.lastIndex;
    } else if (match[11] !== undefined) {
      const label = match[12] || t('模型');
      elements.push(<span key={`model-${match.index}`} className="prompt-chip prompt-chip-node chip-text cursor-pointer"
        data-model-ref-id={match[11]} data-model-ref-label={label} title={label} role="button" tabIndex={0}>
        <span className="prompt-chip-icon" aria-hidden="true"><Icon icon="lucide:box" width={12} height={12} /></span><span className="prompt-chip-id">{label}</span>
      </span>);
      lastIndex = regex.lastIndex;
    } else if (match[13] !== undefined) {
      let label = match[14] || t('助手参考图');
      try { label = decodeURIComponent(label); } catch { /* 保留原值 */ }
      elements.push(<span key={`chat-image-${match.index}`} className="prompt-chip prompt-chip-node chip-image cursor-pointer"
        data-chat-image-file-name={match[13]} data-chat-image-label={label} title={label} role="button" tabIndex={0}>
        <span className="prompt-chip-icon" aria-hidden="true">🖼</span><span className="prompt-chip-id">{label}</span>
        {referenceLabels[currentIdx] !== undefined && <span className="prompt-chip-id prompt-chip-image-index prompt-chip-media-index text-canvas-text-secondary">{referenceLabels[currentIdx]}</span>}
      </span>);
      lastIndex = regex.lastIndex;
    } else if (match[15] !== undefined) {
      try {
        const mention = parseComfyRefmodMentions(match[0]).mentions[0];
        if (!mention) throw new Error('引用无效');
        const ref = mention.selection;
        const title = t('{label} · ComfyUI 角色 · 加载节点 #{node} / 槽位 {slot}{strength}', { label: mention.label, node: ref.loaderNodeId || '—', slot: ref.slot ?? '—', strength: ref.loaderType === 'refmods-lab' ? '' : t(' · 强度 {value}', { value: ref.strength }) });
        elements.push(<span key={`refmod-${match.index}`} className="prompt-chip chip-text" title={title}>
          <span className="prompt-chip-icon" aria-hidden="true">R</span>
          <span className="prompt-chip-id">{mention.label}</span>
        </span>);
      } catch {
        elements.push(<span key={`refmod-${match.index}`} className="prompt-chip chip-text" title={t('请在本地 ComfyUI 视频节点中重新选择角色引用')}>{t('ComfyUI 角色（引用无效）')}</span>);
      }
      lastIndex = regex.lastIndex;
    }
  }

  if (lastIndex < prompt.length) {
    elements.push(prompt.slice(lastIndex));
  }

  return elements;
}
