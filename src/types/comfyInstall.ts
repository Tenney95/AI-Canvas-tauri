/** 安装目标只在当前原生授权会话及弹窗内使用，不持久化到 Store / IndexedDB。 */
export interface ComfyInstallVariant {
  id: string;
  label: string;
  arch: string;
  asset: string;
  bytes: number;
  sha256: string;
}
export interface ComfyInstallInfo {
  supported: boolean;
  version: string;
  variants: ComfyInstallVariant[];
}
export interface ComfyInstallTarget { targetId: string; displayPath: string }
export interface ComfyInstallProgress {
  stage: 'connecting' | 'downloading' | 'verifying' | 'extracting' | 'checking' | 'committing';
  source: 'official' | 'mirror';
  completed: number;
  total: number | null;
}
export interface ComfyInstallResult { path: string; version: string; warning: string | null }
