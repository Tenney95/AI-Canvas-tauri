/** 完整本机产物集合与旧单结果／APIMart 合同的只读兼容投影。 */
import type { NativeMediaLocalOutput } from '../types/media';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { nativeImageBatchResults } from './nativeImageBatch';
import { safeExchangePath } from './projectExchangeDomain';
import { isNativeMediaContentPath } from './nativeMediaContentPath';

export const MAX_NATIVE_MEDIA_OUTPUTS = 128;
export function validateNativeMediaLocalOutputs(value: readonly NativeMediaLocalOutput[]): void {
  if (!Array.isArray(value) || !value.length || value.length > MAX_NATIVE_MEDIA_OUTPUTS) throw new Error('原媒体产物集合不完整或超过上限');
  for (const file of value) {
    if (!file || ![Object.prototype, null].includes(Object.getPrototypeOf(file))
      || Reflect.ownKeys(file).some((key) => typeof key !== 'string' || !['category', 'relativePath', 'bytes', 'sha256'].includes(key)
        || !('value' in Object.getOwnPropertyDescriptor(file, key)!))
      || !['image', 'video', 'audio'].includes(file.category) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || typeof file.relativePath !== 'string' || safeExchangePath(file.relativePath) !== file.relativePath
      || !isNativeMediaContentPath(file.relativePath, file.sha256)) throw new Error('原媒体产物缺少受控文件身份');
  }
}
export function nativeMediaLocalOutputs(record: Pick<NativeMediaTaskRecord, 'localResults' | 'localResult' | 'apimartImageBatch' | 'category'>): NativeMediaLocalOutput[] {
  if (record.localResults) { validateNativeMediaLocalOutputs(record.localResults); return structuredClone(record.localResults); }
  if (record.apimartImageBatch) return nativeImageBatchResults(record).map((file) => ({ ...file, category: 'image' }));
  return record.localResult ? [{ ...record.localResult, category: record.category }] : [];
}
