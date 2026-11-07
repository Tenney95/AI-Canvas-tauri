/** 纯文本稿件引用与跨平台文件名；原生文件权限由文件服务继续校验。 */
import type { ProjectTextFileReference } from '../types';

const reservedName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const illegalName = /[<>:"/\\|?*]/;
const hasControl = (value: string) => [...value].some((char) => {
  const code = char.charCodeAt(0);
  return code < 32 || code >= 127 && code <= 159;
});
const safeSegment = (value: string) => !!value && value !== '.' && value !== '..' && !illegalName.test(value)
  && !hasControl(value) && !/[. ]$/.test(value) && !reservedName.test(value);
const textFileName = (value: string) => value.length > 4 && /\.txt$/i.test(value) && safeSegment(value);

/** 目录和文件名都可跨设备；归档发布后的 imports 子目录同样保留。 */
export function normalizeProjectTextFileReference(value: unknown): ProjectTextFileReference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.relativePath !== 'string' || source.relativePath.length > 1024) return undefined;
  const relativePath = source.relativePath.replace(/\\/g, '/');
  const parts = relativePath.split('/');
  const fileName = parts.at(-1)!;
  if (!parts.every(safeSegment) || !textFileName(fileName)) return undefined;
  if (source.digest !== undefined && (typeof source.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(source.digest))) return undefined;
  if (source.sourceName !== undefined && (typeof source.sourceName !== 'string' || !textFileName(source.sourceName)
    || source.sourceName !== buildEpisodeScriptFileName(source.sourceName))) return undefined;
  return { fileName, relativePath,
    ...(typeof source.digest === 'string' ? { digest: source.digest.toLowerCase() } : {}),
    ...(typeof source.sourceName === 'string' ? { sourceName: source.sourceName } : {}) };
}

/** 使用固定的跨平台规则，与运行电脑的 navigator.platform 无关。 */
export function buildEpisodeScriptFileName(name: string): string {
  const clean = [...name.normalize('NFC')].map((char) => illegalName.test(char) || hasControl(char) ? '_' : char).join('')
    .trim().replace(/\.txt$/i, '').replace(/[. ]+$/g, '');
  const stem = [...clean].slice(0, 60).join('').replace(/[. ]+$/g, '') || '剧本';
  return `${reservedName.test(stem) ? '_' : ''}${stem}.txt`;
}

/** 文件导入后或分集改名时，下次显式保存将正文同步到 manuscripts 目录。 */
export function needsEpisodeScriptFileSync(project: { name: string; episodeScriptFile?: ProjectTextFileReference }): boolean {
  const reference = normalizeProjectTextFileReference(project.episodeScriptFile);
  return !reference || reference.relativePath.split('/').length !== 2 || !reference.relativePath.startsWith('manuscripts/')
    || (reference.sourceName ?? reference.fileName) !== buildEpisodeScriptFileName(project.name);
}
