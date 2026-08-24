/**
 * nodes/shared/mentionEditorDom — @ 提及编辑器的 DOM 层。
 * 把画布节点与工作流 IO 节点渲染成可插入提示词的「芯片」（chip）DOM 片段，
 * 用零宽空格（ZWSP）作分隔占位，配合 mentionEditorSources 提供可点选的提及候选。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import type { WorkflowIONodeType, StoryboardCellOverride } from '../../../types';
import type { AppState } from '../../../store/useAppStore';
import { useAppStore } from '../../../store/useAppStore';
import { getFileCategory } from '../../../services/fileService';
import { parseDramaMentionId } from '../../../types/dramaAssets';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const ZWSP = '\u200B';
const CHIP_STYLE: Record<string, string> = {
  'ai-text': 'chip-text',
  'ai-image': 'chip-image',
  'ai-video': 'chip-video',
  'ai-audio': 'chip-audio',
  'ai-markdown': 'chip-markdown',
  'ai-storyboard': 'chip-image',
};
const WF_IO_STYLE: Record<string, string> = {
  prompt: 'chip-workflow-prompt',
  image: 'chip-workflow-image',
  video: 'chip-workflow-video',
  audio: 'chip-workflow-audio',
};
const WF_IO_ICON: Record<string, string> = {
  prompt: 'T',
  image: 'I',
  video: 'V',
  audio: 'A',
};
const IMAGE_REFERENCE_NODE_TYPES = new Set([
  'ai-image',
  'source-image',
  'ai-storyboard',
  'ai-director',
  'ai-panorama',
  'ai-animation',
]);

type NodeMeta = {
  type: string;
  displayId: number | undefined;
  thumbnailUrl?: string;
  imageReferenceKey?: string;
};

const nodeMetaCache = new WeakMap<AppState['nodes'], Map<string, NodeMeta>>();

function localAssetUrl(filePath?: string): string | undefined {
  if (!filePath || !IS_TAURI) return undefined;
  try {
    return convertFileSrc(filePath);
  } catch {
    return undefined;
  }
}

export function bestNodeThumb(
  data: { imageUrl?: unknown; thumbnailUrl?: unknown; filePath?: unknown },
): string | undefined {
  if (data.imageUrl) {
    return localAssetUrl(data.filePath as string | undefined)
      || (data.thumbnailUrl as string | undefined)
      || (data.imageUrl as string | undefined);
  }
  return data.thumbnailUrl as string | undefined;
}

export function getNodeMetaMap(nodes: AppState['nodes']) {
  const cached = nodeMetaCache.get(nodes);
  if (cached) return cached;
  const map = new Map<string, NodeMeta>();
  for (const node of nodes) {
    const type = (node.data.type as string) || '';
    const thumbnailUrl = bestNodeThumb(node.data);
    const directorCaptureUrl = type === 'ai-director' && Array.isArray(node.data.directorCaptureUrls)
      ? node.data.directorCaptureUrls.find((url) => typeof url === 'string' && url.trim())
      : undefined;
    map.set(node.id, {
      type,
      displayId: node.data.displayId as number | undefined,
      thumbnailUrl,
      imageReferenceKey: IMAGE_REFERENCE_NODE_TYPES.has(type) && (thumbnailUrl || directorCaptureUrl)
        ? `node:${node.id}${!thumbnailUrl && directorCaptureUrl ? ':cap0' : ''}`
        : undefined,
    });
    if (node.data.type !== 'ai-storyboard') continue;
    const cols = Math.max(1, (node.data.storyboardCols as number) || 3);
    const rows = Math.max(1, (node.data.storyboardRows as number) || 3);
    const overrides = (node.data.storyboardOverrides as (StoryboardCellOverride | null)[] | undefined) ?? [];
    const imageUrl = node.data.imageUrl as string | undefined;
    for (let index = 0; index < rows * cols; index += 1) {
      const thumbnailUrl = overrides[index]?.url || imageUrl;
      if (thumbnailUrl) {
        const cellId = `${node.id}/cell/${index}`;
        map.set(cellId, {
          type: 'ai-image',
          displayId: undefined,
          thumbnailUrl,
          imageReferenceKey: `sbcell:${cellId}`,
        });
      }
    }
  }
  nodeMetaCache.set(nodes, map);
  return map;
}

export function isChipEl(node: Node | null | undefined): node is HTMLElement {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as HTMLElement;
  return element.hasAttribute('data-ref-id')
    || element.hasAttribute('data-asset-path')
    || element.hasAttribute('data-drama-id')
    || element.hasAttribute('data-wf-id')
    || element.hasAttribute('data-skill-id');
}

export function isBrEl(node: Node | null | undefined): boolean {
  return !!node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR';
}

export function ensureCaretSlotBeforeChip(chip: Node): void {
  const previous = chip.previousSibling;
  if (!previous || isBrEl(previous)) {
    chip.parentNode?.insertBefore(document.createTextNode(ZWSP), chip);
  } else if (previous.nodeType === Node.TEXT_NODE && !previous.textContent) {
    previous.textContent = ZWSP;
  }
}

export function normalizeChipSlots(root: HTMLElement): void {
  const chips = root.querySelectorAll('[data-ref-id],[data-asset-path],[data-drama-id],[data-wf-id],[data-skill-id]');
  for (const chip of Array.from(chips)) ensureCaretSlotBeforeChip(chip);
}

export function numberImageReferenceKeys(keys: Array<string | undefined>): Array<number | undefined> {
  const indexByKey = new Map<string, number>();
  return keys.map((key) => {
    if (!key) return undefined;
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = indexByKey.size + 1;
    indexByKey.set(key, index);
    return index;
  });
}

export function syncImageReferenceLabels(root: HTMLElement, metaMap: Map<string, NodeMeta>): void {
  const chips = Array.from(root.querySelectorAll<HTMLElement>('[data-ref-id],[data-image-ref-key]'));
  const keys = chips.map((chip) => {
    const nodeId = chip.getAttribute('data-ref-id');
    return nodeId ? metaMap.get(nodeId)?.imageReferenceKey : chip.getAttribute('data-image-ref-key') || undefined;
  });
  const indices = numberImageReferenceKeys(keys);

  chips.forEach((chip, position) => {
    const existing = Array.from(chip.children).find((child) => child.classList.contains('prompt-chip-image-index'));
    const index = indices[position];
    if (index === undefined) {
      existing?.remove();
      return;
    }
    const label = existing || document.createElement('span');
    label.className = 'prompt-chip-id prompt-chip-image-index text-canvas-text-secondary';
    label.textContent = `(图${index})`;
    if (!existing) chip.appendChild(label);
  });
}

export function serializeDOM(root: HTMLElement): string {
  let result = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.hasAttribute('data-ref-id')) {
      result += `@{${element.getAttribute('data-ref-id') || ''}:${element.getAttribute('data-ref-label') || ''}}`;
    } else if (element.hasAttribute('data-drama-id')) {
      result += `@drama{${element.getAttribute('data-drama-id') || ''}:${element.getAttribute('data-drama-label') || ''}}`;
    } else if (element.hasAttribute('data-asset-path')) {
      result += `@asset{${encodeURIComponent(element.getAttribute('data-asset-path') || '')}}`;
    } else if (element.hasAttribute('data-skill-id')) {
      result += `@skill{${element.getAttribute('data-skill-id') || ''}|${encodeURIComponent(element.getAttribute('data-skill-name') || '')}}`;
    } else if (element.hasAttribute('data-wf-id')) {
      result += `@wf{${element.getAttribute('data-wf-id') || ''}|${element.getAttribute('data-wf-title') || ''}|${element.getAttribute('data-wf-type') || 'prompt'}}(`;
      const valueElement = element.querySelector('.prompt-chip-wf-value');
      if (valueElement) {
        for (const child of Array.from(valueElement.childNodes)) walk(child);
      }
      result += ')';
    } else if (element.tagName === 'BR') {
      result += '\n';
    } else {
      for (const child of Array.from(node.childNodes)) walk(child);
    }
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return result.split(ZWSP).join('').replace(/\n+$/, '');
}

export function buildChipEl(
  nodeId: string,
  label: string,
  metaMap: Map<string, NodeMeta>,
): HTMLSpanElement {
  const meta = metaMap.get(nodeId);
  const nodeType = meta?.type || 'ai-text';
  const span = document.createElement('span');
  span.className = `prompt-chip prompt-chip-node ${CHIP_STYLE[nodeType] || CHIP_STYLE['ai-text']}`;
  span.contentEditable = 'false';
  span.setAttribute('data-ref-id', nodeId);
  span.setAttribute('data-ref-label', label);
  span.title = meta?.displayId != null ? `${label} (#${meta.displayId})` : label;

  const icon = document.createElement('span');
  icon.className = 'prompt-chip-icon';
  icon.setAttribute('aria-hidden', 'true');
  const isMedia = nodeType === 'ai-image' || nodeType === 'ai-video' || nodeType === 'ai-storyboard';
  if (isMedia && meta?.thumbnailUrl) {
    icon.classList.add('has-thumbnail');
    const image = document.createElement('img');
    image.src = meta.thumbnailUrl;
    image.className = 'prompt-chip-thumb';
    image.alt = '';
    icon.appendChild(image);
  } else {
    icon.textContent = '@';
  }
  span.appendChild(icon);
  if (meta?.displayId != null) {
    const displayId = document.createElement('span');
    displayId.className = 'prompt-chip-id';
    displayId.textContent = `#${meta.displayId}`;
    span.appendChild(displayId);
  }
  return span;
}

export function buildAssetChipEl(path: string, assetUrl?: string): HTMLSpanElement {
  const name = path.split(/[\\/]/).pop() || 'asset';
  const isImage = getFileCategory(name) === 'image';
  const span = document.createElement('span');
  span.className = 'prompt-chip chip-asset';
  span.contentEditable = 'false';
  span.setAttribute('data-asset-path', path);
  if (isImage) span.setAttribute('data-image-ref-key', `asset:${encodeURIComponent(path)}`);
  const icon = document.createElement('span');
  icon.className = 'prompt-chip-icon';
  if (isImage && assetUrl) {
    const image = document.createElement('img');
    image.src = assetUrl;
    image.className = 'prompt-chip-thumb';
    image.alt = '';
    icon.appendChild(image);
  } else {
    icon.textContent = isImage ? '🖼' : '📄';
  }
  span.appendChild(icon);
  const label = document.createElement('span');
  label.className = 'prompt-chip-id';
  label.textContent = name.length > 18 ? `${name.slice(0, 16)}…` : name;
  span.appendChild(label);
  return span;
}

export function buildDramaChipEl(dramaId: string, name: string, kind: string, thumbUrl?: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'prompt-chip chip-image';
  span.contentEditable = 'false';
  span.setAttribute('data-drama-id', dramaId);
  span.setAttribute('data-drama-label', name);
  span.setAttribute('data-drama-kind', kind);
  if (thumbUrl) span.setAttribute('data-image-ref-key', `drama:${dramaId}`);
  const icon = document.createElement('span');
  icon.className = 'prompt-chip-icon';
  if (thumbUrl) {
    const image = document.createElement('img');
    image.src = thumbUrl;
    image.className = 'prompt-chip-thumb';
    image.alt = '';
    icon.appendChild(image);
  } else {
    icon.textContent = kind === 'character' ? '人' : kind === 'scene' ? '场' : '道';
  }
  span.appendChild(icon);
  const label = document.createElement('span');
  label.className = 'prompt-chip-id';
  label.textContent = name.length > 16 ? `${name.slice(0, 14)}…` : name;
  span.appendChild(label);
  return span;
}

export function buildSkillChipEl(skillId: string, skillName: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'prompt-chip chip-skill';
  span.contentEditable = 'false';
  span.setAttribute('data-skill-id', skillId);
  span.setAttribute('data-skill-name', skillName);
  span.title = skillName;
  const icon = document.createElement('span');
  icon.className = 'prompt-chip-icon prompt-chip-skill-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '✦';
  span.appendChild(icon);
  const label = document.createElement('span');
  label.className = 'prompt-chip-skill-name';
  label.textContent = skillName.length > 20 ? `${skillName.slice(0, 18)}...` : skillName;
  span.appendChild(label);
  return span;
}

function buildWorkflowChipIconEl(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 16 16');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#f5a97f');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', 'M3.5 1.5h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2m7 7h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2m-6-1V10q0 1.5 1.5 1.5h2.5');
  svg.appendChild(path);
  return svg;
}

function buildChipTextEl(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

export function buildWorkflowChipEl(
  ioNodeId: string,
  ioNodeTitle: string,
  ioNodeType: WorkflowIONodeType,
): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `prompt-chip prompt-chip-wf ${WF_IO_STYLE[ioNodeType] || WF_IO_STYLE.prompt}`;
  span.contentEditable = 'false';
  span.setAttribute('data-wf-id', ioNodeId);
  span.setAttribute('data-wf-title', ioNodeTitle);
  span.setAttribute('data-wf-type', ioNodeType);
  const prefix = document.createElement('span');
  prefix.className = 'prompt-chip-wf-prefix';
  prefix.contentEditable = 'false';
  prefix.appendChild(buildWorkflowChipIconEl());
  prefix.appendChild(buildChipTextEl('prompt-chip-icon', WF_IO_ICON[ioNodeType] || '?'));
  prefix.appendChild(buildChipTextEl('prompt-chip-wf-id', `#${ioNodeId}`));
  prefix.appendChild(buildChipTextEl('prompt-chip-wf-colon', ':'));
  span.appendChild(prefix);
  const valueArea = document.createElement('span');
  valueArea.className = 'prompt-chip-wf-value';
  valueArea.contentEditable = 'true';
  valueArea.appendChild(document.createElement('br'));
  span.appendChild(valueArea);
  return span;
}

function pushTextWithBreaks(nodes: Node[], text: string) {
  if (!text) return;
  text.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push(document.createElement('br'));
    if (line) nodes.push(document.createTextNode(line));
  });
}

export function renderPromptToNodes(text: string, metaMap: Map<string, NodeMeta>): Node[] {
  const regex = /@asset\{([^}]+)\}|@drama\{([^:]+):([^}]+)\}|@\{([^:]+):([^}]+)\}|@wf\{([^|]+)\|([^|]+)\|([^|}]+)\}|@skill\{([^|}]+)\|([^}]+)\}/g;
  const nodes: Node[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const pushChip = (chip: Node) => {
    const previous = nodes[nodes.length - 1];
    if (!previous || isBrEl(previous) || isChipEl(previous)) nodes.push(document.createTextNode(ZWSP));
    nodes.push(chip);
  };

  while ((match = regex.exec(text)) !== null) {
    pushTextWithBreaks(nodes, text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      let path = match[1];
      try { path = decodeURIComponent(match[1]); } catch { /* 保留原值 */ }
      pushChip(buildAssetChipEl(path));
      lastIndex = regex.lastIndex;
    } else if (match[2] !== undefined) {
      const dramaId = match[2];
      const dramaName = match[3];
      let kind = 'character';
      let thumb: string | undefined;
      try {
        const store = useAppStore.getState();
        const { assetId, referenceImageId } = parseDramaMentionId(dramaId);
        const found = store.dramaAssets.characters.find((asset) => asset.id === assetId)
          || store.dramaAssets.scenes.find((asset) => asset.id === assetId)
          || store.dramaAssets.props.find((asset) => asset.id === assetId);
        if (found) {
          kind = found.kind;
          const picked = referenceImageId && found.kind === 'character'
            ? found.referenceImages?.find((image) => image.id === referenceImageId)
            : undefined;
          if (picked) {
            thumb = picked.imageUrl;
          } else if (found.imageNodeId) {
            const node = store.nodes.find((candidate) => candidate.id === found.imageNodeId);
            thumb = bestNodeThumb(node?.data ?? {}) || found.imageUrl;
          } else {
            thumb = found.imageUrl;
          }
        }
      } catch {
        // 渲染失败时保留无缩略图芯片
      }
      pushChip(buildDramaChipEl(dramaId, dramaName, kind, thumb));
      lastIndex = regex.lastIndex;
    } else if (match[4] !== undefined) {
      pushChip(buildChipEl(match[4], match[5], metaMap));
      lastIndex = regex.lastIndex;
    } else if (match[6] !== undefined) {
      const chip = buildWorkflowChipEl(match[6], match[7], match[8] as WorkflowIONodeType);
      const matchEnd = regex.lastIndex;
      if (text[matchEnd] === '(') {
        let depth = 1;
        let index = matchEnd + 1;
        while (index < text.length && depth > 0) {
          if (text[index] === '(') depth += 1;
          else if (text[index] === ')') depth -= 1;
          index += 1;
        }
        const valueText = text.slice(matchEnd + 1, index - 1);
        if (valueText) {
          const valueArea = chip.querySelector('.prompt-chip-wf-value');
          if (valueArea) {
            valueArea.innerHTML = '';
            for (const node of renderPromptToNodes(valueText, metaMap)) valueArea.appendChild(node);
          }
        }
        pushChip(chip);
        lastIndex = index;
        regex.lastIndex = index;
      } else {
        pushChip(chip);
        lastIndex = matchEnd;
        regex.lastIndex = matchEnd;
      }
    } else if (match[9] !== undefined) {
      let name = match[10];
      try { name = decodeURIComponent(match[10]); } catch { /* 保留原值 */ }
      pushChip(buildSkillChipEl(match[9], name));
      lastIndex = regex.lastIndex;
    }
  }
  pushTextWithBreaks(nodes, text.slice(lastIndex));
  return nodes;
}
