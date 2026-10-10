import { lazy, Suspense } from 'react';
import type { ApiProviderConfig } from '../../types';
import { getProviderDefinition } from '../../services/ai/providerCatalogService';
import LazyLoadBoundary from './LazyLoadBoundary';

const MetalText = lazy(() => import('../../vendor/generation-effects/metal-fx/src').then((module) => ({ default: module.MetalText })));

interface ProviderBadgeProps {
  providerId: string;
  config?: ApiProviderConfig;
  fallbackName?: string;
  fallbackBadge?: string;
  size?: 'small' | 'medium' | 'large';
  appearance?: 'default' | 'metal';
  theme?: 'dark' | 'light';
}

const SIZES = {
  small: 'h-5 w-5 rounded-md text-[9px]',
  medium: 'h-6 w-6 rounded-md text-[10px]',
  large: 'h-[34px] w-[34px] rounded-lg text-[11px]',
};

const METAL_FONTS = {
  small: '600 11px/1 sans-serif',
  medium: '600 14px/1 sans-serif',
  large: '600 15px/1 sans-serif',
};

const TONES: Record<string, string> = {
  apimart: 'bg-[var(--success-bg)] text-[var(--success-light)]',
  volcengine: 'bg-[var(--info-bg)] text-[var(--info-light)]',
  grsai: 'bg-[var(--danger-bg)] text-[var(--danger-light)]',
  dreamina: 'bg-[var(--warning-bg)] text-[var(--warning-light)]',
};

function abbreviateName(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length > 1) {
    return `${Array.from(words[0] || '')[0]}${Array.from(words[words.length - 1] || '')[0]}`.toUpperCase();
  }
  const word = words[0] || '';
  const capitals = word.match(/[A-Z]/g);
  if (capitals && capitals.length > 1) return capitals.slice(0, 2).join('');
  return Array.from(word).slice(0, 2).join('').toUpperCase() || '?';
}

/** 按实际连接展示厂商身份，自定义连接使用名称缩写。 */
export default function ProviderBadge({
  providerId,
  config,
  fallbackName,
  fallbackBadge,
  size = 'medium',
  appearance = 'default',
  theme = 'dark',
}: ProviderBadgeProps) {
  const definition = getProviderDefinition(providerId, config);
  const catalogId = definition?.id || providerId;
  const isCustom = catalogId === 'custom-openai' || (!definition && !!config);
  const name = (isCustom ? config?.name?.trim() : definition?.name)
    || fallbackName || definition?.name || providerId;
  const badge = isCustom
    ? abbreviateName(name)
    : definition?.badgeText || fallbackBadge || abbreviateName(name);
  const tone = appearance === 'metal'
    ? 'text-[var(--theme-text)]'
    : `border border-[var(--separator-color)] ${TONES[catalogId] || 'bg-[var(--brand-alpha-15)] text-[var(--brand-light)]'}`;
  const metalFallback = size === 'medium' ? <span className="text-[14px]">{badge}</span> : badge;

  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={`inline-flex shrink-0 select-none items-center justify-center font-semibold leading-none tracking-wide ${SIZES[size]} ${tone}`}
    >
      {appearance === 'metal' ? (
        <LazyLoadBoundary label="模型厂商金属文字" errorFallback={metalFallback}>
          <Suspense fallback={metalFallback}>
            <MetalText
              font={METAL_FONTS[size]}
              color="var(--theme-text)"
              preset={theme === 'light' ? 'silver' : 'chromatic'}
              theme={theme}
              strength={0.85}
              paused
            >{badge}</MetalText>
          </Suspense>
        </LazyLoadBoundary>
      ) : badge}
    </span>
  );
}
