import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/doc/**"],
    },
  },
  build: {
    rollupOptions: {
      input: "index.html",
    },
  },
  optimizeDeps: {
    entries: ["index.html"],
  },
});
