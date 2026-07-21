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

function getSkillName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  return base || '未命名 Skill';
}

function getSkillDescription(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return '上传的只读 Skill';
  return firstLine.replace(/^#+\s*/, '').slice(0, 80);
}

export interface SkillSlice {
  userSkills: UserSkill[];
  uploadSkill: (source?: SkillUploadSource) => Promise<UserSkill | null>;
  deleteSkill: (id: string) => Promise<void>;
  loadSkills: () => Promise<void>;
}

export const createSkillSlice: StateCreator<AppState, [], [], SkillSlice> = (set, get) => ({
  userSkills: [],

  uploadSkill: async (source = 'folder') => {
    const uploaded = await fileService.uploadSkillFile(source);
    if (!uploaded) return null;
    const parsed = parseSkillDocument(uploaded.content);

    const skill: UserSkill = {
      id: generateId(),
      name: parsed.manifest?.name || getSkillName(uploaded.fileName),
      description: parsed.manifest?.description
        || parsed.manifest?.whenToUse
        || getSkillDescription(parsed.content),
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
    get().showToast(`已上传 Skill「${skill.name}」`);
    return skill;
  },

  deleteSkill: async (id) => {
    set((state) => ({
      userSkills: state.userSkills.filter((skill) => skill.id !== id),
    }));
    await fileService.deleteSkill(id).catch((e) => console.warn('[删除 Skill] 清理失败:', e));
  },

  loadSkills: async () => {
    const records = await fileService.loadSkills();
    if (records.length > 0) {
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
            description: manifest?.description || manifest?.whenToUse || r.description,
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
    }
  },
});
