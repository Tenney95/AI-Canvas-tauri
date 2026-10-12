import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { isTauriEnv } from './core';

export const MAX_JSON_FILE_BYTES = 8 * 1024 * 1024;

export class JsonFileTransferError extends Error {
  readonly code: 'too-large' | 'invalid-utf8';

  constructor(code: 'too-large' | 'invalid-utf8') {
    super(code);
    this.code = code;
    this.name = 'JsonFileTransferError';
  }
}

/** 只读取用户从文件选择器提供的文件，不记录内容或路径。 */
export async function readJsonTextFile(file: File): Promise<string> {
  if (file.size > MAX_JSON_FILE_BYTES) throw new JsonFileTransferError('too-large');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_JSON_FILE_BYTES) throw new JsonFileTransferError('too-large');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new JsonFileTransferError('invalid-utf8');
  }
}

/** 桌面使用原生另存为；浏览器下载。取消另存为返回 false。 */
export async function exportJsonTextFile(content: string, suggestedName: string): Promise<boolean> {
  const stem = Array.from(suggestedName, (char) => char.charCodeAt(0) < 32 ? '_' : char).join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.json$/i, '').replace(/[.\s]+$/g, '').slice(0, 120) || 'connection';
  const fileName = `${stem}.json`;
  if (isTauriEnv()) {
    const path = await save({ defaultPath: fileName, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!path) return false;
    await writeFile(path, new TextEncoder().encode(content));
    return true;
  }
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return true;
}
