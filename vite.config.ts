/**
 * vite.config — 配置前端构建、开发服务与画布连线适配插件。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  CANVAS_EDGE_LAYER_OPTIMIZE_INCLUDE,
  canvasEdgeLayerPlugin,
} from "./scripts/viteCanvasEdgeLayer";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    canvasEdgeLayerPlugin(),
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
      '/api/comfyui/ws': {
        target: 'http://127.0.0.1:8188',
        ws: true,
        // 保留页面的 Host 和 Origin，让 ComfyUI 继续校验两者一致。
        // 不改写 Origin，跨站请求仍由 ComfyUI 拒绝。
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api\/comfyui/, ''),
      },
      '/api/comfyui': {
        target: 'http://127.0.0.1:8188',
        // HTTP 与 WebSocket 一致，保留同源 Host/Origin，兼容 ComfyUI 默认来源校验。
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api\/comfyui/, ''),
      },
    },
  },
  build: {
    // 插件自定义界面是第二个入口：它跑在主窗口内的 sandboxed iframe 中。
    rollupOptions: {
      input: {
        main: "index.html",
        pluginUiHost: "plugin-ui-host.html",
      },
      output: {
        // PDF.js 的无 Wasm 解码器按固定名称加载，保留这两个本地资源名。
        assetFileNames: (asset) => asset.names.some((name) => /(?:jbig2|openjpeg)_nowasm_fallback\.js$/.test(name))
          ? "assets/pdf-preview/[name][extname]"
          : "assets/[name]-[hash][extname]",
      },
    },
  },
  optimizeDeps: {
    entries: ["index.html", "plugin-ui-host.html"],
    exclude: ["@xyflow/react"],
    include: CANVAS_EDGE_LAYER_OPTIMIZE_INCLUDE,
  },
});
