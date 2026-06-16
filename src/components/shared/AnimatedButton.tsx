/**
 * AnimatedButton — 通用按钮封装（Apple 触感：悬浮微放大 + 按下回弹）
 *
 * - whileHover 微放大、whileTap 按下回弹，弹簧落位（springSnappy）。
 * - 尊重系统「减少动效」偏好：开启时禁用缩放，仅保留即时反馈。
 */
import { motion, useReducedMotion, type MotionProps } from 'framer-motion';
import type { ReactNode } from 'react';
import { springSnappy } from '../../utils/motion';

interface AnimatedButtonProps extends Omit<MotionProps, 'onClick'> {
  children: ReactNode;
  /** 悬浮时放大比例，默认 1.04 */
  scale?: number;
  /** 按下时缩小比例，默认 0.96 */
  tapScale?: number;
  className?: string;
  style?: React.CSSProperties;
  type?: React.ButtonHTMLAttributes<HTMLButtonElement>['type'];
  disabled?: boolean;
  title?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

export default function AnimatedButton({
  children,
  scale = 1.04,
  tapScale = 0.96,
  className,
  style,
  ...rest
}: AnimatedButtonProps) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      className={className}
      style={style}
      whileHover={reduceMotion ? undefined : { scale }}
      whileTap={reduceMotion ? undefined : { scale: tapScale }}
      transition={springSnappy}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
