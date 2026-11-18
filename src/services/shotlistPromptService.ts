/** 精确镜头引用在本次生成时展开，普通 @ 素材仍由既有解析器处理。 */
import type { BaseNodeData, CameraGenerationSettings } from '../types';
import { formatShotVideoPrompt, isShotRowBlank, parseShotlistRowMentionId, type ShotRow } from '../types/shotlist';
import { buildGenerationCameraPrompt } from '../utils/cinematography';

type ShotlistNode = { id: string; type?: string; data: BaseNodeData };
const NODE_MENTION = /@\{([^:}]+):([^}]*)\}/g;

/** 选择某镜后，以精确引用替换该表的整表胶囊，保留附加文字与其他表引用。 */
export function normalizeShotlistPromptReferences(prompt: string): string {
  const parents = new Set([...prompt.matchAll(NODE_MENTION)]
    .map((match) => parseShotlistRowMentionId(match[1])?.nodeId).filter((id) => id !== undefined));
  return parents.size ? prompt.replace(NODE_MENTION, (token, id: string) => parents.has(id) ? '' : token) : prompt;
}

function readRow(referenceId: string, nodes: readonly ShotlistNode[]) {
  const reference = parseShotlistRowMentionId(referenceId);
  if (!reference) throw new Error('分镜镜头引用格式无效，请重新选择镜头');
  const sheet = nodes.find((node) => node.id === reference.nodeId && node.data.type === 'ai-shotlist');
  const row = sheet?.data.shotlistRows?.find((item) => item.id === reference.rowId);
  if (!sheet || !row) throw new Error('引用的分镜表或镜头已删除，请重新选择镜头');
  if (isShotRowBlank(row)) throw new Error('引用的镜头没有内容，请先补充分镜');
  return { ...reference, row, defaults: sheet.data.shotlistCinematography };
}

export function resolveSingleShotlistRowReference(prompt: string, nodes: readonly ShotlistNode[]):
  { nodeId: string; rowId: string; row: ShotRow } | undefined {
  const ids = [...new Set([...prompt.matchAll(NODE_MENTION)].map((match) => match[1]).filter((id) => id.includes('/shot/')))];
  const references = ids.map((id) => readRow(id, nodes));
  return references.length === 1 ? references[0] : undefined;
}

export function expandShotlistRowMentions(prompt: string, nodes: readonly ShotlistNode[], options: {
  durationSeconds?: number;
  cameraSettings?: CameraGenerationSettings;
  onReadNode?: (id: string) => void;
} = {}): string {
  if (!prompt.includes('/shot/')) return prompt;
  prompt = normalizeShotlistPromptReferences(prompt);
  const rootReferences = [...new Set([...prompt.matchAll(NODE_MENTION)]
    .map((match) => match[1]).filter((id) => id.includes('/shot/')))];
  const durationReference = rootReferences.length === 1 && typeof options.durationSeconds === 'number'
    && Number.isFinite(options.durationSeconds) && options.durationSeconds > 0 ? rootReferences[0] : undefined;
  let count = 0;
  const expand = (text: string, stack: ReadonlySet<string>): string => {
    const expanded = text.replace(NODE_MENTION, (token, referenceId: string) => {
      if (!referenceId.includes('/shot/')) {
        if ([...stack].some((id) => parseShotlistRowMentionId(id)?.nodeId === referenceId)) {
          throw new Error('镜头内容不能循环引用所属分镜表，请选择具体素材或镜头');
        }
        return token;
      }
      if (stack.has(referenceId)) throw new Error('分镜镜头存在循环引用，请移除循环后生成');
      if (stack.size >= 8 || ++count > 64) throw new Error('分镜镜头引用层级或数量过多，请减少引用');
      const { nodeId, rowId, row, defaults } = readRow(referenceId, nodes);
      options.onReadNode?.(nodeId);
      let content = formatShotVideoPrompt(referenceId === durationReference ? { ...row, duration: options.durationSeconds } : row, defaults, options.cameraSettings);
      const frame = row.frame && nodes.find((node) => node.id === row.frame?.nodeId);
      // 画面格也用于回填成片；只有参考图片自动带入，视频参考由正文显式声明。
      if (row.frame?.kind === 'image') {
        options.onReadNode?.(row.frame.nodeId);
        const source = frame?.data.shotlistProductionSource;
        if (!(source?.kind === 'video' && source.nodeId === nodeId && source.rowId === rowId)) {
          if (!frame || !['ai-image', 'source-image'].includes(frame.data.type)
            || ![frame.data.imageUrl, frame.data.thumbnailUrl].some((url) => typeof url === 'string' && url.trim())) {
            throw new Error('镜头参考图片已删除或尚未就绪，请重新绑定画面');
          }
          const label = (frame.data.label || '镜头参考画面').replace(/[{}:\r\n]/g, ' ').slice(0, 80);
          const frameToken = `@{${frame.id}:${label}}`;
          if (![...content.matchAll(NODE_MENTION)].some((match) => match[1] === frame.id)) content += `\n参考画面：${frameToken}`;
        }
      }
      return expand(content, new Set([...stack, referenceId]));
    });
    if (/@\{[^}\r\n]*\/shot\//.test(expanded)) throw new Error('分镜镜头引用格式无效，请重新选择镜头');
    if (expanded.length > 120_000) throw new Error('分镜镜头展开内容过长，请减少引用');
    return expanded;
  };
  return expand(prompt, new Set());
}

/** 精确镜头内合并摄影参数，普通媒体提示词沿用原有 Camera settings 段。 */
export function applyGenerationCameraPrompt(prompt: string, nodes: readonly ShotlistNode[], cameraSettings?: CameraGenerationSettings, durationSeconds?: number,
  onReadNode?: (id: string) => void,
): string {
  if ([...prompt.matchAll(NODE_MENTION)].some((match) => match[1].includes('/shot/'))) {
    return expandShotlistRowMentions(prompt, nodes, { cameraSettings, durationSeconds, onReadNode });
  }
  // 整表的文字和画面仍由原解析器展开，摄影覆盖随解析上下文逐镜合并。
  if ([...prompt.matchAll(NODE_MENTION)].some((match) => nodes.some((node) => node.id === match[1] && node.data.type === 'ai-shotlist'))) return prompt;
  const camera = buildGenerationCameraPrompt(cameraSettings);
  return camera ? `${prompt}\n\nCamera settings: ${camera}.` : prompt;
}
