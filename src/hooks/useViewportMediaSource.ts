import { useEffect, useState, type RefObject } from 'react';

interface ObserverPool {
  observer: IntersectionObserver;
  listeners: Map<Element, (isIntersecting: boolean) => void>;
}

const observerPools = new Map<string, ObserverPool>();

function observerUnavailable(): boolean {
  return typeof IntersectionObserver === 'undefined';
}

function observeNearViewport(
  element: Element,
  rootMargin: string,
  listener: (isIntersecting: boolean) => void,
): () => void {
  let pool = observerPools.get(rootMargin);
  if (!pool) {
    const listeners = new Map<Element, (isIntersecting: boolean) => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    }, { rootMargin });
    pool = { observer, listeners };
    observerPools.set(rootMargin, pool);
  }

  pool.listeners.set(element, listener);
  pool.observer.observe(element);
  return () => {
    pool?.observer.unobserve(element);
    pool?.listeners.delete(element);
    if (pool?.listeners.size === 0) {
      pool.observer.disconnect();
      observerPools.delete(rootMargin);
    }
  };
}

export interface ViewportMediaSourceOptions {
  eager?: boolean;
  rootMargin?: string;
  unloadDelayMs?: number;
}

/**
 * 只在元素接近视口时返回真实媒体源，离开后延迟卸载。
 * 图片和视频共用按 rootMargin 分组的观察器，避免长列表逐项创建 observer。
 */
export function useViewportMediaSource<T extends Element>(
  source: string | undefined,
  elementRef: RefObject<T | null>,
  {
    eager = false,
    rootMargin = '800px 0px',
    unloadDelayMs = 2_000,
  }: ViewportMediaSourceOptions = {},
): string | undefined {
  const [observedSource, setObservedSource] = useState<string>();
  const nearViewport = eager || observerUnavailable() || observedSource === source;

  useEffect(() => {
    if (eager || !source || observerUnavailable()) return undefined;

    const element = elementRef.current;
    if (!element) return undefined;

    let unloadTimer: ReturnType<typeof setTimeout> | undefined;
    const stopObserving = observeNearViewport(element, rootMargin, (isIntersecting) => {
      if (isIntersecting) {
        if (unloadTimer !== undefined) clearTimeout(unloadTimer);
        unloadTimer = undefined;
        setObservedSource(source);
        return;
      }
      if (unloadTimer !== undefined) clearTimeout(unloadTimer);
      unloadTimer = setTimeout(() => {
        setObservedSource(undefined);
        unloadTimer = undefined;
      }, unloadDelayMs);
    });

    return () => {
      stopObserving();
      if (unloadTimer !== undefined) clearTimeout(unloadTimer);
    };
  }, [eager, elementRef, rootMargin, source, unloadDelayMs]);

  return nearViewport ? source : undefined;
}
