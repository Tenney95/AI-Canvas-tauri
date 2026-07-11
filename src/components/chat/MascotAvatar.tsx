import { useId } from 'react';

interface MascotAvatarProps {
  size?: number;
  className?: string;
}

/** 轻量版吉祥物头像，用于聊天标题、空状态与助手消息。 */
export default function MascotAvatar({ size = 28, className = '' }: MascotAvatarProps) {
  const gradientId = `mascot-avatar-${useId().replace(/:/g, '')}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={gradientId} cx="32%" cy="24%" r="78%">
          <stop offset="0%" stopColor="var(--theme-text)" stopOpacity="0.98" />
          <stop offset="56%" stopColor="var(--theme-text-secondary)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--theme-bg)" stopOpacity="0.95" />
        </radialGradient>
      </defs>
      <circle
        cx="16"
        cy="16"
        r="14.5"
        fill={`url(#${gradientId})`}
        stroke="var(--theme-border)"
        strokeWidth="0.75"
      />
      <rect x="10.25" y="12.5" width="2.8" height="6.4" rx="1.4" fill="var(--theme-bg)" />
      <rect x="18.95" y="12.5" width="2.8" height="6.4" rx="1.4" fill="var(--theme-bg)" />
    </svg>
  );
}
