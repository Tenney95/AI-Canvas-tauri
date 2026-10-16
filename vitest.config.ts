import { defineConfig } from 'vitest/config';
import { canvasEdgeLayerPlugin } from './scripts/viteCanvasEdgeLayer';

export default defineConfig({
  plugins: [canvasEdgeLayerPlugin()],
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    fileParallelism: false,
    server: {
      deps: { inline: ['@xyflow/react'] },
    },
  },
});
