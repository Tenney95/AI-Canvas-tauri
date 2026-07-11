/**
 * Toast slice — ephemeral user-facing message state
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';

export interface ToastSlice {
  toast: { visible: boolean; message: string; type: 'success' | 'error' | 'info' };
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  dismissToast: () => void;
}

const initialToast = { visible: false, message: '', type: 'success' as const };

export const createToastSlice: StateCreator<AppState, [], [], ToastSlice> = (set, get) => ({
  toast: { ...initialToast },
  showToast: (message, type = 'success') => {
    set({ toast: { visible: true, message, type } });
    setTimeout(() => {
      const { toast } = get();
      if (toast.visible) set({ toast: { ...toast, visible: false } });
    }, 2500);
  },
  dismissToast: () => set({ toast: { visible: false, message: '', type: 'success' } }),
});
