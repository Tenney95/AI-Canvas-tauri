import type { AppearanceTheme } from './index';

export interface ComfyManagementUiContext {
  appearance: AppearanceTheme | null;
  language: string | null;
  nativeCursor: boolean;
}

export interface ComfyRepository {
  id: string;
  name: string;
  enabled: boolean;
  removed: boolean;
  isGit: boolean;
  remoteUrl: string | null;
  branch: string | null;
  commit: string | null;
  commitDate: string | null;
  dirty: boolean;
}

export interface ComfyVersion {
  reference: string;
  commit: string;
  title: string;
  date: string;
  kind: 'tag' | 'commit' | 'branch';
  current: boolean;
}

export interface ComfyCatalogEntry {
  id: string;
  name: string;
  description: string;
  repositoryUrl: string;
  installed: boolean;
}

export interface ComfyManagementSnapshot {
  installationName: string;
  gitAvailable: boolean;
  core: ComfyRepository | null;
  extensions: ComfyRepository[];
  warnings: string[];
  uiContext: ComfyManagementUiContext;
}

export interface ComfyRepositoryAction {
  repositoryId: string;
  action: 'update' | 'switch' | 'enable' | 'disable' | 'uninstall' | 'restore';
  reference?: string;
}

export interface ComfyManagementResult {
  message: string;
}

export interface ComfyDownloadProgress {
  stage: 'connecting' | 'receiving' | 'resolving' | 'counting' | 'compressing' | 'catalog' | 'applying';
  completed: number;
  total?: number | null;
  unit: 'objects' | 'bytes';
}
