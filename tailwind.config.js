/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* Theme layer */
        'canvas-bg': '#0a0a0f',
        'canvas-surface': '#14141c',
        'canvas-card': '#1a1a26',
        'canvas-border': '#2a2a3a',
        'canvas-hover': '#252535',
        'canvas-text': '#e8e8ed',
        'canvas-text-secondary': '#8888a0',
        'canvas-text-muted': '#555566',

        /* Brand */
        'brand': '#6366f1',
        'brand-light': '#818cf8',
        'brand-pale': '#a5b4fc',

        /* Node type colors */
        'node-text': '#6366f1',
        'node-text-light': '#818cf8',
        'node-image': '#22c55e',
        'node-image-light': '#4ade80',
        'node-video': '#3b82f6',
        'node-video-light': '#60a5fa',
        'node-audio': '#f97316',
        'node-audio-light': '#fb923c',
        'node-panorama': '#06b6d4',
        'node-panorama-light': '#22d3ee',

        /* Semantic */
        'success': '#22c55e',
        'success-light': '#4ade80',
        'success-text': '#34d399',
        'danger': '#ef4444',
        'danger-light': '#f87171',
        'danger-pale': '#fca5a5',
        'info': '#3b82f6',
        'info-light': '#60a5fa',
        'warning': '#f97316',
        'warning-light': '#fb923c',

        /* Border variants */
        'border-subtle': 'rgba(255, 255, 255, 0.06)',
        'border-secondary': '#3a3a4a',

        /* Scrollbar */
        'scrollbar-thumb': '#3a3a50',
        'scrollbar-thumb-hover': '#555570',

        /* Preserved palette */
        'indigo': {
          '400': '#818cf8',
          '500': '#6366f1',
        },
        'purple': {
          '400': '#c084fc',
          '500': '#a855f7',
        },
      },
    },
  },
  plugins: [],
}
