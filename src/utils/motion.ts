/**
 * motion.ts — 统一动效预设（贴近 Apple 系统手感）
 *
 * 设计原则：
 *  - 交互元素用「弹簧」而非时长缓动，带极轻微的过冲（overshoot），落位自然。
 *  - 用 framer-motion v12 的 visualDuration + bounce 描述弹簧：
 *      visualDuration ≈ 视觉到位时间（类似 SwiftUI 的 response）
 *      bounce         ≈ 弹性（0 无过冲，越大越弹；Apple 默认偏克制 0.15~0.25）
 *  - 纯透明度/位移渐变用 expo-out 缓动，与 CSS 令牌 --ease-out-expo 对齐。
 */
import type { Transition, Variants } from 'framer-motion';

/* ── 缓动曲线（与 base.css 的 CSS 令牌保持一致）─────────────────── */
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;
export const EASE_OUT_QUART = [0.25, 1, 0.5, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

/* ── 弹簧预设 ──────────────────────────────────────────────────────
 * snappy : 按钮 / 开关 / 小控件 —— 快、极轻过冲
 * smooth : 模态 / 弹层 / 菜单   —— 顺、稳，几乎不弹
 * gentle : 大面板 / 抽屉        —— 柔和落位
 * bouncy : 强调动效（徽标/图标）—— 明显弹性，少量使用
 */
export const springSnappy: Transition = { type: 'spring', visualDuration: 0.22, bounce: 0.2 };
export const springSmooth: Transition = { type: 'spring', visualDuration: 0.38, bounce: 0.16 };
export const springGentle: Transition = { type: 'spring', visualDuration: 0.5, bounce: 0.1 };
export const springBouncy: Transition = { type: 'spring', visualDuration: 0.45, bounce: 0.42 };

/* ── 纯渐变过渡（无物理感的淡入淡出）────────────────────────────── */
export const fadeFast: Transition = { duration: 0.18, ease: EASE_OUT_EXPO };
export const fadeNormal: Transition = { duration: 0.24, ease: EASE_OUT_EXPO };

/* ── 通用进出场变体（弹层/卡片/Toast 复用）──────────────────────── */
export const popVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 8 },
  visible: { opacity: 1, scale: 1, y: 0, transition: springSmooth },
  exit: { opacity: 0, scale: 0.96, y: 8, transition: fadeFast },
};

/* 自下而上浮入（菜单/上下文条）*/
export const floatUpVariants: Variants = {
  hidden: { opacity: 0, y: 6, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: springSnappy },
  exit: { opacity: 0, y: 6, scale: 0.98, transition: fadeFast },
};

/* ── 可按压交互（hover 微放大 + 按下回弹，Apple 触感）──────────────
 * 直接展开到 motion 组件：<motion.button {...pressable} />
 */
export const pressable = {
  whileHover: { scale: 1.04 },
  whileTap: { scale: 0.96 },
  transition: springSnappy,
} as const;

/** 用于图标类小目标的轻量按压（过冲更小，避免抖动）*/
export const pressableSubtle = {
  whileHover: { scale: 1.06 },
  whileTap: { scale: 0.92 },
  transition: springSnappy,
} as const;
