(() => {
  if (!['127.0.0.1', 'localhost'].includes(window.location.hostname)) return;
  if (window.__AI_CANVAS_COMFY__) return;

  const WINDOW_DRAG_HEIGHT = 32;
  const WINDOWS_CONTROLS_WIDTH = 120;
  const ACTIONBAR_EDGE_GAP = 8;
  const ACTIONBAR_DOCK_THRESHOLD = WINDOW_DRAG_HEIGHT;
  const COMFY_MENU_DOCKED_KEY = 'Comfy.MenuPosition.Docked';
  const ACTIONBAR_POSITION_KEY = 'ai-canvas.comfy.actionbar-position';
  const isMacOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  let editorContext = null;
  let pendingSavePayload = null;
  let pendingSaveTimeout = null;
  let actionbarElement = null;
  let actionbarCleanup = null;
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

  const getComfyApp = () => window.app;

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
      if (app?.isGraphReady && typeof app.graphToPrompt === 'function') return app;
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

  const requestWorkflowName = async (app) => {
    if (editorContext?.name) return editorContext.name;
    const store = getWorkflowStore(app);
    const activeWorkflow = store?.activeWorkflow?.value ?? store?.activeWorkflow;
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

  const saveToAICanvas = async () => {
    let app;
    try {
      if (pendingSavePayload) {
        showToast(getComfyApp(), 'info', '正在保存', '请等待当前工作流保存完成');
        return;
      }
      app = await waitForComfyApp();
      const name = await requestWorkflowName(app);
      if (!name) return;
      const { workflow, output } = await app.graphToPrompt();
      const payload = {
        requestId: createSaveRequestId(),
        workflowId: editorContext?.workflowId || createWorkflowId(),
        name,
        category: editorContext?.category || inferCategory(output),
        fileName: editorContext?.fileName || sanitizeFileName(name),
        fileContent: JSON.stringify(output, null, 2),
        editableContent: JSON.stringify(workflow, null, 2),
      };
      pendingSavePayload = payload;
      window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__ = payload;
      pendingSaveTimeout = window.setTimeout(() => {
        if (pendingSavePayload?.requestId !== payload.requestId) return;
        pendingSavePayload = null;
        pendingSaveTimeout = null;
        delete window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__;
        showToast(
          getComfyApp(),
          'error',
          '保存超时',
          'AI Canvas 未返回保存结果，请检查主窗口后重试',
        );
      }, 30_000);
      requestHostAction('save');
    } catch (error) {
      if (pendingSaveTimeout !== null) window.clearTimeout(pendingSaveTimeout);
      pendingSaveTimeout = null;
      pendingSavePayload = null;
      delete window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__;
      showToast(app || getComfyApp(), 'error', '保存失败', String(error?.message || error));
    }
  };

  const completeSave = (requestId, success, detail) => {
    if (!pendingSavePayload) return;
    if (requestId && pendingSavePayload.requestId !== requestId) return;
    if (pendingSaveTimeout !== null) window.clearTimeout(pendingSaveTimeout);
    pendingSaveTimeout = null;
    if (success && pendingSavePayload) {
      editorContext = { ...editorContext, ...pendingSavePayload };
    }
    pendingSavePayload = null;
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
        tooltip: '将当前工作流保存回 AI Canvas',
        class: 'ai-canvas-save-action',
        onClick: () => void saveToAICanvas(),
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

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const readActionbarPosition = () => {
    try {
      const value = JSON.parse(window.localStorage.getItem(ACTIONBAR_POSITION_KEY) || 'null');
      if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
        return { x: value.x, y: value.y, docked: value.docked === true };
      }
    } catch {
      // Ignore invalid or unavailable persisted positions.
    }
    return null;
  };

  const saveActionbarPosition = (position) => {
    try {
      window.localStorage.setItem(ACTIONBAR_POSITION_KEY, JSON.stringify(position));
    } catch {
      // Position persistence is optional; dragging still works without it.
    }
  };

  const setTitlebarDragRegionInset = (container, docked) => {
    const dragRegion = document.querySelector(
      '#ai-canvas-comfy-window-chrome .ai-canvas-drag-region',
    );
    if (!(dragRegion instanceof HTMLElement)) return;
    if (!docked) {
      dragRegion.style.right = '0px';
      return;
    }
    const actionbarWidth = Math.ceil(container.getBoundingClientRect().width);
    const controlsWidth = isMacOS ? ACTIONBAR_EDGE_GAP : WINDOWS_CONTROLS_WIDTH;
    dragRegion.style.right = `${actionbarWidth + controlsWidth}px`;
  };

  const setActionbarDocked = (container, docked) => {
    container.classList.toggle('ai-canvas-actionbar-docked', docked);
    setTitlebarDragRegionInset(container, docked);
    if (!docked) return;
    container.style.left = 'auto';
    container.style.top = '0px';
    container.style.right = isMacOS ? `${ACTIONBAR_EDGE_GAP}px` : `${WINDOWS_CONTROLS_WIDTH}px`;
    container.style.bottom = 'auto';
  };

  const setActionbarPosition = (container, x, y, allowTopDock = false) => {
    const rect = container.getBoundingClientRect();
    const horizontalLimit = Math.max(0, window.innerWidth - rect.width);
    const verticalLimit = Math.max(0, window.innerHeight - rect.height);
    const minX = Math.min(ACTIONBAR_EDGE_GAP, horizontalLimit);
    const minY = Math.min(allowTopDock ? 0 : ACTIONBAR_EDGE_GAP, verticalLimit);
    const maxX = Math.max(minX, horizontalLimit - ACTIONBAR_EDGE_GAP);
    const maxY = Math.max(minY, verticalLimit - ACTIONBAR_EDGE_GAP);
    const nextPosition = {
      x: clamp(x, minX, maxX),
      y: clamp(y, minY, maxY),
    };
    container.style.left = `${nextPosition.x}px`;
    container.style.top = `${nextPosition.y}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    return nextPosition;
  };

  const attachActionbarDragging = (container) => {
    const dragHandle = container.querySelector('.actionbar .drag-handle');
    if (!(dragHandle instanceof HTMLElement)) return false;

    actionbarCleanup?.();
    const initialRect = container.getBoundingClientRect();
    const savedPosition = readActionbarPosition();
    actionbarElement = container;
    container.classList.add('ai-canvas-floating-actionbar');
    if (savedPosition?.docked) {
      setActionbarDocked(container, true);
    } else {
      setActionbarPosition(
        container,
        savedPosition?.x ?? initialRect.left,
        savedPosition?.y ?? initialRect.top,
      );
    }
    restoreNativeDockingPreference();

    let stopActiveDrag = null;
    const isDragHandleEvent = (event) => (
      event.target instanceof Node && dragHandle.contains(event.target)
    );

    const blockNativeMouseDrag = (event) => {
      if (event.button !== 0 || !isDragHandleEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const startDragging = (event) => {
      if (
        event.button !== 0
        || event.isPrimary === false
        || !isDragHandleEvent(event)
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      const dockedRect = container.getBoundingClientRect();
      setActionbarDocked(container, false);
      setActionbarPosition(container, dockedRect.left, dockedRect.top, true);
      const rect = container.getBoundingClientRect();
      const origin = { x: rect.left, y: rect.top };
      const pointer = { x: event.clientX, y: event.clientY };
      container.classList.add('ai-canvas-actionbar-dragging');
      dragHandle.setPointerCapture?.(event.pointerId);

      const stopDragging = () => {
        window.removeEventListener('pointermove', moveActionbar, true);
        window.removeEventListener('pointerup', stopDragging, true);
        window.removeEventListener('pointercancel', stopDragging, true);
        container.classList.remove('ai-canvas-actionbar-dragging');
        const currentRect = container.getBoundingClientRect();
        const shouldDock = currentRect.top <= ACTIONBAR_DOCK_THRESHOLD;
        if (shouldDock) {
          setActionbarDocked(container, true);
          saveActionbarPosition({
            x: currentRect.left,
            y: currentRect.top,
            docked: true,
          });
        } else {
          const position = setActionbarPosition(
            container,
            currentRect.left,
            currentRect.top,
          );
          saveActionbarPosition({ ...position, docked: false });
        }
        stopActiveDrag = null;
      };

      const moveActionbar = (moveEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        moveEvent.preventDefault();
        setActionbarPosition(
          container,
          origin.x + moveEvent.clientX - pointer.x,
          origin.y + moveEvent.clientY - pointer.y,
          true,
        );
      };

      stopActiveDrag?.();
      stopActiveDrag = stopDragging;
      window.addEventListener('pointermove', moveActionbar, true);
      window.addEventListener('pointerup', stopDragging, true);
      window.addEventListener('pointercancel', stopDragging, true);
    };

    const keepActionbarInBounds = () => {
      if (container.classList.contains('ai-canvas-actionbar-docked')) {
        setActionbarDocked(container, true);
        return;
      }
      const rect = container.getBoundingClientRect();
      const position = setActionbarPosition(container, rect.left, rect.top);
      saveActionbarPosition({ ...position, docked: false });
    };

    container.addEventListener('pointerdown', startDragging, true);
    container.addEventListener('mousedown', blockNativeMouseDrag, true);
    window.addEventListener('resize', keepActionbarInBounds);
    const resizeObserver = new ResizeObserver(keepActionbarInBounds);
    resizeObserver.observe(container);

    actionbarCleanup = () => {
      stopActiveDrag?.();
      resizeObserver.disconnect();
      setTitlebarDragRegionInset(container, false);
      window.removeEventListener('resize', keepActionbarInBounds);
      container.removeEventListener('pointerdown', startDragging, true);
      container.removeEventListener('mousedown', blockNativeMouseDrag, true);
      container.classList.remove(
        'ai-canvas-floating-actionbar',
        'ai-canvas-actionbar-dragging',
        'ai-canvas-actionbar-docked',
      );
      actionbarElement = null;
    };
    return true;
  };

  const installActionbarDragging = () => {
    const syncActionbar = () => {
      const container = document.querySelector('.actionbar-container');
      if (!(container instanceof HTMLElement) || container === actionbarElement) return;
      attachActionbarDragging(container);
    };
    syncActionbar();
    const observer = new MutationObserver(syncActionbar);
    observer.observe(document.body, { childList: true, subtree: true });
  };

  const installWindowControls = () => {
    if (!document.body || document.getElementById('ai-canvas-comfy-window-chrome')) return;

    const style = document.createElement('style');
    style.id = 'ai-canvas-comfy-window-chrome-style';
    style.textContent = `
      :root {
        --ai-canvas-brand: #6366f1;
        --ai-canvas-brand-hover: #818cf8;
        --ai-canvas-floating-surface: color-mix(
          in srgb,
          var(--p-content-background, #14141c) 82%,
          transparent
        );
        --ai-canvas-floating-border: color-mix(
          in srgb,
          var(--p-content-border-color, #2a2a3a) 76%,
          white 12%
        );
      }
      body {
        overflow: hidden;
      }
      .pointer-events-auto {
        background-color: transparent;
        border-color: transparent;
        z-index: 9999;
      }
      .actionbar-container {
        --ai-canvas-action-size: 28px;
        --ai-canvas-action-radius: 8px;
        box-sizing: border-box;
        gap: 4px;
        padding: 4px;
        border-color: transparent;
        border-radius: 14px;
        background:
          linear-gradient(
            var(--ai-canvas-floating-surface),
            var(--ai-canvas-floating-surface)
          ) padding-box,
          linear-gradient(
            145deg,
            var(--ai-canvas-floating-border),
            color-mix(in srgb, var(--ai-canvas-brand) 20%, transparent),
            var(--ai-canvas-floating-border)
          ) border-box;
        box-shadow:
          0 12px 30px rgb(0 0 0 / .3),
          inset 0 1px 0 rgb(255 255 255 / .08);
        backdrop-filter: blur(18px) saturate(130%);
        -webkit-backdrop-filter: blur(18px) saturate(130%);
      }
      .actionbar-container.ai-canvas-floating-actionbar {
        position: fixed;
        z-index: 2147483647;
        margin: 0;
        touch-action: none;
      }
      .actionbar-container.ai-canvas-actionbar-docked {
        height: 36px;
        padding: 2px 4px;
        border-width: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      .actionbar-container.ai-canvas-actionbar-docked .actionbar {
        border-color: transparent;
        background: transparent;
        box-shadow: none;
      }
      .actionbar-container.ai-canvas-actionbar-dragging {
        cursor: grabbing;
      }
      .actionbar-container.ai-canvas-floating-actionbar .actionbar {
        position: static;
      }
      .actionbar-container.ai-canvas-floating-actionbar .drag-handle {
        cursor: grab;
        touch-action: none;
      }
      .actionbar-container.ai-canvas-actionbar-dragging .drag-handle {
        cursor: grabbing;
      }
      .actionbar-container.ai-canvas-floating-actionbar > div > .border-dashed {
        display: none;
      }
      .actionbar-container [data-testid="action-bar-buttons"] {
        gap: 2px;
      }
      .actionbar-container button {
        border-radius: var(--ai-canvas-action-radius);
        padding-inline: 6px;
      }
      .actionbar-container button:not(.batch-count button) {
        min-height: var(--ai-canvas-action-size);
        height: var(--ai-canvas-action-size);
      }
      .actionbar-container button[aria-label][data-testid="queue-button"],
      .actionbar-container button[aria-label][data-testid="queue-mode-menu-trigger"],
      .actionbar-container button[aria-label]:not([data-testid]):not(.batch-count button) {
        min-width: var(--ai-canvas-action-size);
      }
      .actionbar-container button:not(:has(span)):not(.batch-count button) {
        width: var(--ai-canvas-action-size);
        min-width: var(--ai-canvas-action-size);
        padding-inline: 0;
      }
      .actionbar-container .queue-button-group {
        height: var(--ai-canvas-action-size);
        border-radius: var(--ai-canvas-action-radius);
      }
      .actionbar-container .batch-count > div {
        width: 44px;
        border-radius: var(--ai-canvas-action-radius) 0 0 var(--ai-canvas-action-radius);
      }
      .actionbar-container .batch-count input {
        padding-inline: 4px 0;
        font-size: 12px;
      }
      .actionbar-container [data-testid="queue-button"] {
        width: var(--ai-canvas-action-size);
        min-width: var(--ai-canvas-action-size);
        gap: 0;
        padding-inline: 0;
        overflow: hidden;
        font-size: 0;
      }
      .actionbar-container [data-testid="queue-mode-menu-trigger"] {
        width: 22px;
        min-width: 22px;
        padding-inline: 0;
        border-radius: 0 var(--ai-canvas-action-radius) var(--ai-canvas-action-radius) 0;
      }
      .actionbar-container [data-testid="queue-overlay-toggle"] {
        padding-inline: 8px;
      }
      .actionbar-container [data-testid="legacy-topbar-container"] {
        font-size: 12px;
      }
      .actionbar-container [data-testid="legacy-topbar-container"] > div,
      .actionbar-container [data-testid="legacy-topbar-container"] .comfyui-button-group,
      .actionbar-container [data-testid="legacy-topbar-container"] .rgthree-comfybar-top-button-group {
        align-items: center;
        gap: 4px;
      }
      .actionbar-container [data-testid="legacy-topbar-container"] > div {
        margin-inline: 4px;
      }
      .actionbar-container [data-testid="legacy-topbar-container"] .comfyui-button,
      .actionbar-container [data-testid="legacy-topbar-container"] .rgthree-comfybar-top-button {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: var(--ai-canvas-action-size);
        height: var(--ai-canvas-action-size);
        max-height: var(--ai-canvas-action-size);
        margin-block: 0;
        padding-inline: 6px;
        padding-block: 0;
        line-height: 1;
        overflow: hidden;
        border-radius: var(--ai-canvas-action-radius);
      }
      .actionbar-container [data-testid="legacy-topbar-container"] .rgthree-comfybar-top-button,
      .actionbar-container [data-testid="legacy-topbar-container"] .comfyui-button:not(:has(span)),
      .actionbar-container [data-testid="legacy-topbar-container"] .comfyui-button[title="ComfyUI Manager"] {
        width: var(--ai-canvas-action-size);
        min-width: var(--ai-canvas-action-size);
        padding-inline: 0;
      }
      .actionbar-container [data-testid="legacy-topbar-container"] .rgthree-comfybar-top-button {
        border-width: 0;
        box-shadow: none;
      }
      .actionbar-container [data-testid="legacy-topbar-container"] .rgthree-button-icon,
      .actionbar-container [data-testid="legacy-topbar-container"] .comfyui-button > i {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        margin: 0;
        line-height: 1;
      }
      .actionbar-container [data-testid="legacy-topbar-container"] i,
      .actionbar-container [data-testid="legacy-topbar-container"] svg {
        display: block;
        width: 14px;
        height: 14px;
        font-size: 14px;
      }
      /* Manager 只留图标 */
      .actionbar-container [data-testid="legacy-topbar-container"] .comfyui-button[title="ComfyUI Manager"] span {
        display: none;
      }
      /* Image Feed 与其他扩展入口一样使用纯图标 tiny 按钮 */
      .actionbar-container [data-testid="legacy-topbar-container"] .comfyui-button[title^="Show Image Feed"] {
        width: var(--ai-canvas-action-size);
        min-width: var(--ai-canvas-action-size);
        padding-inline: 0;
      }
      .actionbar-container [data-testid="legacy-topbar-container"] .comfyui-button[title^="Show Image Feed"] span {
        display: none;
      }
      .actionbar-container .ai-canvas-save-action {
        min-height: var(--ai-canvas-action-size);
        height: var(--ai-canvas-action-size);
        padding-inline: 8px;
        border-radius: var(--ai-canvas-action-radius);
        color: white;
        background-color: var(--ai-canvas-brand);
        transition:
          background-color 140ms ease,
          box-shadow 140ms ease,
          transform 140ms ease;
      }
      .actionbar-container .ai-canvas-save-action:hover {
        color: white;
        background-color: var(--ai-canvas-brand-hover);
        box-shadow:
          0 8px 20px rgb(99 102 241 / .38),
          inset 0 1px 0 rgb(255 255 255 / .2);
      }
      .actionbar-container .ai-canvas-save-action:active {
        transform: scale(.97);
      }
      .actionbar-container .ai-canvas-save-action:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--ai-canvas-brand-hover) 72%, white);
        outline-offset: 2px;
      }
      #ai-canvas-comfy-window-chrome {
        position: fixed;
        inset: 0 0 auto 0;
        z-index: 2147483646;
        height: 36px;
        pointer-events: none;
        user-select: none;
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-drag-region {
        position: fixed;
        inset: 0 0 auto 0;
        height: ${WINDOW_DRAG_HEIGHT}px;
        pointer-events: none;
        z-index: 0;
      }
      #ai-canvas-comfy-window-chrome button {
        font: inherit;
        -webkit-tap-highlight-color: transparent;
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-windows-controls {
        position: absolute;
        top: 0;
        right: 0;
        display: flex;
        height: 36px;
        pointer-events: auto;
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-window-button {
        width: 40px;
        height: 36px;
        display: grid;
        place-items: center;
        border: 0;
        color: var(--p-text-muted-color, currentColor);
        background: transparent;
        cursor: pointer;
        transition: color 120ms ease, background-color 120ms ease;
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-window-button:hover {
        color: var(--p-text-color, currentColor);
        background: var(--p-content-hover-background, ButtonFace);
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-close:hover {
        color: white;
        background: rgb(239 68 68 / .7);
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-mac-controls {
        position: absolute;
        top: 12px;
        left: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border: 1px solid var(--p-content-border-color, ButtonBorder);
        border-radius: 999px;
        background: color-mix(in srgb, var(--p-content-background, Canvas) 45%, transparent);
        box-shadow: 0 8px 20px rgb(0 0 0 / .2);
        backdrop-filter: blur(16px);
        pointer-events: auto;
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-traffic-light {
        width: 12px;
        height: 12px;
        display: grid;
        place-items: center;
        padding: 0;
        border: 1px solid rgb(0 0 0 / .2);
        border-radius: 999px;
        color: rgb(0 0 0 / .6);
        cursor: pointer;
        box-shadow: inset 0 1px 1px rgb(255 255 255 / .3);
        transition: filter 120ms ease, transform 120ms ease;
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-traffic-light:hover {
        filter: brightness(1.08);
        transform: scale(1.08);
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-traffic-light svg {
        opacity: 0;
        transition: opacity 120ms ease;
      }
      #ai-canvas-comfy-window-chrome .ai-canvas-mac-controls:hover svg { opacity: 1; }
      #ai-canvas-comfy-window-chrome .ai-canvas-mac-close { background: #ff5f57; }
      #ai-canvas-comfy-window-chrome .ai-canvas-mac-minimize { background: #febc2e; }
      #ai-canvas-comfy-window-chrome .ai-canvas-mac-expand { background: #28c840; }
      .ai-canvas-comfy-macos .p-scrollpanel.p-component.no-drag.overflow-hidden {
        min-width: 0;
        margin-left: 84px;
      }
      /* ===== ComfyUI side-toolbar → 悬浮左侧，视觉同步本项目 sidebar-floating =====
         真实 DOM：div.side-toolbar-container > nav.side-tool-bar-container
         本项目 sidebar-floating 的核心视觉（src/styles/sidebar.css）：
         - position:absolute; left:12px; top:20%（竖向偏上居中）
         - 玻璃态：floating-surface-bg padding-box + glass-bevel-border border-box
         - backdrop-filter: blur(24px); border:1px transparent; border-radius:14px
         - box-shadow: glass-shadow-floating（多层投影 + 内高光）
         - 子按钮 36×36、9px 圆角、hover 微缩放
         ComfyUI 页面无法引用本项目的 CSS 变量，下面用 color-mix 复刻等价视觉。 */
      .side-toolbar-container {
        /* 同步 sidebar-floating 的悬浮位置：左侧 12px、顶部 20% 起始（不居中偏移） */
        position: fixed !important;
        top: 20% !important;
        bottom: auto !important;
        left: 12px !important;
        right: auto !important;
        transform: none;
        z-index: 30;
        /* 纵向排列、紧凑间距 */
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 5px;
        /* 玻璃态背景：半透明表面色 padding-box + 渐变描边 border-box */
        background:
          linear-gradient(
            var(--ai-canvas-floating-surface),
            var(--ai-canvas-floating-surface)
          ) padding-box,
          linear-gradient(
            160deg,
            rgba(255, 255, 255, 0.18) 0%,
            rgba(255, 255, 255, 0.09) 36%,
            rgba(255, 255, 255, 0.04) 100%
          ) border-box;
        backdrop-filter: blur(24px) saturate(130%);
        -webkit-backdrop-filter: blur(24px) saturate(130%);
        border: 1px solid transparent;
        border-radius: 14px;
        /* 同步 glass-shadow-floating：多层投影 + 内高光内描边 */
        box-shadow:
          0 1px 2px rgb(0 0 0 / .42),
          0 12px 32px rgb(0 0 0 / .38),
          inset 0 1px 0 rgb(255 255 255 / .10),
          inset 0 0 0 1px rgb(255 255 255 / .025);
      }
      /* macOS 顶部有交通灯控件，左移一点避免重叠 */
      .ai-canvas-comfy-macos .side-toolbar-container {
        left: 84px !important;
      }
      /* 内部 nav 去掉原生贴边背景/边框/阴影，避免双层叠加；并修正悬浮态下的布局塌缩 */
      .side-toolbar-container .side-tool-bar-container {
        border: none !important;
        background: transparent !important;
        box-shadow: none !important;
        width: auto !important;
        height: auto !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 2px;
        padding: 0;
      }
      /* nav 内层包裹 div 同步为竖向 flex，去掉 h-full 撑满 */
      .side-toolbar-container .side-tool-bar-container > div {
        height: auto !important;
        gap: 2px;
      }
      /* 按钮组间距紧凑、背景透明，避免原生背景干扰悬浮玻璃态 */
      .side-toolbar-container .sidebar-item-group {
        gap: 2px;
        background: transparent !important;
      }
      /* 底部按钮组在悬浮态下不再用 mt-auto 钉底，跟随顶部组顺序排列 */
      .side-toolbar-container .sidebar-item-group.mt-auto {
        margin-top: 0 !important;
      }
      /* 去掉原生右侧分隔线（border-r）*/
      .side-toolbar-container .side-tool-bar-container.border-r {
        border-right: none !important;
      }
      /* 悬浮态下隐藏原生的贴边阴影/背景，避免双层叠加 */
      .side-toolbar-container::before,
      .side-toolbar-container::after {
        content: none;
      }
      /* 同步 sidebar-floating 的按钮规格：36×36、9px 圆角、hover 微缩放 */
      .side-toolbar-container .side-bar-button {
        width: 36px !important;
        height: 36px !important;
        min-height: 36px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        border: none !important;
        background: transparent !important;
        color: rgba(136, 136, 160, 0.7) !important;
        border-radius: 9px !important;
        cursor: pointer;
        padding: 0 !important;
        gap: 0 !important;
        font-size: 0;
        transition: color 120ms ease, background 120ms ease, transform 120ms ease;
      }
      .side-toolbar-container .side-bar-button:hover {
        color: var(--p-text-color, #e8e8ed) !important;
        background: rgba(255, 255, 255, 0.06) !important;
        transform: scale(1.04);
      }
      /* 按钮内部 content 容器去掉 gap 和多余布局，居中即可 */
      .side-toolbar-container .side-bar-button-content {
        gap: 0;
        flex: none;
      }
      /* 图标容器去掉相对定位残留 */
      .side-toolbar-container .sidebar-icon-wrapper {
        position: static;
      }
      /* 图标尺寸对齐本项目：18px（sidebar-floating 按钮内约 18-20px）*/
      .side-toolbar-container .side-bar-button-icon,
      .side-toolbar-container .comfyui-logo {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
      /* 顶部 ComfyUI 菜单按钮也同步规格：严格 36×36
         原生样式会把 width/height 写成 var(--comfy-menu-bg)，需要 !important 强制覆盖 */
      .side-toolbar-container .comfy-menu-button-wrapper {
        box-sizing: border-box;
        width: 36px !important;
        height: 36px !important;
        min-width: 36px !important;
        min-height: 36px !important;
        max-width: 36px !important;
        max-height: 36px !important;
        padding: 0 !important;
        margin: 0 !important;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 120ms ease, transform 120ms ease;
      }
      .side-toolbar-container .comfy-menu-button-wrapper > div {
        width: 18px !important;
        height: 18px !important;
      }
      .side-toolbar-container .comfy-menu-button-wrapper:hover {
        background: rgba(255, 255, 255, 0.06);
        transform: scale(1.04);
      }
      /* 隐藏 comfy-menu-button-wrapper 内叠加的向下箭头图标（lucide--chevron-down）*/
      .side-toolbar-container .comfy-menu-button-wrapper [class*="lucide--chevron-down"] {
        display: none !important;
      }
      /* 帮助中心按钮上方加分割线，同步本项目 sidebar-sep-v3（22×1、8% 白、2px 上下边距）*/
      .side-toolbar-container .comfy-help-center-btn {
        position: relative;
        margin-top: 6px;
      }
      .side-toolbar-container .comfy-help-center-btn::before {
        content: "";
        position: absolute;
        top: -4px;
        left: 50%;
        transform: translateX(-50%);
        width: 22px;
        height: 1px;
        background: rgba(255, 255, 255, 0.08);
        pointer-events: none;
      }
      /* ===== comfyui-body-top 移到页面最底部 =====
         ComfyUI 默认把 .comfyui-body-top 放在视口顶部，这里改用固定定位钉到底部，
         并用 order 兜底（父级若为 flex 则排到末尾）。 */
      .comfyui-body-top {
        position: fixed !important;
        top: auto !important;
        bottom: 0 !important;
        left: 0 !important;
        right: 0 !important;
        width: 100% !important;
        z-index: 20;
      }
      /* 父级若是 flex 布局，同时用 order 排到末尾 */
      .comfyui-body-top {
        order: 9999;
      }
    `;
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
    document.body.appendChild(chrome);

    const isInteractiveTarget = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.closest?.('[data-window-action]')) return true;
      if (el.closest?.('button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="menu"], .p-menubar, .p-menu, .p-dialog-mask, .p-overlaypanel, .comfy-menu, .comfy-tabs, .workflow-tabs, [data-tab-id]')) return true;
      if (el.closest?.('.comfyui-queue-button, .comfyui-button, .p-button, .actionbar-container, .comfyui-menu, .workflow-tab, .p-tabmenu, .p-tabview')) return true;
      return false;
    };

    const DRAG_ACTIVATION_THRESHOLD = 4;
    let dragArmed = null;

    const armFromWindow = (event) => {
      if (event.button !== 0) return;
      if (event.clientY > WINDOW_DRAG_HEIGHT) return;
      if (isInteractiveTarget(event.target)) return;
      dragArmed = {
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        moved: false,
      };
    };

    const moveFromWindow = (event) => {
      if (!dragArmed || dragArmed.pointerId !== event.pointerId) return;
      const dx = event.clientX - dragArmed.startX;
      const dy = event.clientY - dragArmed.startY;
      if (!dragArmed.moved && Math.hypot(dx, dy) < DRAG_ACTIVATION_THRESHOLD) return;
      if (!dragArmed.moved) {
        dragArmed.moved = true;
        requestHostAction('start-dragging');
      }
      if (event.clientY > WINDOW_DRAG_HEIGHT) {
        releaseDrag();
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

    chrome.querySelectorAll('[data-window-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.windowAction;
        if (action) requestHostAction(action);
      });
    });
  };

  /** 本窗口打开过的工作流：workflowId → 传给 ComfyUI 的标签名 */
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

  /** 切换标签页的方法同样可能在 store 上，也可能在 workflowService 上 */
  const openExistingWorkflow = async (store, workflow) => {
    const openers = [
      store?.openWorkflow?.bind(store),
      (() => {
        try {
          const service = window.comfyAPI?.workflowService?.workflowService;
          return service?.openWorkflow?.bind(service);
        } catch {
          return null;
        }
      })(),
    ].filter(Boolean);
    for (const open of openers) {
      try {
        await open(workflow);
        return true;
      } catch {
        // 换下一个
      }
    }
    return false;
  };

  /**
   * 同一个工作流反复点「编辑」时，ComfyUI 每次都会新开一个 "名字 (2)(3)" 的标签页。
   * 先在它自己的已打开列表里找同名的，找到就切过去，不再重复加载
   * —— 顺带保住用户在那个标签页里还没保存的改动。
   *
   * 返回 true=已切换 / false=确实没开着 / null=这个前端版本问不到，无从判断。
   */
  const focusOpenWorkflow = async (app, fileName) => {
    const store = getWorkflowStore(app);
    if (!store) {
      console.warn('[AI Canvas] 问不到 ComfyUI 的已打开工作流列表，无法切换标签页');
      return null;
    }
    const target = workflowBaseName(fileName);
    const match = store.openWorkflows.find(
      (item) => workflowBaseName(item?.filename ?? item?.path ?? item?.key) === target,
    );
    if (!match) return false;
    if (store.activeWorkflow === match) return true;
    // 标签页确实开着、只是切不过去：也别再开一个副本
    return (await openExistingWorkflow(store, match)) ? true : null;
  };

  const loadWorkflow = async (payload) => {
    if (!payload?.apiJson) return;
    const app = await waitForComfyApp();
    editorContext = {
      workflowId: payload.workflowId || null,
      name: payload.workflowName || '',
      category: payload.workflowCategory || 'ai-image',
      fileName: payload.workflowFileName || sanitizeFileName(payload.workflowName),
    };
    // 只对本窗口开过的工作流做切换：按名字盲猜会撞上用户自己同名的本地工作流
    const knownTab = editorContext.workflowId ? loadedWorkflowTabs.get(editorContext.workflowId) : null;
    if (knownTab) {
      const focused = await focusOpenWorkflow(app, knownTab);
      // false = 标签页确实被关掉了，重新加载；true / null 一律不再开副本
      if (focused !== false) {
        showToast(
          app,
          'info',
          focused ? '已切换到已打开的标签页' : '该工作流已在 ComfyUI 中打开',
          editorContext.name,
        );
        return;
      }
    }
    if (payload.editableJson) {
      await app.loadGraphData(JSON.parse(payload.editableJson), true, true, editorContext.fileName);
    } else {
      await app.loadApiJson(JSON.parse(payload.apiJson), editorContext.fileName);
    }
    if (editorContext.workflowId) {
      loadedWorkflowTabs.set(editorContext.workflowId, editorContext.fileName);
    }
    showToast(app, 'info', '已从 AI Canvas 打开', editorContext.name);
  };

  const consumePending = () => {
    const pending = window.__AI_CANVAS_PENDING_WORKFLOW__;
    if (!pending) return;
    delete window.__AI_CANVAS_PENDING_WORKFLOW__;
    void loadWorkflow(pending).catch((error) => {
      showToast(getComfyApp(), 'error', '打开工作流失败', String(error?.message || error));
    });
  };

  window.__AI_CANVAS_COMFY__ = {
    completeSave,
    consumePending,
    loadWorkflow,
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
      installActionbarDragging();
    }, { once: true });
  } else {
    installWindowControls();
    installActionbarDragging();
  }
  void installSaveAction().catch((error) => {
    showToast(getComfyApp(), 'error', 'AI Canvas 按钮加载失败', String(error?.message || error));
  });
  consumePending();
})();
