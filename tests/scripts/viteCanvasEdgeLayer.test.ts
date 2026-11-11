/**
 * viteCanvasEdgeLayer — 回归测试：React Flow 集中连线构建适配。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  CANVAS_EDGE_LAYER_ADAPTER_MARKER,
  CANVAS_EDGE_LAYER_REACT_FLOW_VERSION,
  canvasEdgeLayerPlugin,
  transformCanvasEdgeLayer,
} from '../../scripts/viteCanvasEdgeLayer';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('@xyflow/react/package.json'));
const version = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version;
const entries = ['index.js', 'index.mjs'].map((name) => {
  const id = join(packageRoot, 'dist/esm', name);
  return { name, id, source: readFileSync(id, 'utf8') };
});

interface ElementTree {
  type: unknown;
  props: Record<string, unknown>;
  key?: string;
}

function createRendererHarness(code: string) {
  const start = code.indexOf(CANVAS_EDGE_LAYER_ADAPTER_MARKER);
  const end = code.indexOf("\nEdgeRendererComponent.displayName = 'EdgeRenderer';", start);
  const jsx = vi.fn((type: unknown, props: Record<string, unknown>, key?: string): ElementTree => ({ type, props, key }));
  const edgeIds = ['ordinary', 'special'];
  const nativeWrapper = Symbol('EdgeWrapper');
  const markers = Symbol('MarkerDefinitions');
  const geometry = {
    getEdgePosition: vi.fn(),
    getElevatedEdgeZIndex: vi.fn(),
    getMarkerId: vi.fn(),
  };
  // Execute only the adapted renderer declaration from the installed entry.
  // All hooks/JSX are stubs; the rest of React Flow is neither copied nor run.
  const createRenderer = new Function(
    'useStore', 'useVisibleEdgeIds', 'selector$a', 'shallow', 'jsx', 'jsxs',
    'MarkerDefinitions$1', 'EdgeWrapper$1', 'getEdgePosition', 'getElevatedEdgeZIndex', 'getMarkerId',
    `${code.slice(start, end)}\nreturn EdgeRendererComponent;`,
  ) as (...args: unknown[]) => (props: Record<string, unknown>) => ElementTree;
  const render = createRenderer(
    () => ({ edgesFocusable: true, edgesReconnectable: true, elementsSelectable: true, onError: undefined }),
    () => edgeIds, {}, {}, jsx, jsx, markers, nativeWrapper,
    geometry.getEdgePosition, geometry.getElevatedEdgeZIndex, geometry.getMarkerId,
  );
  return { render, jsx, edgeIds, nativeWrapper, markers, geometry };
}

function transformedEntry(entry = entries[0]) {
  const result = transformCanvasEdgeLayer(entry.source, entry.id, version);
  if (!result) throw new Error('真实 React Flow 入口没有经过连线适配');
  return result;
}

describe('React Flow 集中连线构建适配', () => {
  it.each(entries)('在真实 $name 入口提取原回调，保留其余模块与 MarkerDefinitions', (entry) => {
    expect(version).toBe(CANVAS_EDGE_LAYER_REACT_FLOW_VERSION);
    const result = transformedEntry(entry);
    const originalStart = entry.source.indexOf('function EdgeRendererComponent(');
    const originalEnd = entry.source.indexOf("\nEdgeRendererComponent.displayName = 'EdgeRenderer';", originalStart);
    const adaptedStart = result.code.indexOf(CANVAS_EDGE_LAYER_ADAPTER_MARKER);
    const adaptedEnd = result.code.indexOf("\nEdgeRendererComponent.displayName = 'EdgeRenderer';", adaptedStart);
    expect(result.code.slice(0, adaptedStart)).toBe(entry.source.slice(0, originalStart)
      .replace('store.setState({ transform });', '__aiCanvasSetViewport(store, transform);'));
    expect(result.code.slice(adaptedEnd)).toBe(entry.source.slice(originalEnd)
      .replace('store.setState({ transform: [viewport.x, viewport.y, viewport.zoom] });', '__aiCanvasSetViewport(store, [viewport.x, viewport.y, viewport.zoom]);'));
    expect(result.code).toContain('const renderEdge = (id) => {');
    expect(result.code).toContain('jsx(MarkerDefinitions$1, { defaultColor: defaultMarkerColor, rfId: rfId })');
    expect(result.map).toBeNull();
    expect(transformCanvasEdgeLayer(result.code, entry.id, version)).toBeNull();
  });

  it('普通 React Flow 与未声明默认层的边仍走原生渲染', () => {
    const harness = createRendererHarness(transformedEntry().code);
    for (const edgeTypes of [undefined, {}, { custom: { renderLayer: () => null } }]) {
      const tree = harness.render({ edgeTypes, rfId: 'other-flow', noPanClassName: 'nopan' });
      expect(tree.props['data-canvas-edge-renderer']).toBe('native');
      const children = tree.props.children as [ElementTree, ElementTree[]];
      expect(children[0].type).toBe(harness.markers);
      expect(children[1].map((child) => child.type)).toEqual([harness.nativeWrapper, harness.nativeWrapper]);
      expect(children[1].map((child) => child.props.id)).toEqual(harness.edgeIds);
    }
  });

  it('集中层不创建普通 wrapper，特殊边可复用原生 renderEdge 和事件参数', () => {
    const harness = createRendererHarness(transformedEntry().code);
    const renderLayer = () => null;
    const callbacks = {
      onEdgeClick: vi.fn(), onEdgeDoubleClick: vi.fn(), onEdgeContextMenu: vi.fn(),
      onEdgeMouseEnter: vi.fn(), onEdgeMouseMove: vi.fn(), onEdgeMouseLeave: vi.fn(),
    };
    const props = {
      edgeTypes: { default: { renderLayer } }, rfId: 'canvas', noPanClassName: 'canvas-nopan',
      disableKeyboardA11y: true, reconnectRadius: 19, defaultMarkerColor: 'currentColor', ...callbacks,
    };
    const first = harness.render(props);
    const children = first.props.children as ElementTree[];
    expect(first.props['data-canvas-edge-renderer']).toBe('central');
    expect(children[0].props).toEqual({ defaultColor: 'currentColor', rfId: 'canvas' });
    expect(children[1].type).toBe(renderLayer);
    expect(harness.jsx.mock.calls.some(([type]) => type === harness.nativeWrapper)).toBe(false);
    expect(children[1].props).toMatchObject({
      edgeIds: harness.edgeIds, rfId: 'canvas', noPanClassName: 'canvas-nopan', disableKeyboardA11y: true, ...callbacks,
    });
    const renderEdge = children[1].props.renderEdge as (id: string) => ElementTree;
    const fallback = renderEdge('special');
    expect(fallback.type).toBe(harness.nativeWrapper);
    expect(fallback.key).toBe('special');
    expect(fallback.props).toMatchObject({
      id: 'special', rfId: 'canvas', edgeTypes: props.edgeTypes, noPanClassName: 'canvas-nopan',
      edgesFocusable: true, edgesReconnectable: true, elementsSelectable: true, disableKeyboardA11y: true,
      reconnectRadius: 19, onClick: callbacks.onEdgeClick, onDoubleClick: callbacks.onEdgeDoubleClick,
      onContextMenu: callbacks.onEdgeContextMenu, onMouseEnter: callbacks.onEdgeMouseEnter,
      onMouseMove: callbacks.onEdgeMouseMove, onMouseLeave: callbacks.onEdgeMouseLeave,
    });
    const secondChildren = harness.render(props).props.children as ElementTree[];
    expect(children[1].props.geometry).toBe(secondChildren[1].props.geometry);
    expect(children[1].props.geometry).toMatchObject(harness.geometry);
    expect(children[1].props.geometry).toHaveProperty('getViewportRevision', expect.any(Function));
  });

  it('声明 reconnect 时完整回退原生 renderer', () => {
    const harness = createRendererHarness(transformedEntry().code);
    const onReconnect = vi.fn();
    const onReconnectStart = vi.fn();
    const onReconnectEnd = vi.fn();
    const tree = harness.render({
      edgeTypes: { default: { renderLayer: () => null } },
      onReconnect, onReconnectStart, onReconnectEnd,
    });
    expect(tree.props['data-canvas-edge-renderer']).toBe('native');
    const children = tree.props.children as [ElementTree, ElementTree[]];
    expect(children[1][0].props).toMatchObject({ onReconnect, onReconnectStart, onReconnectEnd });
  });

  it('纯视口发布在同步通知前继承版本，任意其他发布均失效', () => {
    const code = transformedEntry().code;
    const declaration = code.slice(code.indexOf(CANVAS_EDGE_LAYER_ADAPTER_MARKER), code.indexOf('function EdgeRendererComponent('));
    const helpers = new Function('getEdgePosition', 'getElevatedEdgeZIndex', 'getMarkerId',
      `${declaration}\nreturn { publish: __aiCanvasSetViewport, revision: __aiCanvasEdgeViewportRevision };`)(vi.fn(), vi.fn(), vi.fn()) as {
        publish: (store: unknown, transform: number[]) => void;
        revision: (state: object) => object;
      };
    const store = createStore(() => ({ transform: [0, 0, 1], nodeLookup: new Map([['a', { x: 0 }]]) }));
    const initial = store.getState();
    const observed: object[] = [];
    store.subscribe((state) => observed.push(helpers.revision(state)));
    helpers.publish(store, [10, 20, 1]);
    helpers.publish(store, [30, 40, 2]);
    expect(observed).toEqual([initial, initial]);
    expect(store.getState().nodeLookup).toBe(initial.nodeLookup);
    store.getState().nodeLookup.get('a')!.x = 30;
    store.setState({}); // RF publishes this after in-place measurements.
    const measured = store.getState();
    expect(helpers.revision(measured)).toBe(measured);
    helpers.publish(store, [50, 60, 2]);
    expect(observed.slice(-2)).toEqual([measured, measured]);
  });

  it('忽略非已核对的入口并接受 Vite query 与 Windows 路径', () => {
    const entry = entries[0];
    expect(transformCanvasEdgeLayer(entry.source, entry.id.replaceAll('\\', '/') + '?v=canvas', version)).not.toBeNull();
    expect(transformCanvasEdgeLayer(entry.source, entry.id.replaceAll('/', '\\'), version)).not.toBeNull();
    expect(transformCanvasEdgeLayer(entry.source, '/@fs/' + entry.id.replaceAll('\\', '/'), version)).not.toBeNull();
    for (const id of ['src/components/Canvas.tsx', '/node_modules/@xyflow/react/dist/umd/index.js', '/node_modules/@xyflow/system/dist/esm/index.js', entry.id + '.map']) {
      expect(transformCanvasEdgeLayer(entry.source, id, 'unsupported')).toBeNull();
    }
  });

  it('版本、唯一性、原生返回结构和几何导入变化时明确失败', () => {
    const entry = entries[0];
    expect(() => transformCanvasEdgeLayer(entry.source, entry.id, '12.11.0')).toThrow('仅支持');
    expect(() => transformCanvasEdgeLayer(entry.source + '\nfunction EdgeRendererComponent(' + entry.source.split('function EdgeRendererComponent(')[1], entry.id, version)).toThrow('必须恰好出现一次');
    expect(() => transformCanvasEdgeLayer(entry.source.replace('className: "react-flow__edges", children:', 'className: "different", children:'), entry.id, version)).toThrow('原生连线容器');
    expect(() => transformCanvasEdgeLayer(entry.source.replace('const edgeIds = useVisibleEdgeIds(onlyRenderVisibleElements);', 'const edgeIds = [];'), entry.id, version)).toThrow('原生可见性订阅');
    expect(() => transformCanvasEdgeLayer(entry.source.replace('getMarkerId, getConnectionStatus', 'getMarkerId as renamedMarker, getConnectionStatus'), entry.id, version)).toThrow('原生几何函数导入结构');
    expect(() => transformCanvasEdgeLayer(entry.source.replace('store.setState({ transform });', 'store.setState({ transform, nodes: [] });'), entry.id, version)).toThrow('纯视口发布入口');
    expect(() => transformCanvasEdgeLayer(CANVAS_EDGE_LAYER_ADAPTER_MARKER + entry.source, entry.id, version)).toThrow('共享几何能力');
  });

  it('插件在 dev/build 原生过滤实际安装包的两个入口，保留 handler 内的入口和结构守卫', () => {
    const plugin = canvasEdgeLayerPlugin();
    expect(plugin.enforce).toBe('pre');
    expect(plugin.apply).toBeUndefined();
    const transform = plugin.transform;
    if (!transform || typeof transform === 'function') throw new Error('缺少 Vite 连线过滤钩子');
    const filter = transform.filter?.id;
    if (!(filter instanceof RegExp)) throw new Error('缺少原生入口过滤器');
    const invoke = transform.handler as (source: string, id: string) => { code: string } | null;
    for (const entry of entries) {
      const normalized = entry.id.replaceAll('\\', '/');
      for (const id of [entry.id, normalized + '?v=canvas', normalized + '#entry',
        normalized.replaceAll('/', '\\'), '/@fs/' + normalized, '/@fs/' + normalized + '?v=canvas#entry']) {
        expect(filter.test(id)).toBe(true);
        expect(invoke(entry.source, id)?.code).toContain(CANVAS_EDGE_LAYER_ADAPTER_MARKER);
      }
    }
    const normalizedEntryId = entries[0].id.replaceAll('\\', '/');
    const unrelated = [
      'src/components/Canvas.tsx', normalizedEntryId + '.map',
      normalizedEntryId.replace('node_modules', 'other/node_modules'),
      normalizedEntryId.replace('@xyflow', '@xyflow-copy'),
      normalizedEntryId.replace('dist/esm', 'dist/umd'),
      normalizedEntryId.replace('index.js', 'components/index.js'),
    ];
    for (const id of unrelated) {
      expect(filter.test(id)).toBe(false);
      expect(invoke(entries[0].source, id)).toBeNull();
    }
    expect(() => invoke('unexpected dependency source', entries[0].id)).toThrow('原生几何函数导入结构');
  });
});
