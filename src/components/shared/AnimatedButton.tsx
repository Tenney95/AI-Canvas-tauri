/**
 * AnimatedButton — 通用按钮封装（Apple 触感：悬浮微放大 + 按下回弹）
 *
 * 改用纯 CSS 过渡实现缩放（之前是 framer-motion 的 whileHover/whileTap 弹簧）：
 * - 之前每个按钮都是 motion.button，悬浮/按下会跑 JS 弹簧（逐帧计算 + 合成），
 *   而设置等密集面板里有几十个,鼠标扫过时同时触发大量弹簧 → 脚本/合成飙高、掉帧。
 * - CSS transform 过渡由合成器处理，无逐帧 JS,数量再多也几乎零成本。
 * - 缩放比例通过 CSS 变量传入；尊重系统「减少动效」由 CSS @media 处理（见 base.css .anim-btn）。
 */
import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';

interface AnimatedButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** 悬浮时放大比例，默认 1.04 */
  scale?: number;
  /** 按下时缩小比例，默认 0.96 */
  tapScale?: number;
}

const AnimatedButton = forwardRef<HTMLButtonElement, AnimatedButtonProps>(function AnimatedButton(
  { children, scale = 1.04, tapScale = 0.96, className, style, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`anim-btn${className ? ` ${className}` : ''}`}
      style={{
        '--anim-hover-scale': scale,
        '--anim-tap-scale': tapScale,
        ...style,
      } as CSSProperties}
      {...rest}
    >
      {children}
    </button>
  );
});

export default AnimatedButton;
