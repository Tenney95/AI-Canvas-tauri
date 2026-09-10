/**
 * indexedDb/schema — IndexedDB 数据库 schema 与对象存储定义。
 * 声明数据库名、版本与全部 object store 常量（项目、工作流、配置、对话、消息、AgentTask、
 * 项目记忆、角色、子智能体、视频编辑器项目等），openDB 按版本声明补齐缺失的 store/index 并保留旧数据升级。
 */
import { toProjectSummaryRecord } from './projectSummary';

export const DB_NAME = 'ai-canvas-db';
export const DB_VERSION = 21;

export const STORE_PROJECTS = 'projects';
export const STORE_PROJECT_SUMMARIES = 'projectSummaries';
export const STORE_WORKFLOWS = 'workflows';
export const STORE_CONFIG = 'config';
export const STORE_PRESETS = 'presets';
export const STORE_HISTORY = 'history';
export const STORE_ASSET_META = 'assetMeta';
export const STORE_ASSET_META_V2 = 'assetMetaV2';
export const STORE_ASSET_INDEX = 'assetIndex';
export const STORE_STYLES = 'styles';
export const STORE_SKILLS = 'skills';
export const STORE_CHAT_CONVERSATIONS = 'chatConversations';
export const STORE_CHAT_MESSAGES = 'chatMessages';
export const STORE_AGENT_TASKS = 'agentTasks';
export const STORE_PROJECT_MEMORIES = 'projectMemories';
export const STORE_TOOLBAR_LAYOUTS = 'toolbarLayouts';
export const STORE_METADATA = 'metadata';
export const STORE_GLOBAL_CHARACTERS = 'globalCharacters';
export const STORE_SUB_AGENT_PROFILES = 'subAgentProfiles';
export const STORE_VIDEO_EDITOR_PROJECTS = 'videoEditorProjects';
export const STORE_PROJECT_VISUAL_DESCRIPTIONS = 'projectVisualDescriptions';
export const STORE_PLUGINS = 'plugins';

let dbPromise: Promise<IDBDatabase> | null = null;

