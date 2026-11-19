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

export const NATIVE_EPISODE_SCRIPT_VERSION_DIRECTORY = 'imports/episode-script-versions';

/** 原生版本可经多次复制落在发布子目录内，仍由稿件引用决定是否归档。 */
export function isNativeEpisodeScriptVersionPath(path: string): boolean {
  const parts = path.split('/');
  const fileName = parts.at(-1) ?? '';
  if (parts.slice(-3, -1).join('/') !== NATIVE_EPISODE_SCRIPT_VERSION_DIRECTORY
    || !textFileName(fileName) || !/--v-[a-f0-9]{24}(?:_[1-9][0-9]*)?\.txt$/.test(fileName)) return false;
  const publications = parts.slice(0, -3);
  return publications.length % 2 === 0 && publications.every((part, index) => index % 2 === 0
    ? part === 'imports' : /^[A-Za-z0-9][A-Za-z0-9-]{0,127}-root-(?:0|[1-9][0-9]*)$/.test(part));
}

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

/** 已绑定的版本沿用原文件，普通导入稿或分集改名时可显式同步。 */
export function needsEpisodeScriptFileSync(project: { name: string; episodeScriptFile?: ProjectTextFileReference }): boolean {
  const reference = normalizeProjectTextFileReference(project.episodeScriptFile);
  return !reference || !(/^manuscripts\/[^/]+$/.test(reference.relativePath) || isNativeEpisodeScriptVersionPath(reference.relativePath))
    || (reference.sourceName ?? reference.fileName) !== buildEpisodeScriptFileName(project.name);
}
