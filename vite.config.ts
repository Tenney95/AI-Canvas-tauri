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
    // 代理 ComfyUI 本体请求到本地服务，开发模式下绕过 CORS
    proxy: {
      '/api/comfyui': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/comfyui/, ''),
      },
    },
  },
  optimizeDeps: {
    entries: ["index.html"],
  },
});
