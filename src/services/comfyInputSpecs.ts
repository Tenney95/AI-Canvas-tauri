/** 读取官方两种 COMBO 声明；远程选项和动态分支不在此处请求或展开。 */
export function comfyComboOptions(declaration: unknown): unknown[] | undefined {
  if (!Array.isArray(declaration)) return undefined;
  const [type, config] = declaration;
  if (Array.isArray(type)) return type;
  if (type !== 'COMBO' || !config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  return Array.isArray(config.options) ? config.options : undefined;
}
