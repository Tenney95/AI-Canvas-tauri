/**
 * aiAppTools — 向 Agent 工具注册表注册 AI 应用节点能力。
 */
import { useAppStore } from '../../../store/useAppStore';
import type { AiAppJson } from '../../../types/aiApp';
import { registerAgentTool, type AgentToolContext, type AgentToolExecutionResult } from '../toolRegistry';
import type { AgentToolSchema } from '../agentToolSchemas';
import { assertAiAppContext, createAiAppNode, describeAiApp, getAiAppNode, loadAiAppDefinition, saveAiAppState, updateAiAppNode } from '../../aiApps/aiAppService';
import { normalizeAiAppJson } from '../../aiApps/aiAppSchema';

const idSchema: AgentToolSchema = { type: 'string', minLength: 1, maxLength: 200 };
const definitionSchema: AgentToolSchema = {
  type: 'object', required: ['version', 'title', 'code', 'actions'], additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1] }, title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 2000 }, html: { type: 'string', maxLength: 64 * 1024 },
    css: { type: 'string', maxLength: 32 * 1024 }, code: { type: 'string', minLength: 1, maxLength: 64 * 1024 },
    actions: { type: 'array', minItems: 1, maxItems: 12, items: {
      type: 'object', required: ['id', 'title'], additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 64 }, title: { type: 'string', minLength: 1, maxLength: 80 },
        description: { type: 'string', maxLength: 1000 },
        inputSchema: { type: 'object', additionalProperties: true, description: '本地 JSON Schema 子集，根类型必须为 object；支持 properties/required/enum/长度与数量限制，禁止可执行表达式。' },
      },
    } },
  },
};
const inputsSchema: AgentToolSchema = { type: 'array', maxItems: 50, items: idSchema,
  description: '显式授权应用读取的当前项目节点 ID；先 canvas_query 定位，最多 50 个，不接受分组或应用自身。' };
const objectSchema = (properties: Record<string, AgentToolSchema>, required: string[] = []): AgentToolSchema => (
  { type: 'object', properties, required, additionalProperties: false }
);
const authorize = (context: Omit<AgentToolContext, 'signal'>) => ({
  allowed: !!context.projectId && useAppStore.getState().currentProjectId === context.projectId,
  reason: '目标项目当前未加载',
});

async function execute(summary: string, context: AgentToolContext, operation: () => Promise<unknown> | unknown): Promise<AgentToolExecutionResult> {
  try {
    assertAiAppContext(context);
    const value = await operation();
    return { status: 'success', summary, modelContent: JSON.stringify(value), retryable: false };
  } catch {
    // 源码、用户状态和文件正文不进入任务摘要；修复时可重新查询应用合同。
    return { status: 'error', summary: `${summary}失败：定义、参数或当前上下文无效，请核对应用与绑定素材后重试`,
      modelContent: 'AI_APP_OPERATION_FAILED：请核对应用 SDK、动作参数、绑定素材与当前项目；源码初始化或校验失败时保留旧版本。',
      errorCode: 'AI_APP_OPERATION_FAILED', retryable: false };
  }
}

