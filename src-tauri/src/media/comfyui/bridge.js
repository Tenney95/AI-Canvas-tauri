/**
 * bridge — 连接 ComfyUI 嵌入页面与宿主管理界面。
 */
(() => {
  // 来源由原生注入闭包提供，不能由远程页面自行指定；子 frame 不创建宿主桥接。
  if (typeof aiCanvasComfyOrigin !== 'string'
    || window.location.origin !== aiCanvasComfyOrigin || window.top !== window) return;
  if (window.__AI_CANVAS_COMFY__) return;

  const COMFY_MENU_DOCKED_KEY = 'Comfy.MenuPosition.Docked';
  const isMacOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  // 绑定真实标签对象，不能用文件名或最后一次打开的上下文推断保存目标。
  const workflowContexts = new WeakMap();
  // 非枚举标记只跟随同一标签对象（含响应式包装），不会进入导出 JSON 或同名新标签。
  const workflowTabIdentity = Symbol('ai-canvas-workflow-tab');
  const workflowIdentityFor = (tab) => tab?.[workflowTabIdentity] || tab;
  const bindWorkflowContext = (tab, context) => {
    if (!tab[workflowTabIdentity]) {
      try {
        Object.defineProperty(tab, workflowTabIdentity, { value: Object.freeze({}) });
      } catch {
        // 不可扩展的旧版标签仍按原对象绑定，无法确认时拒绝普通保存。
      }
    }
    workflowContexts.set(workflowIdentityFor(tab), context);
  };
  let pendingSaveSource = null;
  let preparingSave = false;
  let loadingWorkflow = false;
  let pendingSavePayload = null;
  let pendingSaveTimeout = null;
  let pendingSaveTimedOut = false;
  let nativeDockingPreferenceRestored = false;

  const nativeDockingPreference = (() => {
    try {
      const value = window.localStorage.getItem(COMFY_MENU_DOCKED_KEY);
      window.localStorage.setItem(COMFY_MENU_DOCKED_KEY, 'true');
      return value;
    } catch {
      return null;
    }
  })();

  const getComfyApp = () => window.app || window.comfyAPI?.app?.app;

  // 宿主动作（拖窗口 / 最小化 / 保存…）靠一次导航传递，宿主会在 on_navigation 里拦下，
  // 页面并不会真的跳走；但浏览器仍会先跑 beforeunload，工作流有改动时 ComfyUI 就弹
  // 「是否离开网站」。这段时间内把该事件掐掉，真正的关闭由 Tauri 处理，不经过它。
  const HOST_ACTION_UNLOAD_GRACE_MS = 2000;
  let hostActionAt = 0;
  window.addEventListener('beforeunload', (event) => {
    if (Date.now() - hostActionAt > HOST_ACTION_UNLOAD_GRACE_MS) return;
    // 本脚本在文档最开始注入，注册顺序早于 ComfyUI 自己的监听，掐断后它没机会设 returnValue
    event.stopImmediatePropagation();
  }, true);

  const requestHostAction = (action) => {
    const url = new URL('/__ai_canvas_comfy_action__', window.location.origin);
    url.searchParams.set('action', action);
    hostActionAt = Date.now();
    window.location.assign(url.href);
  };

  const waitForComfyApp = async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const app = getComfyApp();
      // window.app/graph 就绪时前端仍可能在恢复历史标签；spinner 由该恢复流程控制。
      if (app?.isGraphReady && app.canvas && app.vueAppReady !== false
        && !app.configuringGraph && app.extensionManager?.spinner !== true
        && typeof app.graphToPrompt === 'function') return app;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('等待 ComfyUI 画布初始化超时');
  };

  const showToast = (app, severity, summary, detail) => {
    app?.extensionManager?.toast?.add?.({ severity, summary, detail, life: 2800 });
  };

  const inferCategory = (output) => {
    const entries = Object.entries(output || {});
    // 被别人当输入引用过的都是中间节点，剩下的才是产出节点；分类只看产出，
    // 否则图生视频里的一个音频/提示词增强节点就能把整条工作流带偏
    const referenced = new Set();
    for (const [, node] of entries) {
      for (const value of Object.values(node?.inputs || {})) {
        if (Array.isArray(value) && typeof value[0] === 'string') referenced.add(value[0]);
      }
    }
    const terminal = entries.filter(([nodeId]) => !referenced.has(nodeId));
    const classTypes = (terminal.length > 0 ? terminal : entries)
      .map(([, node]) => String(node?.class_type || ''))
      .join(' ');
    // 视频优先：有声视频的产出节点同时带 audio 字样，但它仍然是视频工作流
    if (/video|vhs|animated|webm|mp4/i.test(classTypes)) return 'ai-video';
    if (/audio|sound/i.test(classTypes)) return 'ai-audio';
    if (/image|latent|sampler|vae|save|preview/i.test(classTypes)) return 'ai-image';
    return 'ai-text';
  };

  const sanitizeFileName = (name) => {
    const base = String(name || 'comfyui-workflow')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '_')
      .replace(/\.json$/i, '');
    return `${base || 'comfyui-workflow'}.json`;
  };

  /** 从 ComfyUI 工作流对象取标签名，去掉路径、扩展名和重名后缀。 */
  const workflowBaseName = (value) => String(value || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.json$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim();

  const workflowItemName = (workflow) => workflowBaseName(
    typeof workflow === 'string'
      ? workflow
      : workflow?.filename ?? workflow?.path ?? workflow?.key ?? workflow?.name ?? workflow?.displayName,
  );

  const createWorkflowId = () => {
    const value = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `wf-${value}`;
  };

  const createSaveRequestId = () => {
    const value = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `save-${value}`;
  };

  const activeWorkflowFor = (app) => {
    const store = getWorkflowStore(app);
    const candidate = store?.activeWorkflow;
    // 空 Ref 表示尚无标签，不能把 Ref 容器本身当成标签绑定。
    const active = candidate && typeof candidate === 'object' && 'value' in candidate
      ? candidate.value : candidate;
    return active && typeof active === 'object' ? active : null;
  };

  const requestWorkflowName = async (app, activeWorkflow, context) => {
    if (context?.name) return context.name;
    const currentWorkflowName = workflowItemName(activeWorkflow);
    const defaultName = currentWorkflowName || `ComfyUI-工作流-${new Date().toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).replace(/\//g, '-')}`;
    const value = await app.extensionManager?.dialog?.prompt?.({
      title: '保存工作流到 AI Canvas',
      message: '为当前工作流命名，便于在画布中查找和管理',
      defaultValue: defaultName,
      placeholder: '例如：角色立绘生成、场景概念图',
    });
    return typeof value === 'string' ? value.trim() : '';
  };

  // 在进入待确认状态前执行 TS/Rust 的共同限制，确定坏载荷可直接修正重存。
  const validatePreparedSave = (payload) => {
    const byteLength = (value) => new TextEncoder().encode(value).byteLength;
    if (!/^save-[A-Za-z0-9._:-]{1,120}$/.test(payload.requestId)
      || !/^(wf|builtin|workflow-mcp)-[A-Za-z0-9._:-]{1,160}$/.test(payload.workflowId)) {
      throw new Error('工作流保存标识无效，请从画布重新打开编辑');
    }
    if (payload.saveMode !== 'update' && payload.saveMode !== 'create') throw new Error('工作流保存方式无效');
    if (!payload.name || payload.name.length > 120 || byteLength(payload.name) > 512) {
      throw new Error('工作流名称过长或为空，请将名称缩短至 120 字符以内后另存');
    }
    if (!payload.fileName || byteLength(payload.fileName) > 512) {
      throw new Error('工作流文件名过长，请使用较短名称另存');
    }
    if (!['ai-text', 'ai-image', 'ai-video', 'ai-audio'].includes(payload.category)) throw new Error('工作流分类无效');
    for (const content of [payload.fileContent, payload.editableContent]) {
      if (typeof content !== 'string' || !content || byteLength(content) > 16 * 1024 * 1024) {
        throw new Error('工作流内容无效或超过 16 MiB，请缩减后重新保存');
      }
    }
  };

  const sendPendingSave = () => {
    const payload = pendingSavePayload;
    if (!payload) return;
    pendingSaveTimedOut = false;
    window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__ = payload;
    if (pendingSaveTimeout !== null) window.clearTimeout(pendingSaveTimeout);
    pendingSaveTimeout = window.setTimeout(() => {
      if (pendingSavePayload?.requestId !== payload.requestId) return;
      pendingSaveTimeout = null;
      pendingSaveTimedOut = true;
      showToast(
        getComfyApp(), 'warn', '保存结果待确认',
        'AI Canvas 未及时返回结果；再次点击保存将核对原请求，不会创建新副本',
      );
    }, 30_000);
    requestHostAction('save');
  };

  const saveToAICanvas = async (asNew = false) => {
    let app;
    if ((pendingSavePayload && !pendingSaveTimedOut) || preparingSave || loadingWorkflow) {
      showToast(getComfyApp(), 'info', '正在处理工作流', '请等待当前打开或保存操作完成');
      return;
    }
    const retryRequest = pendingSavePayload;
    preparingSave = true;
    try {
      app = await waitForComfyApp();
      if (retryRequest) {
        // 等待前端就绪时旧请求可能刚好确认；不能因此开始一次新的另存。
        if (pendingSavePayload?.requestId !== retryRequest.requestId) return;
        showToast(app, 'info', '正在核对上次保存', '本次只核对原请求；确认后可再次保存当前修改');
        sendPendingSave();
        return;
      }
      const source = activeWorkflowFor(app);
      if (!source) throw new Error('无法确认当前 ComfyUI 标签，请从画布重新打开编辑');
      const sourceIdentity = workflowIdentityFor(source);
      const context = !asNew ? workflowContexts.get(sourceIdentity) : null;
      if (!asNew && !context?.workflowId) {
        throw new Error('当前标签未关联 AI Canvas 工作流，请从画布重新打开编辑；需要创建副本时使用“另存到 AI Canvas”');
      }
      const assertSameSource = () => {
        if (workflowIdentityFor(activeWorkflowFor(app)) !== sourceIdentity) throw new Error('保存期间切换了工作流，请在目标标签页重新保存');
      };
      const name = (await requestWorkflowName(app, source, context)).trim();
      if (!name) return;
      assertSameSource();
      const { workflow, output } = await app.graphToPrompt();
      assertSameSource();
      const payload = {
        requestId: createSaveRequestId(),
        workflowId: context?.workflowId || createWorkflowId(),
        saveMode: asNew ? 'create' : 'update',
        name,
        category: context?.category || inferCategory(output),
        fileName: context?.fileName || sanitizeFileName(name),
        fileContent: JSON.stringify(output, null, 2),
        editableContent: JSON.stringify(workflow, null, 2),
      };
      validatePreparedSave(payload);
      pendingSavePayload = payload;
      pendingSaveSource = source;
      sendPendingSave();
    } catch (error) {
      if (pendingSaveTimeout !== null) window.clearTimeout(pendingSaveTimeout);
      pendingSaveTimeout = null;
      // 导航交接失败也可能已经到达宿主，保留原请求以便幂等核对。
      pendingSaveTimedOut = !!pendingSavePayload;
      showToast(app || getComfyApp(), 'error', '保存失败', String(error?.message || error));
    } finally {
      preparingSave = false;
    }
  };

  const completeSave = (requestId, success, detail) => {
    if (!pendingSavePayload) return;
    // 无 ID 的读取/解析失败也可能来自旧导航，不能结束当前合法保存。
    if (!requestId || pendingSavePayload.requestId !== requestId) return;
    if (pendingSaveTimeout !== null) window.clearTimeout(pendingSaveTimeout);
    pendingSaveTimeout = null;
    if (success && pendingSaveSource) {
      const { workflowId, name, category, fileName } = pendingSavePayload;
      for (const [id, tab] of loadedWorkflowTabs) {
        if (workflowIdentityFor(tab) === workflowIdentityFor(pendingSaveSource)) loadedWorkflowTabs.delete(id);
      }
      bindWorkflowContext(pendingSaveSource, { workflowId, name, category, fileName });
      loadedWorkflowTabs.set(workflowId, pendingSaveSource);
    }
    pendingSavePayload = null;
    pendingSaveSource = null;
    pendingSaveTimedOut = false;
    delete window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__;
    showToast(
      getComfyApp(),
      success ? 'success' : 'error',
      success ? '已保存到 AI Canvas' : '保存失败',
      String(detail || ''),
    );
  };

  const installSaveAction = async () => {
    const app = await waitForComfyApp();
    if (window.__AI_CANVAS_COMFY_SAVE_ACTION__) return;
    window.__AI_CANVAS_COMFY_SAVE_ACTION__ = true;
    app.registerExtension({
      name: 'AI Canvas Workflow Bridge',
      actionBarButtons: [{
        icon: 'icon-[lucide--save]',
        label: '保存到 AI Canvas',
        tooltip: '更新 AI Canvas 中的原工作流；创建副本请使用另存',
        class: 'ai-canvas-save-action',
        onClick: () => void saveToAICanvas(),
      }, {
        icon: 'ai-canvas-save-as-icon',
        label: '另存到 AI Canvas',
        tooltip: '将当前工作流保存为 AI Canvas 中的新工作流',
        onClick: () => void saveToAICanvas(true),
      }],
    });
  };

  const restoreNativeDockingPreference = () => {
    if (nativeDockingPreferenceRestored) return;
    nativeDockingPreferenceRestored = true;
    try {
      if (nativeDockingPreference === null) {
        window.localStorage.removeItem(COMFY_MENU_DOCKED_KEY);
      } else {
        window.localStorage.setItem(COMFY_MENU_DOCKED_KEY, nativeDockingPreference);
      }
    } catch {
      // localStorage may be unavailable in hardened WebView environments.
    }
  };

  const installFixedMenuBar = () => {
    let actionbarElement = null;
    let menuElement = null;
    const root = document.documentElement;

    // 菜单按组换行时同步占位；不裁切旧扩展原地挂载的下拉菜单。
    const measureMenu = () => {
      const height = menuElement?.isConnected
        ? Math.ceil(menuElement.getBoundingClientRect().height)
        : 0;
      if (height > 0) {
        root.style.setProperty('--ai-canvas-menu-height', `${height}px`);
      } else {
        root.style.removeProperty('--ai-canvas-menu-height');
      }
    };
    const resizeObserver = new ResizeObserver(measureMenu);
    const syncMenu = () => {
      const candidate = document.querySelector('.actionbar-container');
      const container = candidate instanceof HTMLElement ? candidate : null;
      if (container === actionbarElement) return;
      if (menuElement) {
        resizeObserver.unobserve(menuElement);
        menuElement.classList.remove('ai-canvas-fixed-menu');
      }
      actionbarElement?.classList.remove('ai-canvas-fixed-actionbar');
      actionbarElement = container;
      // 原生进度条以 card 为定位目标；固定整个 card，保留 Vue 的挂载关系。
      menuElement = container?.closest('[data-testid="action-bar-card"]') || container;
      if (menuElement) {
        menuElement.classList.add('ai-canvas-fixed-menu');
        container.classList.add('ai-canvas-fixed-actionbar');
        resizeObserver.observe(menuElement);
        restoreNativeDockingPreference();
      }
      measureMenu();
    };
    syncMenu();
    const observer = new MutationObserver(syncMenu);
    observer.observe(document.body, { childList: true, subtree: true });
  };

  const installWindowControls = () => {
    if (!document.body || document.getElementById('ai-canvas-comfy-window-chrome')) return;

    const style = document.createElement('style');
    style.id = 'ai-canvas-comfy-window-chrome-style';
    style.textContent = aiCanvasComfyStyles;
    document.head.appendChild(style);
    document.documentElement.classList.toggle('ai-canvas-comfy-macos', isMacOS);

    const chrome = document.createElement('div');
    chrome.id = 'ai-canvas-comfy-window-chrome';
    chrome.dataset.platform = isMacOS ? 'macos' : 'windows';
    chrome.innerHTML = isMacOS
      ? `
        <div class="ai-canvas-drag-region" aria-hidden="true"></div>
        <div class="ai-canvas-mac-controls">
          <button class="ai-canvas-traffic-light ai-canvas-mac-close" data-window-action="close" type="button" aria-label="关闭">
            <svg width="6" height="6" viewBox="0 0 7 7" aria-hidden="true"><path d="M1.6 1.1 5.9 5.4l-.5.5L1.1 1.6l.5-.5Z" fill="currentColor"/><path d="M5.4 1.1 1.1 5.4l.5.5 4.3-4.3-.5-.5Z" fill="currentColor"/></svg>
          </button>
          <button class="ai-canvas-traffic-light ai-canvas-mac-minimize" data-window-action="minimize" type="button" aria-label="最小化">
            <svg width="6" height="6" viewBox="0 0 7 7" aria-hidden="true"><rect x="1" y="3" width="5" height="1" rx=".5" fill="currentColor"/></svg>
          </button>
          <button class="ai-canvas-traffic-light ai-canvas-mac-expand" data-window-action="maximize" type="button" aria-label="全屏">
            <svg width="6" height="6" viewBox="0 0 7 7" aria-hidden="true"><path d="M1.4 1h4.2L1 5.6V1.4C1 1.18 1.18 1 1.4 1Z" fill="currentColor"/><path d="M5.6 6H1.4L6 1.4v4.2c0 .22-.18.4-.4.4Z" fill="currentColor"/></svg>
          </button>
        </div>`
      : `
        <div class="ai-canvas-drag-region" aria-hidden="true"></div>
        <div class="ai-canvas-windows-controls">
          <button class="ai-canvas-window-button" data-window-action="minimize" type="button" aria-label="最小化">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0" y="5" width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button class="ai-canvas-window-button" data-window-action="maximize" type="button" aria-label="最大化">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0" y="0" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1"/></svg>
          </button>
          <button class="ai-canvas-window-button ai-canvas-close" data-window-action="close" type="button" aria-label="关闭">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
        </div>`;
    const icon = document.createElement('span');
    icon.className = 'ai-canvas-window-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = aiCanvasComfyIcon;
    chrome.appendChild(icon);
    document.body.appendChild(chrome);

    const isInteractiveTarget = (el) => {
      // 图标通常是 SVG，不能只检查 HTMLElement，否则按住按钮图标也会触发拖窗。
      if (!(el instanceof Element)) return false;
      if (el.closest?.('[data-window-action]')) return true;
      if (el.closest?.('button, a, input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="menuitem"], [role="tab"], [role="menu"], [role="slider"], [role="spinbutton"], [role="combobox"], .p-menubar, .p-menu, .p-dialog-mask, .p-overlaypanel, .comfy-menu, .comfy-tabs, .workflow-tabs, [data-tab-id]')) return true;
      if (el.closest?.('.comfyui-queue-button, .comfyui-button, .p-button, .comfyui-menu, .workflow-tab, .p-tabmenu, .p-tabview')) return true;
      return false;
    };

    const DRAG_ACTIVATION_THRESHOLD = 4;
    let dragArmed = null;

    const armFromWindow = (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      dragArmed = null;
      // 菜单可换行，拖拽范围跟随实际占位高度，不使用固定像素高度。
      const bounds = chrome.getBoundingClientRect();
      if (event.clientY < bounds.top || event.clientY >= bounds.bottom) return;
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      dragArmed = {
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        moved: false,
      };
    };

    const moveFromWindow = (event) => {
      if (!dragArmed || dragArmed.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) { releaseDrag(); return; }
      const dx = event.clientX - dragArmed.startX;
      const dy = event.clientY - dragArmed.startY;
      if (!dragArmed.moved && Math.hypot(dx, dy) < DRAG_ACTIVATION_THRESHOLD) return;
      if (!dragArmed.moved) {
        dragArmed.moved = true;
        requestHostAction('start-dragging');
      }
    };

    const releaseDrag = (event) => {
      if (!dragArmed || (event?.pointerId != null && dragArmed.pointerId !== event.pointerId)) return;
      dragArmed = null;
    };

    // 使用捕获阶段 + window 监听，避免被 ComfyUI 内部 stopPropagation 拦截
    window.addEventListener('pointerdown', armFromWindow, true);
    window.addEventListener('pointermove', moveFromWindow, true);
    window.addEventListener('pointerup', releaseDrag, true);
    window.addEventListener('pointercancel', releaseDrag, true);
    window.addEventListener('blur', releaseDrag, true);

    chrome.querySelectorAll('[data-window-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.windowAction;
        if (action) requestHostAction(action);
      });
    });
  };

  /** 本窗口打开过的工作流：workflowId → ComfyUI 标签对象 */
  const loadedWorkflowTabs = new Map();

  /**
   * 工作流标签页的状态在不同前端版本里挂的位置不一样：新版走 extensionManager，
   * 老一点的把 pinia store 挂在 window.comfyAPI 上。挨个试，都问不到就返回 null。
   */
  const getWorkflowStore = (app) => {
    const candidates = [
      app?.extensionManager?.workflow,
      app?.workflowManager,
      (() => {
        try {
          return window.comfyAPI?.workflowStore?.useWorkflowStore?.();
        } catch {
          return null;
        }
      })(),
    ];
    return candidates.find((store) => Array.isArray(store?.openWorkflows)) ?? null;
  };

  /** Store.openWorkflow 只切元数据，不载图；使用真实载图服务或同等的草稿载入路径。 */
  const openExistingWorkflow = async (app, workflow) => {
    const api = window.comfyAPI?.workflowService;
    const service = api?.useWorkflowService?.() || api?.workflowService;
    if (typeof service?.openWorkflow === 'function') {
      const result = await service.openWorkflow(workflow);
      if (result === false) throw new Error('ComfyUI 未能切换工作流标签，请重试');
      return;
    }
    if (workflow.isLoaded === false && typeof workflow.load === 'function') await workflow.load();
    const state = workflow.activeState;
    if (!state || !Array.isArray(state.nodes)) {
      throw new Error('当前 ComfyUI 版本无法读取已打开标签的草稿，请在 ComfyUI 中切换到目标标签后重试');
    }
    const result = await app.loadGraphData(JSON.parse(JSON.stringify(state)), true, true, workflow);
    if (result === false) throw new Error('ComfyUI 未能载入工作流标签，请重试');
  };

  /**
   * 同一个工作流反复点「编辑」时，ComfyUI 每次都会新开一个 "名字 (2)(3)" 的标签页。
   * 先在它自己的已打开列表里找已绑定的标签对象，找到就载入当前草稿，不重复新建标签
   * —— 顺带保住用户在那个标签页里还没保存的改动。
   *
   * 返回 true=已切换 / false=确实没开着；无法确认标签身份时抛错。
   */
  const focusOpenWorkflow = async (app, knownTab) => {
    const store = getWorkflowStore(app);
    if (!store) {
      console.warn('[AI Canvas] 问不到 ComfyUI 的已打开工作流列表，无法切换标签页');
      throw new Error('无法确认已打开的 ComfyUI 标签，请重新打开编辑窗口');
    }
    const match = store.openWorkflows.find((item) => workflowIdentityFor(item) === workflowIdentityFor(knownTab));
    if (!match) return false;
    if (workflowIdentityFor(activeWorkflowFor(app)) === workflowIdentityFor(match)) return true;
    await openExistingWorkflow(app, match);
    if (workflowIdentityFor(activeWorkflowFor(app)) !== workflowIdentityFor(match)) throw new Error('ComfyUI 标签切换未完成，请重试');
    return true;
  };

  const graphNodes = (app) => {
    const graph = app.rootGraph || app.graph;
    return graph?._nodes || graph?.nodes || [];
  };

  const verifyGraph = (app) => {
    const count = graphNodes(app).length;
    if (!count) throw new Error('ComfyUI 画布没有载入节点。请检查缺失插件，或关闭空白标签后重试');
    return count;
  };

  // 仅调整视口，不改节点布局；避免导出文件的屏幕偏移让节点落在可视区外。
  // 只清理执行副本；编辑图和保存模板必须保留可上传的空槽。
  const pruneEmptyH3References = (output) => {
    if (!output || typeof output !== 'object') return output;
    const result = Object.fromEntries(Object.entries(output).map(([id, node]) => [
      id, { ...node, inputs: { ...node.inputs } },
    ]));
    for (const [id, node] of Object.entries(result)) {
      const kind = node.class_type === 'LoadImage' ? 'image'
        : node.class_type === 'LoadAudio' ? 'audio'
          : /^VHS_LoadVideo(?:FFmpeg)?$/.test(node.class_type) ? 'video' : null;
      if (!kind || !Object.prototype.hasOwnProperty.call(node.inputs, kind)) continue;
      const value = node.inputs[kind];
      if (value !== null && !(typeof value === 'string' && !value.trim())) continue;
      const refs = [];
      let required = false;
      for (const consumer of Object.values(result)) {
        for (const [key, link] of Object.entries(consumer.inputs)) {
          if (!Array.isArray(link) || String(link[0]) !== id) continue;
          const expected = kind === 'image' ? /^ref_images\.ref_image_\d+$/
            : kind === 'audio' ? /^ref_audios\.ref_audio_\d+$/ : /^ref_videos\.ref_video_\d+$/;
          if (consumer.class_type === 'MiniMaxH3ReferenceToVideo' && expected.test(key) && link[1] === 0) {
            refs.push([consumer.inputs, key]);
          } else required = true;
        }
      }
      if (required || !refs.length) continue;
      for (const [inputs, key] of refs) delete inputs[key];
      delete result[id];
    }
    return result;
  };

  const guardedQueueClients = new WeakSet();
  const installOptionalReferenceQueueGuard = () => {
    const client = window.comfyAPI?.api?.api;
    if (!client || typeof client.queuePrompt !== 'function') {
      throw new Error('ComfyUI 提交接口尚未就绪，无法启用可选素材，请稍后重新打开工作流');
    }
    if (guardedQueueClients.has(client)) return;
    const original = client.queuePrompt;
    client.queuePrompt = function (number, prompt, ...args) {
      const output = prompt?.output;
      if (!output || !Object.values(output).some((node) => node?.class_type === 'MiniMaxH3ReferenceToVideo')) {
        return original.call(this, number, prompt, ...args);
      }
      return original.call(this, number, { ...prompt, output: pruneEmptyH3References(output) }, ...args);
    };
    guardedQueueClients.add(client);
  };

  // VHS 在节点创建时可能预览文件列表的首项；空 API 输入必须同步清掉独立预览。
  const clearEmptyVideoPreviews = (app, api) => {
    for (const node of graphNodes(app)) {
      const input = api[String(node.id)];
      if (!/^VHS_LoadVideo(?:FFmpeg)?$/.test(input?.class_type || '')
        || typeof input.inputs?.video !== 'string' || input.inputs.video.trim()) continue;
      const file = node.widgets?.find((widget) => widget.name === 'video');
      const preview = node.widgets?.find((widget) => widget.name === 'videopreview');
      if (!file || !preview) continue;
      const clear = () => {
        preview.value = { ...preview.value, hidden: true, paused: true, params: {} };
        if (preview.parentEl) preview.parentEl.hidden = true;
        preview.videoEl?.pause?.();
        for (const media of [preview.videoEl, preview.imgEl]) {
          if (!media) continue;
          media.removeAttribute?.('src');
          media.hidden = true;
        }
        preview.aspectRatio = undefined;
        delete node.video_query;
        node.setDirtyCanvas?.(true, true);
      };
      const original = file.callback;
      file.callback = function (value, ...args) {
        if (typeof value !== 'string' || !value.trim()) { clear(); return; }
        preview.value = { ...preview.value, hidden: false, paused: false };
        if (preview.parentEl) preview.parentEl.hidden = false;
        return original?.call(this, value, ...args);
      };
      file.value = '';
      clear();
    }
  };

  const fitLoadedGraph = (app) => {
    const nodes = graphNodes(app).filter((node) => node.pos && node.size
      && [...node.pos, ...node.size].every(Number.isFinite));
    const canvas = app.canvas;
    const el = canvas?.canvas;
    const width = el?.clientWidth || el?.width;
    const height = el?.clientHeight || el?.height;
    if (!nodes.length || !canvas?.ds || !width || !height) return;
    const left = Math.min(...nodes.map((node) => node.pos[0]));
    const top = Math.min(...nodes.map((node) => node.pos[1]));
    const right = Math.max(...nodes.map((node) => node.pos[0] + node.size[0]));
    const bottom = Math.max(...nodes.map((node) => node.pos[1] + node.size[1]));
    const scale = Math.max(0.02, Math.min(1, (width - 80) / Math.max(1, right - left), (height - 80) / Math.max(1, bottom - top)));
    canvas.ds.scale = scale;
    canvas.ds.offset = [width / (2 * scale) - (left + right) / 2, height / (2 * scale) - (top + bottom) / 2];
    canvas.ds.computeVisibleArea?.(canvas.viewport);
    canvas.setDirty?.(true, true);
  };

  const performWorkflowLoad = async (payload) => {
    if (!payload?.apiJson) throw new Error('没有可载入的工作流数据');
    const api = JSON.parse(payload.apiJson);
    if (!api || Array.isArray(api) || !Object.keys(api).length
      || !Object.values(api).every((node) => node && typeof node.class_type === 'string' && node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs))) {
      throw new Error('工作流执行数据无效，请重新导入 ComfyUI API 格式工作流');
    }
    let editable = null;
    if (payload.editableJson) {
      try {
        const value = JSON.parse(payload.editableJson);
        if (Array.isArray(value?.nodes) && value.nodes.length) editable = value;
      } catch {
        // 有效 API 可恢复不可读的编辑布局，不能把损坏布局当空白工作流打开。
      }
    }
    for (let attempt = 0; preparingSave && attempt < 300; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (preparingSave) throw new Error('请先完成 ComfyUI 中的保存操作再打开工作流');
    loadingWorkflow = true;
    try {
      const app = await waitForComfyApp();
      installOptionalReferenceQueueGuard();
      const editorContext = {
        workflowId: payload.workflowId || null,
        name: payload.workflowName || '',
        category: payload.workflowCategory || 'ai-image',
        fileName: payload.workflowFileName || sanitizeFileName(payload.workflowName),
      };
      // 只对本窗口开过的工作流做切换：按名字盲猜会撞上用户自己同名的本地工作流
      const knownTab = editorContext.workflowId ? loadedWorkflowTabs.get(editorContext.workflowId) : null;
      if (knownTab) {
        const focused = await focusOpenWorkflow(app, knownTab);
        if (focused) {
          const nodeCount = verifyGraph(app);
          showToast(app, 'info', '已切换到已打开的标签页', editorContext.name);
          return { nodeCount, source: 'existing', detail: '已切换到原标签，保留未保存修改' };
        }
      }
      let source = 'api';
      let detail = '已从 API 数据自动排布节点';
      if (editable) {
        try {
          const loaded = await app.loadGraphData(editable, true, false, editorContext.fileName);
          if (loaded === false) throw new Error('编辑布局载入被拒绝');
          verifyGraph(app);
          source = 'editable';
          detail = '已载入编辑布局';
        } catch {
          detail = '编辑布局未能载入，已从 API 数据恢复节点';
        }
      } else if (payload.editableJson) {
        detail = '编辑布局为空或损坏，已从 API 数据恢复节点';
      }
      if (source === 'api') {
        const loaded = await app.loadApiJson(api, editorContext.fileName);
        if (loaded === false) throw new Error('API 工作流载入被拒绝，原标签绑定保持不变');
        clearEmptyVideoPreviews(app, api);
      }
      const nodeCount = verifyGraph(app);
      fitLoadedGraph(app);
      const active = activeWorkflowFor(app);
      if (editorContext.workflowId) {
        if (!active) throw new Error('ComfyUI 未提供当前标签身份，无法绑定原工作流，请重新打开编辑');
        bindWorkflowContext(active, editorContext);
        loadedWorkflowTabs.set(editorContext.workflowId, active);
      }
      showToast(app, 'info', '已从 AI Canvas 打开', editorContext.name);
      return { nodeCount, source, detail };
    } finally {
      loadingWorkflow = false;
    }
  };

  const loadResults = new Map();
  const pendingLoads = new Map();
  let loadQueue = Promise.resolve();
  const loadWorkflow = (payload) => {
    const requestId = payload?.requestId || `open-${createWorkflowId()}`;
    if (pendingLoads.has(requestId)) return pendingLoads.get(requestId);
    if (loadResults.get(requestId)?.state === 'ready') return Promise.resolve(loadResults.get(requestId));
    const task = loadQueue.then(async () => {
      loadResults.set(requestId, { requestId, state: 'loading' });
      try {
        const result = { requestId, state: 'ready', ...await performWorkflowLoad(payload) };
        loadResults.set(requestId, result);
        return result;
      } catch (error) {
        const detail = String(error?.message || error).slice(0, 1200);
        loadResults.set(requestId, { requestId, state: 'error', detail });
        showToast(getComfyApp(), 'error', '打开工作流失败', detail);
        throw error;
      } finally {
        pendingLoads.delete(requestId);
        if (loadResults.size > 64) loadResults.delete(loadResults.keys().next().value);
      }
    });
    pendingLoads.set(requestId, task);
    loadQueue = task.catch(() => undefined);
    return task;
  };

  const consumePending = () => {
    const pending = window.__AI_CANVAS_PENDING_WORKFLOW__;
    if (!pending) return;
    delete window.__AI_CANVAS_PENDING_WORKFLOW__;
    void loadWorkflow(pending).catch(() => undefined);
  };

  window.__AI_CANVAS_COMFY__ = {
    completeSave,
    consumePending,
    loadWorkflow,
    getLoadResult: (requestId) => loadResults.get(requestId) || null,
    saveToAICanvas,
    // 宿主下载完成后回调，告知文件落在哪 —— WebView2 自带的下载提示被 wry 关掉了
    notifyDownload: (success, path) => showToast(
      getComfyApp(),
      success ? 'success' : 'error',
      success ? '已下载' : '下载失败',
      success ? `已保存到 ${path}` : '',
    ),
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      installWindowControls();
      installFixedMenuBar();
    }, { once: true });
  } else {
    installWindowControls();
    installFixedMenuBar();
  }
  void installSaveAction().catch((error) => {
    showToast(getComfyApp(), 'error', 'AI Canvas 按钮加载失败', String(error?.message || error));
  });
  consumePending();
})();
