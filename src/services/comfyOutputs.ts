/**
 * ComfyUI 历史输出的结构与取件地址拼接。
 *
 * 正常生成（comfyWorkflowService）和重启后的恢复轮询（pollManager）解析的是
 * 同一份 /history 输出，这里是两条路径共用的唯一定义，避免各自复制一份后跑偏。
 */

export interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface ComfyOutputNode {
  images?: ComfyOutputFile[];
  videos?: ComfyOutputFile[];
  gifs?: ComfyOutputFile[];
  /** 内置 SaveAudio / PreviewAudio 用的是单数 audio，只有部分自定义节点写 audios */
  audio?: ComfyOutputFile[];
  audios?: ComfyOutputFile[];
  [key: string]: unknown;
}

export type ComfyOutputs = Record<string, ComfyOutputNode>;

export type ComfyOutputKind = 'image' | 'video' | 'audio';

/** 各类媒体的已知键名，单复数都收 —— 内置节点与自定义节点命名并不统一 */
const OUTPUT_KEYS: Record<ComfyOutputKind, string[]> = {
  image: ['images', 'image'],
  video: ['videos', 'video', 'gifs'],
  audio: ['audio', 'audios'],
};

/** 键名不认识时按扩展名兜底认领 */
const OUTPUT_EXTENSIONS: Record<ComfyOutputKind, string[]> = {
  // SaveImageAdvanced 也会返回 AVIF / EXR；是否可展示由后续媒体加载决定。
  image: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'exr'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'],
};

const MAX_OUTPUT_PATH_LENGTH = 4096;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function relativePathParts(value: string): string[] | undefined {
  const path = value.replace(/\\/g, '/');
  if (hasControlCharacters(path) || path.startsWith('/') || /^[a-z]:/i.test(path)
    || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return;
  const parts = path.split('/');
  if (parts.includes('..')) return;
  return parts.filter((part) => part !== '' && part !== '.');
}

/** 只保留 /view 所需的受限描述符，不保存自定义节点的其他输出元数据。 */
export function sanitizeComfyOutputFile(value: unknown): ComfyOutputFile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.filename !== 'string' || !candidate.filename.trim() || candidate.filename.length > MAX_OUTPUT_PATH_LENGTH
    || hasControlCharacters(candidate.filename)) return;
  if (candidate.subfolder !== undefined && (typeof candidate.subfolder !== 'string'
    || candidate.subfolder.length > MAX_OUTPUT_PATH_LENGTH)) return;
  if (candidate.type !== undefined && candidate.type !== 'output' && candidate.type !== 'temp' && candidate.type !== 'input') return;

  let filename = candidate.filename;
  let type = candidate.type as string | undefined;
  const subfolderParts = relativePathParts((candidate.subfolder as string | undefined) ?? '');
  if (!subfolderParts) return;

  // /view 先判断此精确前缀，再校验 hash，不会将它作为带目录注解的文件名处理。
  if (filename.startsWith('blake3:')) {
    if (!/^blake3:[a-f\d]{64}\s*$/i.test(filename)) return;
    return {
      filename: filename.trim().toLowerCase(),
      ...(candidate.subfolder !== undefined ? { subfolder: subfolderParts.join('/') } : {}),
      ...(type !== undefined ? { type } : {}),
    };
  }
  // history 取件沿用后端 annotated_filepath 的小写末尾匹配与固定截断，
  // 不套用前端输入控件对大小写、空白更宽松的注解规则。
  const annotation = ['output', 'input', 'temp'].find((storage) => filename.endsWith(`[${storage}]`));
  if (annotation) {
    filename = Array.from(filename).slice(0, -(annotation.length + 3)).join('');
    type = annotation;
    // 拒绝叠加注解，避免持久化后再次校验时改投另一个存储目录。
    if (['output', 'input', 'temp'].some((storage) => filename.endsWith(`[${storage}]`))) return;
  }
  if (filename.endsWith('/') || filename.endsWith('\\') || /[\\/]\.$/.test(filename)) return;
  const filenameParts = relativePathParts(filename);
  const basename = filenameParts?.pop();
  if (!basename?.trim() || /^[a-z]:/i.test(basename) || basename.startsWith('blake3:')) return;
  // 显式 subfolder 与原生 /view 行为一致，不重复拼入 filename 自带的目录。
  const subfolder = (subfolderParts.length ? subfolderParts : filenameParts ?? []).join('/');
  return {
    filename: basename,
    ...(subfolder || candidate.subfolder !== undefined ? { subfolder } : {}),
    ...(type !== undefined ? { type } : {}),
  };
}

