/**
 * useAppStore — 全局状态聚合入口
 *
 * 通过 Zustand slice 模式将状态按职责拆分，各 slice 独立维护：
 *   store.utils.ts     — 工具函数
 *   store.nodes.ts     — 画布节点 / 边
 *   store.ui.ts        — UI 面板状态
 *   store.toast.ts     — 消息提示
 *   store.history.ts   — 撤销 / 重做
 *   store.config.ts    — API 配置
 *   store.workflows.ts — ComfyUI 工作流
 *   store.presets.ts   — 用户预设
 *   store.skills.ts    — 用户上传 Skill
 *   store.groups.ts    — 节点分组
 *   store.clipboard.ts — 复制 / 粘贴
 *   store.projects.ts  — 项目管理 / 保存加载
 */
import { create } from 'zustand';

import type { NodeSlice } from './store.nodes';
import type { UISlice } from './store.ui';
import type { ToastSlice } from './store.toast';
import type { HistorySlice } from './store.history';
import type { HistoryRecordSlice } from './store.historyRecord';
import type { ConfigSlice } from './store.config';
import type { WorkflowSlice } from './store.workflows';
import type { PresetSlice } from './store.presets';
import type { SkillSlice } from './store.skills';
import type { GroupSlice } from './store.groups';
import type { ClipboardSlice } from './store.clipboard';
import type { ProjectSlice } from './store.projects';
import type { StyleSlice } from './store.styles';
import type { ChatSlice } from './store.chat';
import type { AgentSlice } from './store.agent';
import type { MemorySlice } from './store.memory';
import type { ToolbarSlice } from './store.toolbar';

import { createNodeSlice } from './store.nodes';
import { createUISlice } from './store.ui';
import { createToastSlice } from './store.toast';
import { createHistorySlice } from './store.history';
import { createHistoryRecordSlice } from './store.historyRecord';
import { createConfigSlice } from './store.config';
import { createWorkflowSlice } from './store.workflows';
import { createPresetSlice } from './store.presets';
import { createSkillSlice } from './store.skills';
import { createGroupSlice } from './store.groups';
import { createClipboardSlice } from './store.clipboard';
import { createProjectSlice } from './store.projects';
import { createStyleSlice } from './store.styles';
import { createChatSlice } from './store.chat';
import { createAgentSlice } from './store.agent';
import { createMemorySlice } from './store.memory';
import { createToolbarSlice } from './store.toolbar';

// ---- Re-export utilities for backward compatibility ----
export { generateId, computeImageNodeDimensions } from './store.utils';

// ---- Composed AppState type ----
export type AppState = NodeSlice
  & UISlice
  & ToastSlice
  & HistorySlice
  & HistoryRecordSlice
  & ConfigSlice
  & WorkflowSlice
  & PresetSlice
  & SkillSlice
  & StyleSlice
  & GroupSlice
  & ClipboardSlice
  & ProjectSlice
  & ChatSlice
  & AgentSlice
  & MemorySlice
  & ToolbarSlice;

// ---- Store creation via slice composition ----
export const useAppStore = create<AppState>()((...a) => ({
  ...createNodeSlice(...a),
  ...createUISlice(...a),
  ...createToastSlice(...a),
  ...createHistorySlice(...a),
  ...createHistoryRecordSlice(...a),
  ...createConfigSlice(...a),
  ...createWorkflowSlice(...a),
  ...createPresetSlice(...a),
  ...createSkillSlice(...a),
  ...createStyleSlice(...a),
  ...createGroupSlice(...a),
  ...createClipboardSlice(...a),
  ...createProjectSlice(...a),
  ...createChatSlice(...a),
  ...createAgentSlice(...a),
  ...createMemorySlice(...a),
  ...createToolbarSlice(...a),
}));
