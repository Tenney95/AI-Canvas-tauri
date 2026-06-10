/**
 * AnimatedButton — 带 framer-motion 悬浮缩放效果的通用按钮封装
 * 使用 whileHover 实现鼠标悬浮时微微放大
 */
import { motion, type MotionProps } from 'framer-motion';
import type { ReactNode } from 'react';

interface AnimatedButtonProps extends Omit<MotionProps, 'onClick'> {
  children: ReactNode;
  /** 悬浮时放大比例，默认 1.05 */
  scale?: number;
  className?: string;
  style?: React.CSSProperties;
  type?: React.ButtonHTMLAttributes<HTMLButtonElement>['type'];
  disabled?: boolean;
  title?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

export default function AnimatedButton({
  children,
  scale = 1.05,
  className,
  style,
  ...rest
}: AnimatedButtonProps) {
  return (
    <motion.button
      className={className}
      style={style}
      whileHover={{ scale }}
      transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
