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
      output: {
        manualChunks(id) {
          // React 全家桶
          if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
            return "vendor-react";
          }
          // Framer Motion —— 体积大户
          if (id.includes("node_modules/framer-motion")) {
            return "vendor-motion";
          }
          // Three.js —— 体积大户（named imports 已优化）
          if (id.includes("node_modules/three")) {
            return "vendor-three";
          }
          // React Flow 画布引擎
          if (id.includes("node_modules/@xyflow")) {
            return "vendor-reactflow";
          }
          // 后处理特效
          if (id.includes("node_modules/postprocessing")) {
            return "vendor-postprocessing";
          }
          // Tauri 全家桶
          if (id.includes("node_modules/@tauri-apps") || id.includes("node_modules/@crabnebula")) {
            return "vendor-tauri";
          }
          // 其余 vendor 依赖
          if (id.includes("node_modules/zustand") || id.includes("node_modules/gsap") || id.includes("node_modules/@iconify") || id.includes("node_modules/react-image-crop")) {
            return "vendor-common";
          }
          // 其他未分类的 node_modules 归到一起
          if (id.includes("node_modules")) {
            return "vendor";
          }
        },
      },
    },
  },
  optimizeDeps: {
    entries: ["index.html"],
  },
});