function toOutputFiles(value: unknown): ComfyOutputFile[] {
  if (!Array.isArray(value)) return [];
  return value.map(sanitizeComfyOutputFile).filter((file): file is ComfyOutputFile => file !== undefined);
}

/** 从单个节点输出里取某类媒体：先认已知键名，认不出再按扩展名扫描其余键 */
function pickFromNode(node: ComfyOutputNode, kind: ComfyOutputKind, storageType: 'output' | 'legacy' | 'any'): ComfyOutputFile | null {
  const extensions = OUTPUT_EXTENSIONS[kind];
  const extension = (file: ComfyOutputFile) => file.filename.split('.').pop()?.toLowerCase() ?? '';
  const hasMatchingExtension = (file: ComfyOutputFile) => extensions.includes(extension(file));
  const accepts = (file: ComfyOutputFile) => (storageType === 'any'
    || (storageType === 'legacy' ? !file.type : file.type === 'output'))
    && (kind === 'video' ? hasMatchingExtension(file) : !Object.entries(OUTPUT_EXTENSIONS).some(
      ([otherKind, otherExtensions]) => otherKind !== kind && otherExtensions.includes(extension(file)),
    ));
  for (const key of OUTPUT_KEYS[kind]) {
    const file = toOutputFiles(node[key]).find(accepts);
    if (file) return file;
  }
  for (const value of Object.values(node)) {
    const file = toOutputFiles(value).find((item) => accepts(item) && hasMatchingExtension(item));
    if (file) return file;
  }
  return null;
}

/**
 * 按给定媒体类型的优先级，在全部节点输出里找第一个可用文件。
 * 找不到返回 null，调用方据此判断「还没出结果」。
 */
export function findComfyOutputFile(
  outputs: ComfyOutputs,
  kinds: ComfyOutputKind[],
): ComfyOutputFile | null {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null;
  for (const kind of kinds) {
    // 三类媒体都先找正式输出，再兼容未声明 type 的旧服务和仅有预览的工作流。
    for (const storageType of ['output', 'legacy', 'any'] as const) {
      for (const node of Object.values(outputs)) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
        const file = pickFromNode(node, kind, storageType);
        if (file) return file;
      }
    }
  }
  return null;
}

/** 把 /history 输出里的文件拼成可直接下载的 /view 地址。 */
export function buildComfyFileUrl(baseUrl: string, file: ComfyOutputFile): string {
  const safeFile = sanitizeComfyOutputFile(file);
  if (!safeFile) throw new Error('ComfyUI 输出文件描述无效');
  const subfolder = safeFile.subfolder ? `&subfolder=${encodeURIComponent(safeFile.subfolder)}` : '';
  const type = safeFile.type ? `&type=${encodeURIComponent(safeFile.type)}` : '&type=output';
  return `${baseUrl.replace(/\/+$/, '')}/view?filename=${encodeURIComponent(safeFile.filename)}${subfolder}${type}`;
}

/** 找到目标媒体就拼成 /view 地址，没找到返回 null（表示还没出结果）。 */
export function resolveComfyOutputUrl(
  baseUrl: string,
  outputs: ComfyOutputs,
  kinds: ComfyOutputKind[],
): { url: string; file: ComfyOutputFile } | null {
  const file = findComfyOutputFile(outputs, kinds);
  return file ? { url: buildComfyFileUrl(baseUrl, file), file } : null;
}
