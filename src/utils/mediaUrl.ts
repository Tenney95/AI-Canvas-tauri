/** 只判断媒体来源；网络 URL 是否允许访问仍由各调用方校验。 */
function parseUrl(value: string | undefined): URL | undefined {
  // 内嵌媒体无需解析正文，其余 URL 交给 URL 处理大小写与控制字符。
  if (!value || /^(?:data|blob):/i.test(value.trimStart())) return undefined;
  try { return new URL(value); } catch { return undefined; }
}

function isAssetSource(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return (url.protocol === 'asset:' && hostname === 'localhost')
    || (['http:', 'https:'].includes(url.protocol) && hostname === 'asset.localhost');
}

export function isTauriAssetUrl(value: string | undefined): boolean {
  const url = parseUrl(value);
  return !!url && isAssetSource(url);
}

export function isLocalMediaUrl(value: string | undefined): boolean {
  if (!value) return false;
  if (/^(?:data|blob|file|asset):/i.test(value.trimStart())) return true;
  const url = parseUrl(value);
  return !!url && (['data:', 'blob:', 'file:', 'asset:'].includes(url.protocol) || isAssetSource(url));
}

export function isRemoteMediaUrl(value: string | undefined): value is string {
  const url = parseUrl(value);
  return !!url && ['http:', 'https:'].includes(url.protocol) && !isAssetSource(url);
}

/** 还原 asset/file URL；这里只解码，读取与复制仍须经过文件权限校验。 */
export function localMediaUrlToPath(value: string | undefined): string | undefined {
  const url = parseUrl(value);
  if (!url || url.username || url.password || (!isAssetSource(url) && url.protocol !== 'file:')) return undefined;
  try {
    let path = decodeURIComponent(url.pathname);
    if (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost') {
      path = `//${url.hostname}${path}`;
    } else if (isAssetSource(url)) {
      // convertFileSrc 会把路径整体编码：去掉路由前缀后保留 Unix 根目录与 UNC 前缀。
      const decoded = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (/^(?:[a-z]:[/\\]|[/\\])/i.test(decoded)) path = decoded;
    }
    if (/^\/[a-z]:[/\\]/i.test(path)) path = path.slice(1);
    return path && !path.includes('\0') ? path : undefined;
  } catch { return undefined; }
}