const sdk = {
  version: 1,
  runtime: 'HTML/CSS + 隔离 Worker JavaScript；无 import、npm、DOM、网络、文件路径、Store 或 Tauri IPC。界面通过 app.ui 控制。',
  limits: { definitionBytes: 128 * 1024, jsonBytes: 64 * 1024, inputs: 50, actions: 12, imageBytes: 2 * 1024 * 1024, actionMs: 10_000 },
  api: {
    registerAction: 'app.registerAction(id, async (input, app) => JSON结果)，必须同步注册全部声明动作；注册后可异步准备界面。',
    runAction: 'await app.runAction(id, input)，界面事件 return 结果即可显示到宿主结果摘要。',
    inputs: 'app.inputs / app.resources.list() 返回绑定节点快照：nodeId/label/type/status/text/truncated/hasImage/hasVideo/hasAudio；text最多2000字符。',
    readImage: 'await app.resources.readImage(nodeId)，只读取绑定节点已保存到当前项目的 PNG/JPEG/GIF/WebP，最大2MiB；返回临时dataURL。',
    state: 'app.state.get() / app.state.set(JSON)，只修改本次会话临时状态；用户点宿主保存按钮或 canvas_app_save_state 才持久化。',
    ui: 'app.ui.render(html)、app.ui.setCss(css)、app.ui.on("click"|"input"|"change"|"submit", elementId, async (event, app)=>result)。事件含value/checked，submit另含values。HTML/CSS会清理；无inline事件/外部资源/页面跳转。',
    image: '先 render 含 <img id="preview" alt="预览"> 的界面，再 app.ui.setImage("preview", await app.resources.readImage(nodeId))；大图不嵌入 HTML 字符串，避免占用 64KiB HTML 额度。',
    theme: '使用 var(--canvas-bg)、--canvas-surface、--canvas-card、--canvas-border、--canvas-text、--canvas-text-secondary、--canvas-text-muted。宿主同步深浅主题。',
  },
  example: {
    definition: { version: 1, title: '素材筛选器', description: '按名称筛选已绑定的素材',
      html: '<label>名称筛选 <input id="query" placeholder="输入关键词"></label><button id="filterButton" type="button">筛选</button>',
      css: 'body{background:var(--canvas-bg);color:var(--canvas-text);font:14px system-ui;padding:12px}input,button{padding:8px}',
      actions: [{ id: 'filter', title: '筛选', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 120 } }, additionalProperties: false } }],
      code: [
        'app.registerAction("filter", async (input, app) => ({items: app.resources.list().filter(item => item.label.includes(input.query || app.state.get().query || ""))}));',
        'app.ui.on("input", "query", event => { app.state.set({query: event.value}); });',
        'app.ui.on("click", "filterButton", async () => app.runAction("filter", {query: app.state.get().query || ""}));',
      ].join('\n'),
    },
    create: 'canvas_app_create({definition, inputNodeIds:[真实节点ID], initialStateJson:"{}"})；内部Agent/MCP均可调用。',
    run: 'canvas_app_run({nodeId:应用节点ID, actionId:"filter", input:{query:"角色"}})；不打开界面也可运行，结果不会自动保存。',
  },
};

