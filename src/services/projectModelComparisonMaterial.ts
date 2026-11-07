/** P2 比较材料的纯编码；原调用入口继续re-export，旧journal字节不变。 */
import { estimateLegacyBackupValueBytes } from './indexedDb/projectModelMigrationRepository';
const error = (code: string) => new Error('项目模型隔离暂存被阻止：' + code);

/** 同步、带类型的精确比较材料；Blob 不能在活跃 IDB 事务内读字节，故明确阻断。 */
export function projectModelSourceToken(value: unknown): string {
  estimateLegacyBackupValueBytes(value, 128 * 1024 * 1024);
  const seen = new Map<object, number>();
  const active = new Set<object>();
  let count = 0;
  function encode(item: unknown, depth: number): unknown {
    if (++count > 4_000_000 || depth > 64) throw error('source-capacity');
    if (item === undefined) return ['undefined'];
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return [typeof item, item];
    if (typeof item === 'number') return ['number', Number.isNaN(item) ? 'NaN' : Object.is(item, -0) ? '-0' : String(item)];
    if (typeof item === 'bigint') return ['bigint', String(item)];
    if (typeof item !== 'object' || item === null) throw error('unsupported-source-type');
    if (active.has(item)) throw error('cyclic-source');
    if (seen.has(item)) return ['ref', seen.get(item)];
    const id = seen.size; seen.set(item, id); active.add(item);
    let result: unknown;
    if (item instanceof Date) result = ['date', id, String(item.getTime())];
    else if (item instanceof ArrayBuffer) result = ['buffer', id, Array.from(new Uint8Array(item))];
    else if (ArrayBuffer.isView(item)) result = ['view', id, Object.getPrototypeOf(item).constructor.name,
      item.byteOffset, item.byteLength, encode(item.buffer, depth + 1)];
    else if (item instanceof Map) result = ['map', id, Array.from(item, ([key, entry]) => [encode(key, depth + 1), encode(entry, depth + 1)])];
    else if (item instanceof Set) result = ['set', id, Array.from(item, (entry) => encode(entry, depth + 1))];
    else if (Array.isArray(item)) {
      count += item.length;
      if (count > 4_000_000) throw error('source-capacity');
      if (Object.getOwnPropertySymbols(item).length) throw error('unsupported-source-type');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      result = ['array', id, item.length, Object.keys(descriptors).filter((key) => key !== 'length').sort().map((key) => {
        const descriptor = descriptors[key];
        if (!('value' in descriptor)) throw error('unsupported-source-type');
        return [key, encode(descriptor.value, depth + 1)];
      })];
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw error('unsupported-source-type');
      if (Object.getOwnPropertySymbols(item).length) throw error('unsupported-source-type');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      result = ['object', id, Object.keys(descriptors).sort().map((key) => {
        const descriptor = descriptors[key];
        if (!('value' in descriptor)) throw error('unsupported-source-type');
        return [key, encode(descriptor.value, depth + 1)];
      })];
    }
    active.delete(item); return result;
  }
  const encoded = JSON.stringify(encode(value, 0));
  if (encoded.length > 256 * 1024 * 1024) throw error('source-capacity');
  return encoded;
}

/** 仅重建旧journal已冻结的比较证据；严格重编码相等，不修补或生成新材料。 */
export function readProjectModelSourceToken(input: unknown): unknown {
  if (typeof input !== 'string' || input.length > 256 * 1024 * 1024) throw error('invalid-source-material');
  const references = new Map<number, unknown>(), declared = new Set<number>(); let values = 0;
  const invalid = (): never => { throw error('invalid-source-material'); };
  const number = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid();
  function read(value: unknown, depth: number): unknown {
    if (++values > 4_000_000 || depth > 64) return invalid();
    const node = list(value), tag = node[0];
    if (tag === 'undefined' && node.length === 1) return undefined;
    if (tag === 'object' && node.length === 2 && node[1] === null) return null;
    if ((tag === 'string' || tag === 'boolean') && node.length === 2 && typeof node[1] === tag) return node[1];
    if (tag === 'number' && node.length === 2 && typeof node[1] === 'string') return Number(node[1]);
    if (tag === 'bigint' && node.length === 2 && typeof node[1] === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(node[1])) return BigInt(node[1]);
    const id = number(node[1]);
    if (tag === 'ref' && node.length === 2) return references.has(id) ? references.get(id) : invalid();
    if (declared.has(id)) return invalid(); declared.add(id);
    let result: unknown;
    if (tag === 'date' && node.length === 3 && typeof node[2] === 'string') result = new Date(Number(node[2]));
    else if (tag === 'buffer' && node.length === 3) {
      const bytes = list(node[2]);
      if (bytes.length > 128 * 1024 * 1024 || bytes.some((byte) => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) return invalid();
      result = Uint8Array.from(bytes as number[]).buffer;
    } else if (tag === 'view' && node.length === 6 && typeof node[2] === 'string') {
      const buffer = read(node[5], depth + 1), offset = number(node[3]), bytes = number(node[4]);
      if (!(buffer instanceof ArrayBuffer)) return invalid();
      const types = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
        Float32Array, Float64Array, BigInt64Array, BigUint64Array };
      if (node[2] === 'DataView') result = new DataView(buffer, offset, bytes);
      else if (Object.hasOwn(types, node[2])) {
        const Type = types[node[2] as keyof typeof types];
        if (bytes % Type.BYTES_PER_ELEMENT !== 0) return invalid();
        result = new Type(buffer, offset, bytes / Type.BYTES_PER_ELEMENT);
      } else return invalid();
    } else if ((tag === 'object' && node.length === 3) || (tag === 'array' && node.length === 4)) {
      const length = tag === 'array' ? number(node[2]) : 0;
      if (tag === 'array') { values += length; if (values > 4_000_000) return invalid(); }
      const target = tag === 'array' ? new Array(length) : {};
      const keys = new Set<string>();
      for (const entry of list(node[tag === 'array' ? 3 : 2])) {
        const pair = list(entry), key = pair[0];
        if (pair.length !== 2 || typeof key !== 'string' || keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)
          || tag === 'array' && (key === 'length' || /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) >= length)) return invalid();
        keys.add(key); Object.defineProperty(target, key, { value: read(pair[1], depth + 1), enumerable: true, writable: true, configurable: true });
      }
      result = target;
    } else if (tag === 'map' && node.length === 3) {
      const target = new Map<unknown, unknown>();
      for (const entry of list(node[2])) { const pair = list(entry); if (pair.length !== 2) return invalid();
        const key = read(pair[0], depth + 1); if (target.has(key)) return invalid(); target.set(key, read(pair[1], depth + 1)); }
      result = target;
    } else if (tag === 'set' && node.length === 3) {
      const target = new Set<unknown>();
      for (const entry of list(node[2])) { const child = read(entry, depth + 1); if (target.has(child)) return invalid(); target.add(child); }
      result = target;
    } else return invalid();
    references.set(id, result); return result;
  }
  let result: unknown;
  try { result = read(JSON.parse(input), 0); } catch { return invalid(); }
  if (projectModelSourceToken(result) !== input) return invalid();
  return result;
}

