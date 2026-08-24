/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      cursor: {
        'default': 'var(--cursor-default, default)',
        'pointer': 'var(--cursor-pointer, pointer)',
        'text': 'var(--cursor-text, text)',
        'not-allowed': 'var(--cursor-not-allowed, not-allowed)',
        'move': 'var(--cursor-move, move)',
        'crosshair': 'var(--cursor-crosshair, crosshair)',
        'ew-resize': 'var(--cursor-ew-resize, ew-resize)',
        'ns-resize': 'var(--cursor-ns-resize, ns-resize)',
        'nwse-resize': 'var(--cursor-nwse-resize, nwse-resize)',
        'nesw-resize': 'var(--cursor-nesw-resize, nesw-resize)',
        'help': 'var(--cursor-help, help)',
      },
      colors: {
        /* Theme layer */
        'canvas-bg': '#0a0a0f',
        'canvas-surface': '#14141c',
        'canvas-card': '#1a1a26',
        'canvas-border': '#2a2a3a',
        'canvas-hover': '#252535',
        'canvas-text': '#e8e8ed',
        'canvas-text-secondary': '#8888a0',
        'canvas-text-muted': '#7d7d91',

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

        /* Stock Tailwind accent families, aliased to CSS variables so the light
           (macaron) theme re-tints every `text-red-400` / `bg-emerald-500/10` style
           utility from one place. Dark values equal the stock Tailwind hexes, so the
           dark theme renders exactly as before. Scales live in src/styles/base.css.
           Only the shades the app actually uses are declared — adding a new shade to
           markup means adding it here and in both theme blocks. */
        'indigo': {
          '50': 'rgb(var(--tw-indigo-50) / <alpha-value>)',
          '100': 'rgb(var(--tw-indigo-100) / <alpha-value>)',
          '200': 'rgb(var(--tw-indigo-200) / <alpha-value>)',
          '300': 'rgb(var(--tw-indigo-300) / <alpha-value>)',
          '400': 'rgb(var(--tw-indigo-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-indigo-500) / <alpha-value>)',
          '600': 'rgb(var(--tw-indigo-600) / <alpha-value>)',
        },
        'purple': {
          '400': 'rgb(var(--tw-purple-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-purple-500) / <alpha-value>)',
          '600': 'rgb(var(--tw-purple-600) / <alpha-value>)',
        },
        'violet': {
          '300': 'rgb(var(--tw-violet-300) / <alpha-value>)',
          '400': 'rgb(var(--tw-violet-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-violet-500) / <alpha-value>)',
          '600': 'rgb(var(--tw-violet-600) / <alpha-value>)',
        },
        'fuchsia': {
          '400': 'rgb(var(--tw-fuchsia-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-fuchsia-500) / <alpha-value>)',
          '600': 'rgb(var(--tw-fuchsia-600) / <alpha-value>)',
        },
        'pink': {
          '400': 'rgb(var(--tw-pink-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-pink-500) / <alpha-value>)',
        },
        'red': {
          '200': 'rgb(var(--tw-red-200) / <alpha-value>)',
          '300': 'rgb(var(--tw-red-300) / <alpha-value>)',
          '400': 'rgb(var(--tw-red-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-red-500) / <alpha-value>)',
        },
        'amber': {
          '200': 'rgb(var(--tw-amber-200) / <alpha-value>)',
          '300': 'rgb(var(--tw-amber-300) / <alpha-value>)',
          '400': 'rgb(var(--tw-amber-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-amber-500) / <alpha-value>)',
        },
        'yellow': {
          '400': 'rgb(var(--tw-yellow-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-yellow-500) / <alpha-value>)',
        },
        'emerald': {
          '100': 'rgb(var(--tw-emerald-100) / <alpha-value>)',
          '200': 'rgb(var(--tw-emerald-200) / <alpha-value>)',
          '300': 'rgb(var(--tw-emerald-300) / <alpha-value>)',
          '400': 'rgb(var(--tw-emerald-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-emerald-500) / <alpha-value>)',
        },
        'green': {
          '300': 'rgb(var(--tw-green-300) / <alpha-value>)',
          '400': 'rgb(var(--tw-green-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-green-500) / <alpha-value>)',
        },
        'blue': {
          '400': 'rgb(var(--tw-blue-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-blue-500) / <alpha-value>)',
        },
        'sky': {
          '100': 'rgb(var(--tw-sky-100) / <alpha-value>)',
          '200': 'rgb(var(--tw-sky-200) / <alpha-value>)',
          '300': 'rgb(var(--tw-sky-300) / <alpha-value>)',
          '400': 'rgb(var(--tw-sky-400) / <alpha-value>)',
        },
        'orange': {
          '400': 'rgb(var(--tw-orange-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-orange-500) / <alpha-value>)',
        },
        'cyan': {
          '400': 'rgb(var(--tw-cyan-400) / <alpha-value>)',
          '500': 'rgb(var(--tw-cyan-500) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
}
