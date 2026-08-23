/** MCP 专用的界面、窗口、画布视口与截图工具。 */
import { useAppStore } from '../../../store/useAppStore';
import type { SettingsTab } from '../../../store/store.ui';
import {
  getCanvasViewportController,
} from '../../canvasViewportService';
import {
  captureAppWindow,
  focusAppWindow,
  getAppWindowState,
  listAppWindows,
  setAppWindowBounds,
  type AppWindowLabel,
  type CapturableWindowLabel,
} from '../../mcp/mcpUiRuntimeService';
import { registerAgentTool, type AgentToolExecutionResult } from '../toolRegistry';

const MCP_PREFIX = 'mcp-control-';
const WINDOW_LABELS = ['main', 'chat-assistant', 'asset-search', 'video-editor', 'director-desk', 'comfyui'];
const CAPTURE_LABELS = ['main', 'chat-assistant', 'asset-search', 'video-editor'];
const SETTINGS_TABS: SettingsTab[] = ['general', 'files', 'api', 'shortcuts', 'comfyui', 'storage', 'plugins', 'mcp'];
const PANELS = ['none', 'settings', 'assets', 'characters', 'history', 'drama', 'workflow', 'chat'];

function mcpOnly(context: { conversationId: string }): boolean {
  return context.conversationId.startsWith(MCP_PREFIX);
}

function authorizeCurrentProject(context: { projectId: string; conversationId: string }) {
  return {
    allowed: mcpOnly(context) && useAppStore.getState().currentProjectId === context.projectId,
    reason: '界面控制只允许当前项目的 MCP 控制会话调用',
  };
}

function failure(error: unknown, code: string): AgentToolExecutionResult {
  const message = error instanceof Error ? error.message : '界面操作失败';
  return { status: 'error', summary: message, modelContent: message, errorCode: code };
}

function getLayout() {
  const store = useAppStore.getState();
  return {
    projectId: store.currentProjectId,
    projectLoadStatus: store.projectLoadStatus,
    panels: {
      settings: store.settingsOpen,
      assets: store.assetsPanelOpen,
      characters: store.characterLibraryOpen,
      history: store.historyPanelOpen,
      drama: store.dramaAssetsPanelOpen,
      workflow: store.workflowPanelOpen,
      chat: store.chatOpen,
      chatDetached: store.chatPanelDetached,
      projectLibrary: store.projectLibraryOpen,
    },
    menus: {
      nodeMenu: store.nodeMenuVisible,
      nodePicker: store.nodePickerOpen,
      avatarMenu: store.avatarMenuOpen,
    },
    settingsTab: store.settingsOpen ? store.settingsInitialTab : null,
    activeNodeId: store.activeNodeId,
    nodeDialogPosition: store.dialogPosition,
    minimapVisible: store.minimapVisible,
  };
}

function closePrimaryPanels(): void {
  const store = useAppStore.getState();
  store.setSettingsOpen(false);
  store.setAssetsPanelOpen(false);
  store.setCharacterLibraryOpen(false);
  store.setHistoryPanelOpen(false);
  store.setDramaAssetsPanelOpen(false);
  store.setWorkflowPanelOpen(false);
  store.closeChat();
}

interface SetLayoutInput {
  panel?: typeof PANELS[number];
  settingsTab?: SettingsTab;
  minimapVisible?: boolean;
  activeNodeId?: string;
  closeNodeDialog?: boolean;
}

