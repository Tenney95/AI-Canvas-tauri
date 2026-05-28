import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { inspectorServer } from "@react-dev-inspector/vite-plugin";

const isDev = process.env.NODE_ENV !== "production";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // 在 OXC 转换 JSX 之前，用 Babel 注入 __source（react-dev-inspector 依赖此信息定位源码）
    ...(isDev
      ? [
          babel({
            include: /\.[jt]sx$/,
            plugins: ["@babel/plugin-transform-react-jsx-source"],
          }),
        ]
      : []),
    react(),
    inspectorServer(),
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
