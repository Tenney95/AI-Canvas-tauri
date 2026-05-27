/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'canvas-bg': '#0a0a0f',
        'canvas-surface': '#14141c',
        'canvas-card': '#1a1a26',
        'canvas-border': '#2a2a3a',
        'canvas-hover': '#252535',
        'canvas-text': '#e8e8ed',
        'canvas-text-secondary': '#8888a0',
        'canvas-text-muted': '#555566',
        'indigo': '#6366f1',
        'purple': '#a855f7',
      },
    },
  },
  plugins: [],
}
