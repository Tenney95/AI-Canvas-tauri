/**
 * store.skills — 管理 Skill 的加载、导入、删除与配置。
 */
import { t } from '../i18n';
/**
 * Skill slice — uploaded read-only prompt skills.
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { UserSkill } from '../types';
import { generateId } from './store.utils';
import * as fileService from '../services/fileService';
import type { SkillUploadSource } from '../services/fileService';
import { parseSkillDocument } from '../services/chat/skillManifest';
import { getSkillDescription } from '../services/chat/skillDescription';
import { loadRecentSkillIds, saveRecentSkillIds } from '../services/indexedDb/skillUsageRepository';

let usageQueue: Promise<void> = Promise.resolve();

function updateSkillUsage(write: () => Promise<void>): Promise<void> {
  const pending = usageQueue.then(write);
  usageQueue = pending.catch(() => undefined);
  return pending;
}

function availableRecentSkills(ids: readonly string[], skills: readonly UserSkill[]): string[] {
  const available = new Set(skills.filter((skill) => skill.manifest?.userInvocable !== false).map((skill) => skill.id));
  return [...new Set(ids)].filter((id) => available.has(id)).slice(0, 5);
}

function getSkillName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  return base || '未命名 Skill';
}

export interface SkillSlice {
  userSkills: UserSkill[];
  recentSkillIds: string[];
  markSkillUsed: (id: string) => Promise<void>;
  uploadSkill: (source?: SkillUploadSource) => Promise<UserSkill | null>;
  createSkillFromContent: (fileName: string, content: string) => Promise<UserSkill>;
  updateSkillContent: (id: string, content: string) => Promise<UserSkill | null>;
  deleteSkill: (id: string) => Promise<void>;
  loadSkills: () => Promise<void>;
}

export const createSkillSlice: StateCreator<AppState, [], [], SkillSlice> = (set, get) => ({
  userSkills: [],
  recentSkillIds: [],

  markSkillUsed: (id) => updateSkillUsage(async () => {
    const { userSkills, recentSkillIds } = get();
    if (!userSkills.some((skill) => skill.id === id && skill.manifest?.userInvocable !== false)) return;
    const next = availableRecentSkills([id, ...recentSkillIds], userSkills);
    await saveRecentSkillIds(next);
    set({ recentSkillIds: next });
  }),

  uploadSkill: async (source = 'folder') => {
    const uploaded = await fileService.uploadSkillFile(source);
    if (!uploaded) return null;
    const parsed = parseSkillDocument(uploaded.content);

    const skill: UserSkill = {
      id: generateId(),
      name: parsed.manifest?.name || getSkillName(uploaded.fileName),
      description: getSkillDescription({ content: uploaded.content, fileName: uploaded.fileName, manifest: parsed.manifest }),
      fileName: uploaded.fileName,
      content: uploaded.content,
      sourceType: uploaded.sourceType,
      storagePath: uploaded.storagePath,
      entryFileName: uploaded.entryFileName,
      manifest: parsed.manifest,
      createdAt: Date.now(),
    };

    set((state) => ({ userSkills: [...state.userSkills, skill] }));
    await fileService.saveSkill({ ...skill }).catch((e) => console.warn('[保存 Skill] 持久化失败:', e));
    get().showToast(t('已上传 Skill「{name}」', { name: skill.name }));
    return skill;
  },

  createSkillFromContent: async (fileName, content) => {
    const parsed = parseSkillDocument(content);
    const skill: UserSkill = {
      id: generateId(),
      name: parsed.manifest?.name || getSkillName(fileName),
      description: getSkillDescription({ content, fileName, manifest: parsed.manifest }),
      fileName,
      content,
      sourceType: 'file',
      entryFileName: fileName,
      manifest: parsed.manifest,
      createdAt: Date.now(),
    };
    set((state) => ({ userSkills: [...state.userSkills, skill] }));
    await fileService.saveSkill({ ...skill });
    return skill;
  },

  updateSkillContent: async (id, content) => {
    const existing = get().userSkills.find((skill) => skill.id === id);
    if (!existing) return null;
    const parsed = parseSkillDocument(content);
    const updated: UserSkill = {
      ...existing,
      name: parsed.manifest?.name || getSkillName(existing.fileName),
      description: getSkillDescription({ content, fileName: existing.fileName, manifest: parsed.manifest }),
      content,
      manifest: parsed.manifest,
    };
    set((state) => ({
      userSkills: state.userSkills.map((skill) => skill.id === id ? updated : skill),
    }));
    await fileService.saveSkill({ ...updated });
    return updated;
  },

  deleteSkill: async (id) => {
    await updateSkillUsage(async () => {
      const next = get().recentSkillIds.filter((skillId) => skillId !== id);
      try { await saveRecentSkillIds(next); }
      catch { get().showToast(t('最近 Skill 使用记录保存失败'), 'error'); }
      set((state) => ({
        userSkills: state.userSkills.filter((skill) => skill.id !== id),
        recentSkillIds: next,
      }));
    });
    await fileService.deleteSkill(id).catch((e) => console.warn('[删除 Skill] 清理失败:', e));
  },

  loadSkills: async () => {
    const records = await fileService.loadSkills();
    set({
      userSkills: records.map((r) => {
        let manifest = r.manifest;
        if (!manifest) {
          try {
            manifest = parseSkillDocument(r.content).manifest;
          } catch (error) {
            console.warn(`[加载 Skill] Manifest 解析失败: ${r.id}`, error);
          }
        }
        return {
          id: r.id,
          name: manifest?.name || r.name,
          description: getSkillDescription({ ...r, manifest }),
          fileName: r.fileName,
          content: r.content,
          sourceType: r.sourceType === 'folder' ? 'folder' : 'file',
          storagePath: r.storagePath,
          entryFileName: r.entryFileName,
          manifest,
          createdAt: r.createdAt,
        };
      }),
    });
    try {
      await updateSkillUsage(async () => {
        const stored = await loadRecentSkillIds();
        const next = availableRecentSkills(stored, get().userSkills);
        if (next.length !== stored.length || next.some((id, index) => id !== stored[index])) await saveRecentSkillIds(next);
        set({ recentSkillIds: next });
      });
    } catch {
      get().showToast(t('最近 Skill 使用记录读取失败'), 'error');
    }
  },
});
