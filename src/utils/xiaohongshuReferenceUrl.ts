/** 只保留公开笔记身份，避免记录 CDN 签名、登录参数和跟踪参数。 */
export function canonicalXiaohongshuReferenceUrl(value: unknown): string | undefined {
  return typeof value === 'string' && /^https:\/\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{24}$/.test(value)
    ? value : undefined;
}
