/** 画布源文件导入支持的类型；与资产浏览器分类分别维护，避免扩大导入范围。 */

const FILE_EXT_IMAGE: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const FILE_EXT_VIDEO: readonly string[] = ['mp4', 'webm', 'avi', 'mov', 'mkv'];
const FILE_EXT_AUDIO: readonly string[] = ['mp3', 'wav', 'ogg', 'flac', 'aac'];
const FILE_EXT_TEXT: readonly string[] = [
  'txt', 'md', 'json', 'xml', 'csv', 'html', 'css', 'js', 'ts', 'jsx', 'tsx',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'log', 'py', 'java', 'c', 'cpp', 'h',
  'rs', 'go', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'r', 'swift', 'kt',
];

export const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
};

export { FILE_EXT_IMAGE, FILE_EXT_VIDEO, FILE_EXT_AUDIO, FILE_EXT_TEXT };

export type FileCategory = 'image' | 'video' | 'audio' | 'text';

export function classifyFile(ext: string): FileCategory | null {
  const e = ext.toLowerCase();
  if (FILE_EXT_IMAGE.includes(e)) return 'image';
  if (FILE_EXT_VIDEO.includes(e)) return 'video';
  if (FILE_EXT_AUDIO.includes(e)) return 'audio';
  if (FILE_EXT_TEXT.includes(e)) return 'text';
  return null;
}
