/** Muse 网页只接受自然语言生成请求；目标参数不作为成片规格保证。 */
import type { MediaReference } from '../../../types/aiTypes';
import { MUSE_IMAGE_CAPABILITY, MUSE_VIDEO_CAPABILITY, MUSE_MAX_IMAGE_REFERENCES } from '../museModels';

export function museImagePrompt(prompt: string, ratio: string, references: number): string {
  assertMuseInput(prompt, references);
  if (!MUSE_IMAGE_CAPABILITY.ratios?.includes(ratio)) throw new Error('Muse 图片不支持所选目标比例');
  return `${references ? '只依据本次上传的参考图片生成或编辑一张新图片，不复用历史附件。' : '本次没有参考图片，请直接根据文字从零生成一张全新图片。'}目标比例 ${ratio}。请返回实际图片附件。\n\n${prompt}`;
}

export function museVideoPrompt(prompt: string, ratio: string, duration: number, references: readonly MediaReference[]): { prompt: string; images: string[] } {
  assertMuseInput(prompt, references.length);
  if (!MUSE_VIDEO_CAPABILITY.ratios?.includes(ratio) || !MUSE_VIDEO_CAPABILITY.durations?.includes(duration)) {
    throw new Error('Muse 视频目标比例或时长不在支持列表中');
  }
  if (references.some((reference) => reference.kind !== 'image' || reference.role === 'last_frame')) {
    throw new Error('Muse 仅支持图片参考和首帧，不支持尾帧、视频或音频参考');
  }
  if (references.filter((reference) => reference.role === 'first_frame').length > 1) throw new Error('Muse 视频只能指定一张首帧');
  // 首帧始终排在第一张；其余素材顺序仍与提示词中的图片编号一致。
  const firstFrame = references.findIndex((reference) => reference.role === 'first_frame');
  if (firstFrame > 0) throw new Error('请将 Muse 首帧放在参考图片第一位，避免图片编号与素材错配');
  const instruction = references.length ? firstFrame === 0
    ? '使用本次上传的第一张图片作为首帧，其余图片作为内容和风格参考。'
    : '只使用本次上传的图片作为内容和风格参考，不引用历史素材。'
    : '本次没有参考素材，请直接从零生成全新视频，不引用历史图片。';
  return { prompt: `${instruction}目标比例 ${ratio}，目标时长 ${duration} 秒。请生成动态视频并返回实际视频附件。\n\n${prompt}`, images: references.map((reference) => reference.url) };
}

function assertMuseInput(prompt: string, references: number): void {
  if (!prompt.trim() || prompt.length > 32_000) throw new Error('Muse 提示词不能为空或超过 32000 字符');
  if (!Number.isInteger(references) || references < 0 || references > MUSE_MAX_IMAGE_REFERENCES) {
    throw new Error(`Muse 最多支持 ${MUSE_MAX_IMAGE_REFERENCES} 张参考图片`);
  }
}
