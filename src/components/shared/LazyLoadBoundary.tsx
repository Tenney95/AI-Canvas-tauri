import { Component, type ErrorInfo, type ReactNode } from 'react';

type LazyLoadVariant = 'root' | 'feature';

interface LazyLoadFallbackProps {
  label: string;
  variant?: LazyLoadVariant;
}

interface LazyLoadBoundaryProps extends LazyLoadFallbackProps {
  children: ReactNode;
}

interface LazyLoadBoundaryState {
  failed: boolean;
}

export function LazyLoadFallback({ label, variant = 'feature' }: LazyLoadFallbackProps) {
  if (variant === 'root') {
    return (
      <div
        className="flex min-h-screen w-screen items-center justify-center bg-canvas-bg px-6 text-canvas-text"
        role="status"
        aria-live="polite"
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <span
            className="h-7 w-7 animate-spin rounded-full border-2 border-canvas-border border-t-canvas-text-secondary"
            aria-hidden="true"
          />
          <p className="text-sm text-canvas-text-secondary">正在加载{label}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed bottom-5 left-1/2 z-[300] flex -translate-x-1/2 items-center gap-2 rounded-md border border-canvas-border bg-canvas-card px-3 py-2 shadow-xl"
      role="status"
      aria-live="polite"
    >
      <span
        className="h-3.5 w-3.5 animate-spin rounded-full border border-canvas-text-muted border-t-canvas-text-secondary"
        aria-hidden="true"
      />
      <span className="text-xs text-canvas-text-secondary">正在加载{label}</span>
    </div>
  );
}

export default class LazyLoadBoundary extends Component<
  LazyLoadBoundaryProps,
  LazyLoadBoundaryState
> {
  state: LazyLoadBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyLoadBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[LazyLoadBoundary] ${this.props.label}加载失败`, error, info.componentStack);
  }

  handleRetry = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;

    if (this.props.variant === 'root') {
      return (
        <div
          className="flex min-h-screen w-screen items-center justify-center bg-canvas-bg px-6 text-canvas-text"
          role="alert"
        >
          <div className="flex max-w-sm flex-col items-center text-center">
            <h1 className="text-lg font-semibold">应用加载失败</h1>
            <p className="mt-2 text-sm leading-6 text-canvas-text-secondary">
              {this.props.label}暂时无法加载，请重新尝试。
            </p>
            <button
              type="button"
              className="mt-5 rounded-md border border-canvas-border bg-canvas-card px-4 py-2 text-sm text-canvas-text transition-colors hover:bg-canvas-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-text-secondary"
              onClick={this.handleRetry}
            >
              重试
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        className="fixed bottom-5 left-1/2 z-[300] flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 items-center gap-4 rounded-md border border-canvas-border bg-canvas-card px-4 py-3 shadow-xl"
        role="alert"
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-canvas-text">{this.props.label}加载失败</p>
          <p className="mt-0.5 text-xs text-canvas-text-secondary">画布仍可继续使用</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md border border-canvas-border px-3 py-1.5 text-xs text-canvas-text transition-colors hover:bg-canvas-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-text-secondary"
          onClick={this.handleRetry}
        >
          重试
        </button>
      </div>
    );
  }
}