/** 打开数据库并按历史版本声明补齐缺失的 store/index。 */
export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      const needsProjectSummaryBackfill = !db.objectStoreNames.contains(STORE_PROJECT_SUMMARIES);
      const projectSummaryStore = needsProjectSummaryBackfill
        ? db.createObjectStore(STORE_PROJECT_SUMMARIES, { keyPath: 'id' })
        : request.transaction!.objectStore(STORE_PROJECT_SUMMARIES);
      if (needsProjectSummaryBackfill) {
        // IndexedDB 没有字段投影能力。旧库升级必须读一次完整项目，但用 cursor 逐条处理，
        // 避免 getAll() 同时结构化克隆全部大型画布记录；后续启动只读取轻量摘要。
        const cursorRequest = request.transaction!.objectStore(STORE_PROJECTS).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const summary = toProjectSummaryRecord(cursor.value);
          if (summary) projectSummaryStore.put(summary);
          cursor.continue();
        };
      }
      if (!db.objectStoreNames.contains(STORE_WORKFLOWS)) {
        db.createObjectStore(STORE_WORKFLOWS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PRESETS)) {
        db.createObjectStore(STORE_PRESETS, { keyPath: 'id' });
      }
      const historyStore = db.objectStoreNames.contains(STORE_HISTORY)
        ? request.transaction!.objectStore(STORE_HISTORY)
        : db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
      if (!historyStore.indexNames.contains('timestamp_id')) {
        historyStore.createIndex('timestamp_id', ['timestamp', 'id'], { unique: false });
      }
      if (!historyStore.indexNames.contains('nodeId')) {
        historyStore.createIndex('nodeId', 'nodeId', { unique: false });
      }
      if (!historyStore.indexNames.contains('projectId_timestamp_id')) {
        historyStore.createIndex('projectId_timestamp_id', ['projectId', 'timestamp', 'id'], { unique: false });
      }
      if (!historyStore.indexNames.contains('projectId_nodeId')) {
        historyStore.createIndex('projectId_nodeId', ['projectId', 'nodeId'], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ASSET_META)) {
        db.createObjectStore(STORE_ASSET_META, { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains(STORE_ASSET_META_V2)) {
        db.createObjectStore(STORE_ASSET_META_V2, { keyPath: 'assetId' });
      }
      if (!db.objectStoreNames.contains(STORE_ASSET_INDEX)) {
        const assetStore = db.createObjectStore(STORE_ASSET_INDEX, { keyPath: 'assetId' });
        assetStore.createIndex('path', 'path', { unique: true });
        assetStore.createIndex('fingerprint', 'fingerprint', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_STYLES)) {
        db.createObjectStore(STORE_STYLES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SKILLS)) {
        db.createObjectStore(STORE_SKILLS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CHAT_CONVERSATIONS)) {
        const conversationStore = db.createObjectStore(STORE_CHAT_CONVERSATIONS, { keyPath: 'id' });
        conversationStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
        conversationStore.createIndex('deletedAt', 'deletedAt', { unique: false });
        conversationStore.createIndex('pinned', 'pinned', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CHAT_MESSAGES)) {
        const messageStore = db.createObjectStore(STORE_CHAT_MESSAGES, { keyPath: 'id' });
        messageStore.createIndex('conversationId_sequence', ['conversationId', 'sequence'], { unique: false });
        messageStore.createIndex('requestId', 'requestId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_AGENT_TASKS)) {
        const taskStore = db.createObjectStore(STORE_AGENT_TASKS, { keyPath: 'id' });
        taskStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
        taskStore.createIndex('conversationId_updatedAt', ['conversationId', 'updatedAt'], { unique: false });
        taskStore.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_TOOLBAR_LAYOUTS)) {
        db.createObjectStore(STORE_TOOLBAR_LAYOUTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PROJECT_MEMORIES)) {
        const memoryStore = db.createObjectStore(STORE_PROJECT_MEMORIES, { keyPath: 'id' });
        memoryStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
        memoryStore.createIndex('conversationId', 'source.conversationId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_METADATA)) {
        db.createObjectStore(STORE_METADATA, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_GLOBAL_CHARACTERS)) {
        const characterStore = db.createObjectStore(STORE_GLOBAL_CHARACTERS, { keyPath: 'id' });
        characterStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SUB_AGENT_PROFILES)) {
        const subAgentStore = db.createObjectStore(STORE_SUB_AGENT_PROFILES, { keyPath: 'id' });
        subAgentStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_VIDEO_EDITOR_PROJECTS)) {
        const videoEditorStore = db.createObjectStore(STORE_VIDEO_EDITOR_PROJECTS, { keyPath: 'id' });
        // 按画布项目列出剪辑工程；nodeId 用于从视频节点直接定位其工程
        videoEditorStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
        videoEditorStore.createIndex('nodeId', 'nodeId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PROJECT_VISUAL_DESCRIPTIONS)) {
        const visualStore = db.createObjectStore(STORE_PROJECT_VISUAL_DESCRIPTIONS, { keyPath: 'id' });
        visualStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
        visualStore.createIndex('projectId_fingerprint', ['projectId', 'fingerprint'], { unique: true });
      }
      if (!db.objectStoreNames.contains(STORE_PLUGINS)) {
        db.createObjectStore(STORE_PLUGINS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // blocked 请求无法取消；调用方已收到失败后，迟到的连接必须释放。
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      const invalidate = () => {
        if (dbPromise === opening) dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        invalidate();
      };
      db.onclose = invalidate;
      resolve(db);
    };
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new DOMException(
      '本地数据库正在等待其他软件窗口释放，请关闭其他实例后重试',
      'InvalidStateError',
    ));
  });
  dbPromise = opening;
  // 同时覆盖异步请求失败和 indexedDB.open 同步抛错；旧请求不得清掉新连接。
  void opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}
