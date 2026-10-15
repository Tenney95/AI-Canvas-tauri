import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadModel, type ModelDownloadProgress } from '../services/onnxService';

/** 模型下载共用真实字节进度；多文件逐项展示，避免按文件数量伪造总进度。 */
export function useModelDownload() {
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadLabel, setDownloadLabel] = useState<string>();
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  useEffect(() => () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const download = useCallback(async (models: readonly string[]): Promise<boolean> => {
    if (controllerRef.current) return false;
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsDownloading(true);
    setProgress(null);
    setDownloadLabel(undefined);
    try {
      for (let index = 0; index < models.length; index += 1) {
        if (controller.signal.aborted) return false;
        setProgress(null);
        setDownloadLabel(models.length > 1
          ? `正在下载模型文件（${index + 1}/${models.length}）`
          : undefined);
        await downloadModel(models[index], {
          signal: controller.signal,
          onProgress: (next) => {
            if (controllerRef.current === controller && !controller.signal.aborted) {
              setProgress(next);
            }
          },
        });
      }
      return !controller.signal.aborted;
    } catch (error) {
      if (controller.signal.aborted) return false;
      throw error;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setIsDownloading(false);
      }
    }
  }, []);

  return { isDownloading, progress, downloadLabel, download, cancel };
}