export function registerAiAppAgentTools(): Array<() => void> {
  return [
    registerAgentTool({
      id: 'canvas_app_get_sdk', title: '读取 AI 应用 SDK', effect: 'read', inputSchema: objectSchema({}), authorize,
      description: '创建或修改仅由 Agent/MCP 创建的 AI 应用节点前，读取自由 HTML/CSS/JavaScript 合同和示例。生成代码在可终止 Worker 中执行，通过 app.ui 事件与渲染桥操作界面，只能读取绑定素材，不能直接访问 DOM/网络/Store。',
      summarizeInput: () => '读取 AI 应用的 SDK 与额度',
      execute: (context) => execute('读取 AI 应用 SDK', context, () => sdk),
    }),
    registerAgentTool<{ definition: unknown; inputNodeIds?: string[]; initialStateJson?: string; x?: number; y?: number }>({
      id: 'canvas_app_create', title: '创建 AI 应用节点', effect: 'canvas_write', authorize,
      description: '在当前画布创建仅 Agent/MCP 可创建的 AI 应用；先 canvas_app_get_sdk。提交 HTML/CSS、Worker JS、动作目录与明确的输入节点 ID。宿主先隔离初始化校验，再保存不可变定义并一次加入历史；不调用付费模型、不运行声明动作。用户不能从菜单或复制创建此类型。',
      inputSchema: objectSchema({ definition: definitionSchema, inputNodeIds: inputsSchema,
        initialStateJson: { type: 'string', maxLength: 64 * 1024, description: '初始状态的 JSON 文本，默认 {}。不得包含密钥、绝对路径或运行对象。' },
        x: { type: 'number', minimum: -1_000_000, maximum: 1_000_000 }, y: { type: 'number', minimum: -1_000_000, maximum: 1_000_000 },
      }, ['definition']),
      summarizeInput: () => '创建 AI 应用并保存定义快照',
      execute: (context, input) => execute('创建 AI 应用', context, async () => {
        const nodeId = await createAiAppNode({ definition: input.definition, inputNodeIds: input.inputNodeIds,
          state: input.initialStateJson === undefined ? {} : JSON.parse(input.initialStateJson),
          position: { x: input.x ?? 300, y: input.y ?? 300 } }, context);
        return describeAiApp(nodeId);
      }),
    }),
    registerAgentTool<{ nodeId: string; includeDefinition?: boolean }>({
      id: 'canvas_app_get', title: '读取 AI 应用', effect: 'read', authorize,
      description: '读取 AI 应用动作目录、参数 schema、绑定素材和已保存状态/结果；includeDefinition=true 时读取校验后的应用自有源码供修改。不会返回本地绝对路径或临时资源授权。',
      inputSchema: objectSchema({ nodeId: idSchema, includeDefinition: { type: 'boolean' } }, ['nodeId']),
      summarizeInput: () => '读取 AI 应用合同与已保存结果',
      execute: (context, input) => execute('读取 AI 应用', context, async () => {
        const { app } = getAiAppNode(input.nodeId, context.projectId);
        const definition = input.includeDefinition ? await loadAiAppDefinition(context.projectId, app) : undefined;
        assertAiAppContext(context);
        if (getAiAppNode(input.nodeId, context.projectId).app.revision !== app.revision) throw new Error('应用已变化');
        return { ...describeAiApp(input.nodeId), ...(definition ? { definition } : {}) };
      }),
    }),
    registerAgentTool<{ nodeId: string; expectedRevision: number; definition?: unknown; inputNodeIds?: string[] }>({
      id: 'canvas_app_update', title: '更新 AI 应用', effect: 'canvas_write', authorize,
      description: '按读取到的 expectedRevision 更新应用定义或绑定素材。新代码初始化/落盘校验失败保留旧版；成功撤销旧会话与在途结果，保留已保存状态和结果。首版不自动迁移不兼容状态。',
      inputSchema: objectSchema({ nodeId: idSchema, expectedRevision: { type: 'integer', minimum: 1 }, definition: definitionSchema, inputNodeIds: inputsSchema }, ['nodeId', 'expectedRevision']),
      summarizeInput: () => '更新 AI 应用定义或素材绑定',
      execute: (context, input) => execute('更新 AI 应用', context, async () => {
        if (getAiAppNode(input.nodeId, context.projectId).app.revision !== input.expectedRevision) throw new Error('应用版本已变化');
        if (input.definition === undefined && input.inputNodeIds === undefined) throw new Error('没有更新字段');
        await updateAiAppNode(input.nodeId, input, context);
        return describeAiApp(input.nodeId);
      }),
    }),
    registerAgentTool<{ nodeId: string; actionId: string; input?: Record<string, AiAppJson> }>({
      id: 'canvas_app_run', title: '运行 AI 应用只读动作', effect: 'read', authorize,
      description: '在隐藏隔离环境执行应用已声明的只读动作，与节点界面使用同一实现。参数遵循 canvas_app_get 返回的动作 inputSchema。只能读取绑定素材和计算有界 JSON；不写画布、不保存状态/结果、不调用模型、不执行文件或网络操作。保存结果另用 canvas_app_save_state。动作最多10秒，不自动重试。',
      inputSchema: objectSchema({ nodeId: idSchema, actionId: { type: 'string', minLength: 1, maxLength: 64 }, input: { type: 'object', additionalProperties: true } }, ['nodeId', 'actionId']),
      summarizeInput: () => '执行 AI 应用的只读动作',
      execute: (context, input) => execute('执行 AI 应用只读动作', context, async () => {
        const actionInput = normalizeAiAppJson(input.input ?? {});
        const { runAiAppAction } = await import('../../aiApps/aiAppRuntime');
        assertAiAppContext(context);
        return runAiAppAction(input.nodeId, input.actionId, actionInput, context);
      }),
    }),
    registerAgentTool<{ nodeId: string; expectedRevision: number; stateJson: string; resultJson?: string }>({
      id: 'canvas_app_save_state', title: '保存 AI 应用状态与结果', effect: 'canvas_write', authorize,
      description: '明确保存应用自身的 JSON 状态与结果，纳入一次画布历史；不会操作其他节点或保存文件正文。stateJson/resultJson 是 JSON 文本，各最多64KiB。先读取当前 expectedRevision，过期版本拒绝写回。',
      inputSchema: objectSchema({ nodeId: idSchema, expectedRevision: { type: 'integer', minimum: 1 },
        stateJson: { type: 'string', minLength: 1, maxLength: 64 * 1024 }, resultJson: { type: 'string', minLength: 1, maxLength: 64 * 1024 },
      }, ['nodeId', 'expectedRevision', 'stateJson']),
      summarizeInput: () => '保存 AI 应用的状态与结果',
      execute: (context, input) => execute('保存 AI 应用', context, () => {
        saveAiAppState(input.nodeId, JSON.parse(input.stateJson), input.resultJson === undefined ? undefined : JSON.parse(input.resultJson), input.expectedRevision, context);
        return describeAiApp(input.nodeId);
      }),
    }),
  ];
}
