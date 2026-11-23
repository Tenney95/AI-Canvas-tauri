/**
 * 无依赖的 token 估算工具。独立成叶子模块，供系统提示词构建等不能引入
 * contextManager（会经 contextCompressionService 回到 assistantStream）的场景复用。
 */

/**
 * 估算文本 token 数。
 * CJK 字符按 1 token/字，其余按 4 字符/token。仅用于预算判断，非精确值。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if ((unit >= 0x2e80 && unit <= 0x9fff)
      || (unit >= 0xf900 && unit <= 0xfaff)
      || (unit >= 0xff00 && unit <= 0xffef)) cjkCount += 1;
  }
  return Math.ceil(cjkCount + (text.length - cjkCount) / 4);
}
