/**
 * useSourceFileUpload — 统一的源文件上传 hook，封装 loading 状态 + 文件选择 + 错误处理
 */
import { useState, useCallback } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { uploadSourceFileToProject } from '../../../services/fileService';

export function useSourceFileUpload(extensions: string) {
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = useCallback(async () => {
    setIsUploading(true);
    try {
      return await uploadSourceFileToProject(extensions, currentProjectId);
    } catch {
      return null;
    } finally {
      setIsUploading(false);
    }
  }, [extensions, currentProjectId]);

  return { isUploading, handleUpload };
}
