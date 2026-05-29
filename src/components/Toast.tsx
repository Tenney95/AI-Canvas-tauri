import { useAppStore } from '../store/useAppStore';

export default function Toast() {
  const { toast, dismissToast } = useAppStore();

  if (!toast.visible) return null;

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-top-2 duration-200">
      <div
        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl shadow-black/30 border text-sm backdrop-blur-xl ${
          toast.type === 'success'
            ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 ring-1 ring-emerald-400/10'
            : 'bg-red-500/15 border-red-500/30 text-red-300 ring-1 ring-red-400/10'
        }`}
      >
        {toast.type === 'success' ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        )}
        <span>{toast.message}</span>
        <button
          onClick={dismissToast}
          className="ml-2 opacity-60 hover:opacity-100 transition-opacity"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
