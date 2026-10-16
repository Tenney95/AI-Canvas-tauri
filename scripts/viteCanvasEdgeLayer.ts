import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export const CANVAS_EDGE_LAYER_REACT_FLOW_VERSION = '12.10.2';
export const CANVAS_EDGE_LAYER_ADAPTER_MARKER = '/* ai-canvas-edge-layer:12.10.2 */';

// React Flow is excluded from pre-bundling so the same adapter runs in dev/build.
// Its nested Zustand 4 must keep resolving from React Flow, rather than our Zustand 5.
export const CANVAS_EDGE_LAYER_OPTIMIZE_INCLUDE = [
  '@xyflow/react > zustand/traditional',
  '@xyflow/react > zustand/shallow',
  '@xyflow/react > zustand > use-sync-external-store/shim/with-selector.js',
];

const ENTRY_PATTERN = /(?:^|\/)node_modules\/@xyflow\/react\/dist\/esm\/index\.(?:js|mjs)$/;
const FUNCTION_SIGNATURE = 'function EdgeRendererComponent({ defaultMarkerColor, onlyRenderVisibleElements, rfId, edgeTypes, noPanClassName, onReconnect, onEdgeContextMenu, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave, onEdgeClick, reconnectRadius, onEdgeDoubleClick, onReconnectStart, onReconnectEnd, disableKeyboardA11y, }) {';
const FUNCTION_END = "\nEdgeRendererComponent.displayName = 'EdgeRenderer';";
const MARKER_ELEMENT = 'jsx(MarkerDefinitions$1, { defaultColor: defaultMarkerColor, rfId: rfId })';
const RETURN_PREFIX = `    return (jsxs("div", { className: "react-flow__edges", children: [${MARKER_ELEMENT}, edgeIds.map(`;
const RETURN_SUFFIX = ')] }));\n}';
const GEOMETRY_NAME = '__aiCanvasEdgeGeometry';
const LAYER_NAME = '__aiCanvasEdgeRenderLayer';
const GEOMETRY_DECLARATION = `const ${GEOMETRY_NAME} = Object.freeze({ getEdgePosition, getElevatedEdgeZIndex, getMarkerId });`;

export interface CanvasEdgeLayerTransformResult {
  code: string;
  map: null;
}

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/^\/@fs\//, '');
}

function adapterError(reason: string): Error {
  return new Error(`[ai-canvas-edge-layer] ${reason}；请重新审查 React Flow 连线适配点。`);
}

function uniqueIndex(source: string, needle: string, description: string): number {
  const index = source.indexOf(needle);
  if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
    throw adapterError(`${description}必须恰好出现一次`);
  }
  return index;
}

/** Adapts the two audited ESM entries in memory; never rewrites installed files. */
export function transformCanvasEdgeLayer(
  source: string,
  id: string,
  version: string,
): CanvasEdgeLayerTransformResult | null {
  if (!ENTRY_PATTERN.test(normalizeModuleId(id))) return null;
  if (version !== CANVAS_EDGE_LAYER_REACT_FLOW_VERSION) {
    throw adapterError(`仅支持 @xyflow/react ${CANVAS_EDGE_LAYER_REACT_FLOW_VERSION}，当前为 ${version}`);
  }
  if (source.includes(CANVAS_EDGE_LAYER_ADAPTER_MARKER)) {
    uniqueIndex(source, CANVAS_EDGE_LAYER_ADAPTER_MARKER, '适配标记');
    uniqueIndex(source, GEOMETRY_DECLARATION, '共享几何能力');
    uniqueIndex(source, '"data-canvas-edge-renderer":', '连线渲染诊断属性');
    return null;
  }
  if (source.includes(GEOMETRY_NAME) || source.includes(LAYER_NAME)) {
    throw adapterError('适配器局部名称已被占用');
  }

  const systemImports = [...source.matchAll(/^import \{ ([^\n]+) \} from '@xyflow\/system';$/gm)];
  const helpers = systemImports[0]?.[1].split(',').map((name) => name.trim());
  if (systemImports.length !== 1 || !helpers
    || !['getEdgePosition', 'getElevatedEdgeZIndex', 'getMarkerId'].every((name) => helpers.includes(name))) {
    throw adapterError('原生几何函数导入结构已变化');
  }

  const start = uniqueIndex(source, FUNCTION_SIGNATURE, 'EdgeRenderer 签名');
  const end = uniqueIndex(source, FUNCTION_END, 'EdgeRenderer 结束位置');
  if (end <= start) throw adapterError('EdgeRenderer 边界顺序异常');
  const body = source.slice(start, end);
  uniqueIndex(body, '    const edgeIds = useVisibleEdgeIds(onlyRenderVisibleElements);\n', '原生可见性订阅');
  const returnStart = uniqueIndex(body, RETURN_PREFIX, '原生连线容器');
  const returnEnd = uniqueIndex(body, RETURN_SUFFIX, '原生连线映射结束位置');
  if (returnEnd + RETURN_SUFFIX.length !== body.length) {
    throw adapterError('EdgeRenderer 返回结构已变化');
  }

  // Extract the installed callback verbatim: native selection, a11y and reconnect
  // props remain owned by React Flow, including special-edge fallbacks.
  const renderEdge = body.slice(returnStart + RETURN_PREFIX.length, returnEnd);
  if (!/^\(id\) => \{\n\s+return \(jsx\(EdgeWrapper\$1, \{[^\n]+\}, id\)\);\n\s+\}$/.test(renderEdge)) {
    throw adapterError('原生 EdgeWrapper 回调结构已变化');
  }

  const adaptedBody = `${CANVAS_EDGE_LAYER_ADAPTER_MARKER}
${GEOMETRY_DECLARATION}
${body.slice(0, returnStart)}    const renderEdge = ${renderEdge};
    const ${LAYER_NAME} = typeof onReconnect === 'undefined' ? edgeTypes?.default?.renderLayer : undefined;
    return (jsxs("div", { className: "react-flow__edges", "data-canvas-edge-renderer": ${LAYER_NAME} ? "central" : "native", children: [${MARKER_ELEMENT}, ${LAYER_NAME} ? jsx(${LAYER_NAME}, { edgeIds, rfId, noPanClassName, disableKeyboardA11y, onEdgeClick, onEdgeDoubleClick, onEdgeContextMenu, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave, renderEdge, geometry: ${GEOMETRY_NAME} }) : edgeIds.map(renderEdge)] }));
}`;

  // magic-string is not a direct project dependency. This small guarded adapter
  // intentionally returns no source map; the adapted dependency's debug lines
  // refer to generated code until a directly declared mapping utility is adopted.
  return { code: source.slice(0, start) + adaptedBody + source.slice(end), map: null };
}

export function canvasEdgeLayerPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@xyflow/react/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
  if (manifest.version !== CANVAS_EDGE_LAYER_REACT_FLOW_VERSION) {
    throw adapterError(`仅支持 @xyflow/react ${CANVAS_EDGE_LAYER_REACT_FLOW_VERSION}，请先核对安装版本`);
  }
  const version = manifest.version;
  const entries = new Set(['index.js', 'index.mjs'].map((entry) =>
    normalizeModuleId(join(dirname(manifestPath), 'dist/esm', entry))));

  return {
    name: 'ai-canvas-react-flow-edge-layer',
    enforce: 'pre',
    transform(source, id) {
      if (!entries.has(normalizeModuleId(id))) return null;
      return transformCanvasEdgeLayer(source, id, version);
    },
  };
}
