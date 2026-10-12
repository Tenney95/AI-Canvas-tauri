/** 本地 ComfyUI 启动选项；仅映射原生白名单参数，不接受脚本或任意命令行。 */
export interface ComfyUILaunchSettings {
  port: number;
  vramMode: 'auto' | 'high' | 'normal' | 'low' | 'no' | 'cpu';
  /** 仅覆盖扩散模型精度，VAE 与文本编码器沿用 ComfyUI 默认配置。 */
  precision: 'auto' | 'fp16' | 'bf16' | 'fp32';
  attention: 'auto' | 'pytorch' | 'split' | 'quad';
  /** auto 保留安装版本默认值，其余选项显式指定预览方式。 */
  previewMethod: 'auto' | 'none' | 'latent2rgb' | 'taesd';
  disableSmartMemory: boolean;
}

export const DEFAULT_COMFY_LAUNCH_SETTINGS: ComfyUILaunchSettings = {
  port: 8188,
  vramMode: 'auto',
  precision: 'auto',
  attention: 'auto',
  previewMethod: 'auto',
  disableSmartMemory: false,
};
