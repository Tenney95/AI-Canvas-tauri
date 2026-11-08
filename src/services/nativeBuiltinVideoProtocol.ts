/** 内置视频原任务查询合同版本；不保存生成请求或素材地址。 */
import { GRSAI_H3_PROTOCOL } from './ai/grsaiModels';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { sha256BytesHex } from './mediaDataUrl';
export const nativeBuiltinVideoProtocolDigest = (provider: string) => sha256BytesHex(new TextEncoder().encode(
  projectModelSourceToken(provider === 'grsai' ? GRSAI_H3_PROTOCOL : ['native-original-video-query-v1', provider])));
