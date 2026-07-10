/**
 * aiService — AI 生成服务入口（薄壳 re-export）
 *
 * 各 provider 的具体实现已拆分到 ai/ 目录：
 *   ai/helpers.ts       — 模型解析、尺寸格式化、响应解析
 *   ai/imageUtils.ts    — 图片加载、URL 解析、上传辅助
 *   ai/promptResolver.ts — @mention prompt 解析
 *   ai/apimartGen.ts    — APIMart 图片/视频/音频 + 通用异步任务
 *   ai/generateText.ts  — 文本生成
 *   ai/generateImage.ts — 图片生成
 *   ai/generateVideo.ts — 视频生成
 *   ai/generateAudio.ts — 音频生成
 *   ai/panoramaPrompt.ts — 全景图提示词
 */
export { generateText } from './ai/generateText';
export { generateImage } from './ai/generateImage';
export { generateVideo } from './ai/generateVideo';
export { generateAudio } from './ai/generateAudio';
export { buildPanoramaPrompt } from './ai/panoramaPrompt';
export type { AIAudioGenParams, AIGenerateParams, AIImageGenParams, AIVideoGenParams } from './aiTypes';
