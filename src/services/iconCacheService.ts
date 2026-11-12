/**
 * iconCacheService — 注册随包图标，并恢复额外图标的持久缓存。
 */
import { _api, addCollection, addIcon, getIcon, type IconifyJSON } from '@iconify/react';
import bundledIcons from '../assets/ui-icons.json';

// 独立于项目数据，按图标保存，避免多个窗口覆盖彼此的缓存；无时间过期。
const CACHE_PREFIX = 'ai-canvas:iconify:v1:';
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
let installed = false;

function restoreIcons(storage: Storage) {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(CACHE_PREFIX)) continue;
    const name = key.slice(CACHE_PREFIX.length);
    if (!ICON_NAME.test(name)) continue;
    // 应用图标以随包版本为准，旧缓存不能把已修正的图标覆盖回去。
    if (Object.hasOwn(bundledIcons, name)) continue;
    try {
      const icon: unknown = JSON.parse(storage.getItem(key) ?? 'null');
      if (!icon || typeof icon !== 'object' || !('body' in icon) || typeof icon.body !== 'string') continue;
      const [prefix, shortName] = name.split(':');
      // 使用图标集校验，坏记录不会阻止其余图标恢复。
      addCollection({ prefix, icons: { [shortName]: { ...icon, body: icon.body } } }, '');
    } catch {
      // 缓存不是权威数据，损坏时允许 Iconify 重新联网获取。
    }
  }
}

function iconRequestPrefix(input: RequestInfo | URL): string | null {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const config = _api.getAPIConfig('');
    if (!config || !url.searchParams.has('icons')) return null;
    for (const resource of config.resources) {
      const base = new URL(resource + config.path);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) continue;
      const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(url.pathname.slice(base.pathname.length));
      if (match) return match[1];
    }
  } catch {
    // 仅缓存默认图标服务的图标响应，其他请求保持原样。
  }
  return null;
}

function saveIcons(storage: Storage, prefix: string, data: unknown) {
  if (!data || typeof data !== 'object' || !('prefix' in data) || data.prefix !== prefix) return;
  if (!('icons' in data) || !data.icons || typeof data.icons !== 'object') return;
  // 让 Iconify 解析别名、继承尺寸和旋转；只保存可用图标，不缓存 404。
  const collection = { ...data, not_found: [] } as IconifyJSON;
  if (!addCollection(collection, '')) return;
  const names = [...Object.keys(collection.icons), ...Object.keys(collection.aliases ?? {})];
  for (const shortName of names) {
    const name = `${prefix}:${shortName}`;
    if (!ICON_NAME.test(name)) continue;
    const icon = getIcon(name);
    if (!icon) continue;
    try {
      storage.setItem(CACHE_PREFIX + name, JSON.stringify(icon));
    } catch {
      // 配额不足或存储被禁用时保留已有缓存，当前图标仍可从内存显示。
      break;
    }
  }
}

/** 挂载前先注册固定图标；存储不可用也不影响它们，额外图标继续沿用持久缓存。 */
export function initializeIconCache() {
  if (installed) return;
  installed = true;
  for (const [name, icon] of Object.entries(bundledIcons)) addIcon(name, icon);
  let storage: Storage;
  try {
    storage = window.localStorage;
    restoreIcons(storage);
  } catch {
    return;
  }
  const fetchIcons = _api.getFetch();
  if (!fetchIcons) return;
  // 只替换 Iconify 的请求适配器，不影响应用全局 fetch 或模型请求。
  _api.setFetch(async (input, init) => {
    const response = await fetchIcons(input, init);
    const prefix = iconRequestPrefix(input);
    if (response.ok && prefix && (!init?.method || init.method.toUpperCase() === 'GET')) {
      try {
        saveIcons(storage, prefix, await response.clone().json());
      } catch {
        // 不消费或修改原始响应，解析失败仍交给 Iconify 原有流程处理。
      }
    }
    return response;
  });
}