export function registerUiControlAgentTools(): Array<() => void> {
  const common = { isAvailable: mcpOnly, authorize: authorizeCurrentProject };
  return [
    registerAgentTool<Record<string, never>>({
      id: 'ui_get_layout',
      title: '读取当前界面布局',
      description: '读取 AI Canvas 当前面板、菜单、弹窗、活动节点和聊天停靠状态，不返回凭据输入或本地路径。',
      effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      ...common,
      execute: async () => {
        const layout = getLayout();
        return { status: 'success', summary: '已读取当前界面布局', modelContent: JSON.stringify(layout) };
      },
    }),
    registerAgentTool<Record<string, never>>({
      id: 'ui_get_interaction_state',
      title: '读取界面交互状态',
      description: '读取项目切换、生成任务、模态面板和当前请求等是否阻塞界面。',
      effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      ...common,
      execute: async () => {
        const store = useAppStore.getState();
        const activeTasks = store.agentTasks.filter((task) => !['completed', 'failed', 'stopped'].includes(task.status));
        const state = {
          busy: store.projectLoadStatus !== 'ready' || !!store.switchingProjectName || !!store.activeRequestAbort,
          projectLoadStatus: store.projectLoadStatus,
          switchingProject: !!store.switchingProjectName,
          activeRequest: !!store.activeRequestAbort,
          activeTaskCount: activeTasks.length,
          modal: store.settingsOpen || store.projectLibraryOpen || !!store.activeNodeId || !!store.reversePromptRequest,
        };
        return { status: 'success', summary: '已读取当前交互状态', modelContent: JSON.stringify(state) };
      },
    }),
    registerAgentTool<SetLayoutInput>({
      id: 'ui_set_layout',
      title: '调整当前界面布局',
      description: '打开指定应用面板、切换设置页签、控制小地图或打开节点编辑器。',
      effect: 'config_write',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          panel: { type: 'string', enum: PANELS },
          settingsTab: { type: 'string', enum: SETTINGS_TABS },
          minimapVisible: { type: 'boolean' },
          activeNodeId: { type: 'string', minLength: 1, maxLength: 160 },
          closeNodeDialog: { type: 'boolean' },
        },
      },
      ...common,
      execute: async (_context, input) => {
        const store = useAppStore.getState();
        if (input.panel !== undefined) {
          closePrimaryPanels();
          const current = useAppStore.getState();
          if (input.panel === 'settings') current.setSettingsOpen(true, input.settingsTab);
          if (input.panel === 'assets') current.setAssetsPanelOpen(true);
          if (input.panel === 'characters') current.setCharacterLibraryOpen(true);
          if (input.panel === 'history') current.setHistoryPanelOpen(true);
          if (input.panel === 'drama') current.setDramaAssetsPanelOpen(true);
          if (input.panel === 'workflow') current.setWorkflowPanelOpen(true);
          if (input.panel === 'chat') current.openChat();
        } else if (input.settingsTab && store.settingsOpen) {
          store.setSettingsInitialTab(input.settingsTab);
        }
        if (input.minimapVisible !== undefined && useAppStore.getState().minimapVisible !== input.minimapVisible) {
          useAppStore.getState().toggleMinimap();
        }
        if (input.closeNodeDialog) useAppStore.getState().closeNodeDialog();
        if (input.activeNodeId) {
          const exists = useAppStore.getState().nodes.some((node) => node.id === input.activeNodeId);
          if (!exists) return failure(new Error('未找到要打开的节点'), 'UI_NODE_NOT_FOUND');
          useAppStore.getState().openNodeDialog(input.activeNodeId);
        }
        return { status: 'success', summary: '已调整当前界面布局', modelContent: JSON.stringify(getLayout()) };
      },
    }),
    registerAgentTool<Record<string, never>>({
      id: 'window_list', title: '列出应用窗口', description: '列出当前打开的 AI Canvas 自有窗口及其尺寸和显示状态。', effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, ...common,
      execute: async () => {
        try {
          const windows = await listAppWindows();
          return { status: 'success', summary: `已读取 ${windows.length} 个应用窗口`, modelContent: JSON.stringify({ windows }) };
        } catch (error) { return failure(error, 'UI_WINDOW_LIST_FAILED'); }
      },
    }),
    registerAgentTool<{ label: AppWindowLabel }>({
      id: 'window_get_state', title: '读取窗口状态', description: '读取一个固定 AI Canvas 窗口的位置、尺寸、焦点和显示状态。', effect: 'read',
      inputSchema: { type: 'object', required: ['label'], additionalProperties: false, properties: { label: { type: 'string', enum: WINDOW_LABELS } } }, ...common,
      execute: async (_context, input) => {
        try { const state = await getAppWindowState(input.label); return { status: 'success', summary: `已读取窗口 ${input.label}`, modelContent: JSON.stringify(state) }; }
        catch (error) { return failure(error, 'UI_WINDOW_NOT_FOUND'); }
      },
    }),
    registerAgentTool<{ label: AppWindowLabel }>({
      id: 'window_focus', title: '聚焦应用窗口', description: '恢复并聚焦一个已打开的 AI Canvas 自有窗口。', effect: 'config_write',
      inputSchema: { type: 'object', required: ['label'], additionalProperties: false, properties: { label: { type: 'string', enum: WINDOW_LABELS } } }, ...common,
      execute: async (_context, input) => {
        try { await focusAppWindow(input.label); return { status: 'success', summary: `已聚焦窗口 ${input.label}`, modelContent: JSON.stringify({ label: input.label }) }; }
        catch (error) { return failure(error, 'UI_WINDOW_FOCUS_FAILED'); }
      },
    }),
    registerAgentTool<{ label: AppWindowLabel; x?: number; y?: number; width?: number; height?: number }>({
      id: 'window_set_bounds', title: '调整应用窗口', description: '移动或调整一个 AI Canvas 自有窗口；位置和尺寸必须成对提供。', effect: 'config_write',
      inputSchema: { type: 'object', required: ['label'], additionalProperties: false, properties: {
        label: { type: 'string', enum: WINDOW_LABELS }, x: { type: 'integer', minimum: -10000, maximum: 10000 }, y: { type: 'integer', minimum: -10000, maximum: 10000 },
        width: { type: 'integer', minimum: 320, maximum: 7680 }, height: { type: 'integer', minimum: 240, maximum: 4320 },
      } }, ...common,
      execute: async (_context, input) => {
        if ((input.x === undefined) !== (input.y === undefined) || (input.width === undefined) !== (input.height === undefined)) {
          return failure(new Error('窗口位置 x/y 和尺寸 width/height 必须分别成对提供'), 'UI_WINDOW_BOUNDS_INVALID');
        }
        try { await setAppWindowBounds(input.label, input); return { status: 'success', summary: `已调整窗口 ${input.label}`, modelContent: JSON.stringify(await getAppWindowState(input.label)) }; }
        catch (error) { return failure(error, 'UI_WINDOW_BOUNDS_FAILED'); }
      },
    }),
    registerAgentTool<Record<string, never>>({
      id: 'canvas_get_viewport', title: '读取画布视口', description: '读取画布当前平移、缩放与可见画布范围。', effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, ...common,
      execute: async () => {
        const controller = getCanvasViewportController();
        if (!controller) return failure(new Error('画布视口尚未挂载'), 'CANVAS_VIEWPORT_UNAVAILABLE');
        return { status: 'success', summary: '已读取画布视口', modelContent: JSON.stringify(controller.getSnapshot()) };
      },
    }),
    registerAgentTool<{ x: number; y: number; zoom: number; duration?: number }>({
      id: 'canvas_set_viewport', title: '设置画布视口', description: '设置画布平移坐标和缩放比例。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['x', 'y', 'zoom'], additionalProperties: false, properties: {
        x: { type: 'number', minimum: -100000, maximum: 100000 }, y: { type: 'number', minimum: -100000, maximum: 100000 }, zoom: { type: 'number', minimum: 0.1, maximum: 5 }, duration: { type: 'integer', minimum: 0, maximum: 3000 },
      } }, ...common,
      execute: async (_context, input) => {
        const controller = getCanvasViewportController();
        if (!controller) return failure(new Error('画布视口尚未挂载'), 'CANVAS_VIEWPORT_UNAVAILABLE');
        await controller.setViewport({ x: input.x, y: input.y, zoom: input.zoom }, input.duration);
        return { status: 'success', summary: '已设置画布视口', modelContent: JSON.stringify(controller.getSnapshot()) };
      },
    }),
    registerAgentTool<{ nodeIds?: string[]; padding?: number; duration?: number }>({
      id: 'canvas_fit_view', title: '适配画布视图', description: '适配全部画布内容，或聚焦指定节点集合。', effect: 'canvas_write',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        nodeIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 160 } }, padding: { type: 'number', minimum: 0, maximum: 2 }, duration: { type: 'integer', minimum: 0, maximum: 3000 },
      } }, ...common,
      execute: async (_context, input) => {
        const controller = getCanvasViewportController();
        if (!controller) return failure(new Error('画布视口尚未挂载'), 'CANVAS_VIEWPORT_UNAVAILABLE');
        const known = new Set(useAppStore.getState().nodes.map((node) => node.id));
        if (input.nodeIds?.some((id) => !known.has(id))) return failure(new Error('聚焦列表包含不存在的节点'), 'CANVAS_NODE_NOT_FOUND');
        await controller.fitView(input);
        return { status: 'success', summary: '已适配画布视图', modelContent: JSON.stringify(controller.getSnapshot()) };
      },
    }),
    registerAgentTool<{ target: CapturableWindowLabel; maxWidth?: number; quality?: number; redactSensitive?: boolean }>({
      id: 'ui_capture_window', title: '截取应用窗口', description: '截取指定 AI Canvas Webview 的当前可见内容并直接返回瞬时 MCP 图像；不落盘。', effect: 'read',
      inputSchema: { type: 'object', required: ['target'], additionalProperties: false, properties: {
        target: { type: 'string', enum: CAPTURE_LABELS }, maxWidth: { type: 'integer', minimum: 320, maximum: 1920 }, quality: { type: 'number', minimum: 0.4, maximum: 0.92 }, redactSensitive: { type: 'boolean' },
      } }, ...common,
      resolveInput: (input) => ({ ...input, maxWidth: input.maxWidth ?? 1280, quality: input.quality ?? 0.75, redactSensitive: input.redactSensitive ?? true }),
      execute: async (_context, input) => {
        try {
          const capture = await captureAppWindow({ target: input.target, maxWidth: input.maxWidth ?? 1280, quality: input.quality ?? 0.75, redactSensitive: input.redactSensitive ?? true });
          return {
            status: 'success', summary: `已截取窗口 ${input.target}`, modelContent: JSON.stringify({ target: input.target, width: capture.width, height: capture.height, mimeType: capture.mimeType }),
            mcpContent: [{ type: 'image', data: capture.data, mimeType: capture.mimeType }],
          };
        } catch (error) { return failure(error, 'UI_CAPTURE_FAILED'); }
      },
    }),
  ];
}
