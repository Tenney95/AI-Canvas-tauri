/** Clamp v into [min, max]. */
export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 文本节点高度：40 + 每行 20，夹在 [min, 600]。 */
export const textNodeHeight = (lines: number, min = 120) => clamp(40 + lines * 20, min, 600);
