/**
 * LIBAPI 已审计合同快照（2026-10-24）。来源：官方 /openapi.json、/v1/logical-models。
 * 只保留正常文本、图片、视频和音频生成；退役、转写、超分、声纹、数字人等任务不冒充生成。
 * 远端认证目录仍决定候选可用性；快照不包含凭据、价格或任意可执行模板。
 */
import type { ProviderModelSelection } from '../../../types';
import type { AudioModelCapability, AudioOutputFormat, ImageModelCapability, ModelExecutionProfile, NormalizedModelExecutionProtocol, ProtocolJsonValue, VideoModelCapability } from '../../../types/aiTypes';
import type { ModelProtocolVariables } from '../modelProtocolTypes';
import type { CanonicalVideoRequest } from '../videoRequestResolver';
import { comparableProtocol } from '../modelProtocol';
import { getImageCapabilityTemplate, getVideoCapabilityTemplate } from '../modelCapabilityTemplates';
import type { ImageCapabilityTemplateId, VideoCapabilityTemplateId } from '../modelCapabilityTemplates';

interface ParameterSnapshot {
  enum?: string[];
  default?: string | number | boolean;
  max_items?: number;
  max_items_by_mode?: Record<string, number>;
  min_duration_sec?: number;
  max_duration_sec?: number;
  max_total_duration_sec?: number;
  available_when?: { mode?: string[] };
}
interface LibapiModelSnapshot {
  id: string;
  public_id: string;
  name: string;
  type: 'chat' | 'image' | 'video' | 'audio';
  vision?: boolean;
  context?: number;
  exclusive?: boolean;
  params: Record<string, ParameterSnapshot>;
}

// 官方参数表的精简快照；新增型号必须核对字段语义后再加入。
const SNAPSHOT: readonly LibapiModelSnapshot[] = [
  {"id":"seedance-2-5","public_id":"seedance-2-5","name":"Seedance 2.5 · 官方直连","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["16:9","9:16","21:9","3:4","1:1","4:3"],"default":"16:9","available_when":{"mode":["text-to-video","reference"]}},"resolution":{"enum":["480p","720p","1080p"],"default":"480p"},"duration":{"enum":["4","5","6","8","10","12","15","20","25","29","30"],"default":"5"},"mode":{"enum":["text-to-video","first-frame","reference","first-last","edit","extend"],"default":"first-frame"},"images":{"max_items":30,"max_items_by_mode":{"edit":30,"extend":30,"first-frame":30,"first-last":30,"reference":30,"text-to-video":0}},"videos":{"max_items":10,"max_items_by_mode":{"edit":10,"extend":1,"first-frame":0,"first-last":0,"reference":10,"text-to-video":0},"min_duration_sec":1.8,"max_total_duration_sec":30},"audios":{"max_items":10,"max_items_by_mode":{"edit":10,"extend":10,"first-frame":0,"first-last":0,"reference":10,"text-to-video":0},"min_duration_sec":1.8,"max_total_duration_sec":30}}},
  {"id":"seedance-2-5-special","public_id":"seedance-2-5-special","name":"Seedance 2.5 · 特价按次","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["9:16","16:9","1:1","4:3","3:4","21:9"],"default":"9:16"},"resolution":{"enum":["480p","720p","1080p"],"default":"720p"},"duration":{"enum":["30"],"default":"30"},"mode":{"enum":["reference","first-frame","text-to-video"],"default":"first-frame"},"images":{"max_items":30,"max_items_by_mode":{"first-frame":30,"reference":30,"text-to-video":0}},"audios":{"max_items":3,"max_items_by_mode":{"first-frame":0,"reference":3,"text-to-video":0},"min_duration_sec":2,"max_total_duration_sec":15}}},
  {"id":"seedance-2-5-promo","public_id":"seedance-2-5-promo","name":"Seedance 2.5 · 特价按秒","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["16:9","9:16","21:9","3:4","1:1","4:3"],"default":"16:9"},"resolution":{"enum":["480p","720p","1080p","4k"],"default":"480p"},"duration":{"enum":["4","5","6","8","10","12","15","20","25","29","30"],"default":"5"},"mode":{"enum":["text-to-video","first-frame","reference"],"default":"first-frame"},"images":{"max_items":30,"max_items_by_mode":{"first-frame":30,"reference":30,"text-to-video":0}},"videos":{"max_items":10,"max_items_by_mode":{"first-frame":0,"reference":10,"text-to-video":0},"min_duration_sec":2,"max_total_duration_sec":15},"audios":{"max_items":10,"max_items_by_mode":{"first-frame":0,"reference":10,"text-to-video":0},"min_duration_sec":2,"max_total_duration_sec":15}}},
  {"id":"seedance-2-0-official","public_id":"seedance-2-0-official","name":"Seedance 2.0 · 官方直连","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["16:9","9:16","1:1","4:3","3:4","21:9","adaptive"],"default":"16:9"},"resolution":{"enum":["480p","720p","1080p","4k"],"default":"480p"},"duration":{"enum":["4","5","6","7","8","9","10","11","12","13","14","15"],"default":"4"},"mode":{"enum":["text-to-video","reference","first-frame","first-last","edit","extend"],"default":"first-frame"},"images":{"max_items":9,"max_items_by_mode":{"edit":9,"extend":9,"first-frame":9,"first-last":9,"reference":9,"text-to-video":0}},"videos":{"max_items":3,"max_items_by_mode":{"edit":3,"extend":1,"first-frame":0,"first-last":0,"reference":3,"text-to-video":0},"min_duration_sec":2,"max_total_duration_sec":15},"audios":{"max_items":3,"max_items_by_mode":{"edit":3,"extend":3,"first-frame":0,"first-last":0,"reference":3,"text-to-video":0},"min_duration_sec":1.8,"max_total_duration_sec":15},"quality":{"enum":["标准","fast","mini"],"default":"mini"}}},
  {"id":"seedance-2-0-promo","public_id":"seedance-2-0-promo","name":"Seedance 2.0 · 特价按秒","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["9:16","16:9","1:1","4:3","3:4","21:9","adaptive"],"default":"9:16"},"resolution":{"enum":["480p","720p","1080p","4k"],"default":"480p"},"duration":{"enum":["4","5","6","7","8","9","10","12","15"],"default":"4"},"mode":{"enum":["reference","first-last","text-to-video","first-frame"],"default":"reference"},"images":{"max_items":9,"max_items_by_mode":{"first-frame":9,"first-last":9,"reference":9,"text-to-video":0}},"videos":{"max_items":3,"max_items_by_mode":{"first-frame":0,"first-last":0,"reference":3,"text-to-video":0},"min_duration_sec":2,"max_total_duration_sec":15},"audios":{"max_items":3,"max_items_by_mode":{"first-frame":0,"first-last":0,"reference":3,"text-to-video":0},"min_duration_sec":1.8,"max_total_duration_sec":15},"quality":{"enum":["标准","fast","mini"],"default":"mini"}}},
  {"id":"seedance-2-0-special","public_id":"seedance-2-0-special","name":"Seedance 2.0 · 特价按次","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["9:16","16:9","21:9","1:1","4:3","3:4"],"default":"9:16"},"resolution":{"enum":["720p","480p"],"default":"720p"},"duration":{"enum":["15"],"default":"15"},"mode":{"enum":["reference","first-frame","first-last","text-to-video"],"default":"first-frame"},"images":{"max_items":9,"max_items_by_mode":{"first-frame":9,"first-last":9,"reference":9,"text-to-video":0}},"videos":{"max_items":3,"max_items_by_mode":{"first-frame":0,"first-last":0,"reference":3,"text-to-video":0},"min_duration_sec":2,"max_total_duration_sec":15},"audios":{"max_items":3,"max_items_by_mode":{"first-frame":0,"first-last":0,"reference":3,"text-to-video":0},"min_duration_sec":1.8,"max_total_duration_sec":15},"quality":{"enum":["高清","快速","标准"],"default":"标准"}}},
  {"id":"deepseek-v4.1-flash","public_id":"deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","type":"chat","vision":true,"context":1048576,"params":{}},
  {"id":"seedance-2-0-manju-special","public_id":"seedance-2-0-manju-special","name":"Seedance 2.0 · 漫剧特价","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["16:9","9:16","1:1","4:3","3:4"],"default":"16:9"},"resolution":{"enum":["720p"],"default":"720p"},"duration":{"enum":["5","10","15"],"default":"15"},"mode":{"enum":["text-to-video","first-frame","first-last","reference"],"default":"first-frame"},"images":{"max_items":9,"max_items_by_mode":{"first-frame":9,"first-last":9,"reference":9,"text-to-video":0}}}},
  {"id":"claude-opus-5-5","public_id":"cl-opus-5-5","name":"CL Opus 5.5","type":"chat","vision":true,"context":1000000,"params":{}},
  {"id":"gemini-3.8-flash","public_id":"gm-3.8-flash","name":"GM-3.8 Flash","type":"chat","vision":true,"context":1048576,"params":{}},
  {"id":"gpt-image-2.5-sunburst","public_id":"gt-image-2.5-sunburst","name":"GT Image 2.5 Sunb","type":"image","params":{"aspect_ratio":{"enum":["1:1","auto","3:2","2:3","4:3","3:4","5:4","4:5","16:9","9:16","21:9","9:21"],"default":"1:1"},"resolution":{"enum":["1K","2K","4K"],"default":"4K"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":16},"quality":{"enum":["low","medium","high","xhigh","max"],"default":"medium"},"background":{"enum":["opaque","transparent"],"default":"opaque"}}},
  {"id":"gpt-image-2.5-flare","public_id":"gt-image-2.5-flare","name":"GT Image 2.5 Flare","type":"image","params":{"aspect_ratio":{"enum":["1:1","auto","3:2","2:3","4:3","3:4","5:4","4:5","16:9","9:16","21:9","9:21"],"default":"1:1"},"resolution":{"enum":["1K","2K","4K"],"default":"4K"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":17},"quality":{"enum":["low","medium","high","xhigh","max"],"default":"medium"},"background":{"enum":["opaque","transparent"],"default":"opaque"}}},
  {"id":"doubao-seedream-5-0-pro","public_id":"doubao-seedream-5-0-pro","name":"Doubao Seedream 5.0 Pro","type":"image","params":{"resolution":{"enum":["1k","2k"],"default":"2k"},"size":{"enum":["1:1","4:3","3:4","16:9","9:16","3:2","2:3","21:9","auto"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":10}}},
  {"id":"gpt-image-2","public_id":"gt-image-2","name":"GT Image 2","type":"image","params":{"aspect_ratio":{"enum":["1:1","auto","3:2","2:3","4:3","3:4","5:4","4:5","16:9","9:16","21:9","9:21"],"default":"1:1"},"resolution":{"enum":["1K","2K","4K"],"default":"4K"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":16},"quality":{"enum":["auto","high","medium","low"],"default":"high"}}},
  {"id":"gemini-3.1-flash-image","public_id":"gm-3.1-flash-image","name":"GM-3.1 Flash Image","type":"image","params":{"aspect_ratio":{"enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9","auto","1:4","4:1","1:8","8:1"],"default":"1:1"},"size":{"enum":["0.5K","1K","2K","4K"],"default":"1K"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":14}}},
  {"id":"gemini-3-pro-image","public_id":"gm-3-pro-image","name":"GM-3 Pro Image","type":"image","params":{"aspect_ratio":{"enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9","auto"],"default":"1:1"},"size":{"enum":["1K","2K","4K"],"default":"1K"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":14}}},
  {"id":"doubao-seedream-5-0","public_id":"doubao-seedream-5-0","name":"Doubao Seedream 5.0","type":"image","params":{"resolution":{"enum":["2k","4k"],"default":"2k"},"size":{"enum":["1:1","4:3","3:4","16:9","9:16","3:2","2:3","21:9","5:4","4:5","2:1","1:2","9:21"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":10}}},
  {"id":"seedance-2-0-ecom-special","public_id":"seedance-2-0-ecom-special","name":"Seedance 2.0 · 电商特价","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["9:16","16:9","1:1"],"default":"9:16"},"duration":{"enum":["5","10","15"],"default":"5"},"mode":{"enum":["reference","text-to-video"],"default":"reference"},"images":{"max_items":9,"max_items_by_mode":{"reference":9,"text-to-video":0}},"quality":{"enum":["标准","真人模特","满血9图"],"default":"满血9图"}}},
  {"id":"kling-v4","public_id":"kling-v4","name":"Kling 4.0","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16","1:1","21:9"],"default":"16:9"},"resolution":{"enum":["720p","1080p"],"default":"720p"},"duration":{"enum":["3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"],"default":"5"},"mode":{"enum":["text-to-video","reference"],"default":"reference"},"images":{"max_items":10,"max_items_by_mode":{"reference":10,"text-to-video":0}},"videos":{"max_items":1,"max_items_by_mode":{"reference":1,"text-to-video":0}},"audios":{"max_items":1,"max_items_by_mode":{"reference":1,"text-to-video":0}}}},
  {"id":"wan-3-0","public_id":"wan-3-0","name":"Wan 3.0","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["16:9","9:16","3:4","4:3","1:1"],"default":"16:9"},"resolution":{"enum":["480p","720p","1080p"],"default":"480p"},"duration":{"enum":["5","6","7","8","9","10","11","12","13","14","15","20","25","30","4","16","17","18","19","21","22","23","24","26","27","28","29"],"default":"4"},"mode":{"enum":["text-to-video","first-frame","reference"],"default":"text-to-video"},"images":{"max_items":10,"max_items_by_mode":{"first-frame":10,"reference":10,"text-to-video":0}},"videos":{"max_items":5,"max_items_by_mode":{"first-frame":0,"reference":5,"text-to-video":0},"max_total_duration_sec":15},"audios":{"max_items":5,"max_items_by_mode":{"first-frame":0,"reference":5,"text-to-video":0},"max_total_duration_sec":15}}},
  {"id":"minimax-h3","public_id":"minimax-h3","name":"MiniMax H3","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["16:9","9:16","21:9","4:3","1:1","3:4"],"default":"16:9","available_when":{"mode":["text-to-video","reference"]}},"resolution":{"enum":["768p","2k"],"default":"2k"},"duration":{"enum":["4","5","6","7","8","9","10","11","12","13","14","15"],"default":"4"},"mode":{"enum":["text-to-video","first-frame","first-last","reference"],"default":"first-frame"},"images":{"max_items":9,"max_items_by_mode":{"first-frame":9,"first-last":9,"reference":9,"text-to-video":0}},"videos":{"max_items":3,"max_items_by_mode":{"first-frame":0,"first-last":0,"reference":3,"text-to-video":0},"min_duration_sec":2,"max_total_duration_sec":15},"audios":{"max_items":3,"max_items_by_mode":{"first-frame":0,"first-last":0,"reference":3,"text-to-video":0},"min_duration_sec":2,"max_total_duration_sec":15}}},
  {"id":"veo-3-1-manju-special","public_id":"vo-3-1-manju-special","name":"VO-3.1 · 漫剧特价","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["16:9","9:16"],"default":"16:9"},"resolution":{"enum":["720p"],"default":"720p"},"duration":{"enum":["8"],"default":"8"},"mode":{"enum":["text-to-video","first-frame","first-last","reference"],"default":"first-frame"},"images":{"max_items":2,"max_items_by_mode":{"first-frame":2,"first-last":2,"reference":2,"text-to-video":0}}}},
  {"id":"grok-4.7","public_id":"gk-4.7","name":"GK-4.7","type":"chat","vision":true,"context":500000,"params":{}},
  {"id":"gpt-6.1-sol","public_id":"gt-6.1-sol","name":"GT-6.1 Sol","type":"chat","vision":true,"context":1050000,"params":{}},
  {"id":"gemini-4-argon","public_id":"gm-4-argon","name":"GM-4 Argon","type":"chat","vision":true,"context":1048576,"params":{}},
  {"id":"wan-3-0-special","public_id":"wan-3-0-special","name":"Wan 3.0 · 特价按次","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["16:9","9:16"],"default":"16:9"},"resolution":{"enum":["720p","1080p"],"default":"1080p"},"duration":{"enum":["30","25","20","15","10","5"],"default":"30"},"mode":{"enum":["reference","first-frame","text-to-video"],"default":"reference"},"images":{"max_items":9,"max_items_by_mode":{"first-frame":9,"reference":9,"text-to-video":0}},"videos":{"max_items":3,"max_items_by_mode":{"first-frame":0,"reference":3,"text-to-video":0},"max_total_duration_sec":15}}},
  {"id":"qwen3.8-flash","public_id":"qwen3.8-flash","name":"Qwen3.8-Flash","type":"chat","vision":true,"context":1000000,"params":{}},
  {"id":"glm-5.3-flash","public_id":"glm-5.3-flash","name":"GLM-5.3 Flash","type":"chat","vision":true,"context":200000,"params":{}},
  {"id":"pixverse-c1","public_id":"pixverse-c1","name":"PixVerse C1 · 过人脸","type":"video","params":{"aspect_ratio":{"enum":["9:16","16:9"],"default":"9:16"},"resolution":{"enum":["720p","1080p"],"default":"720p"},"duration":{"enum":["5","8"],"default":"5"},"mode":{"enum":["first-frame","text-to-video"],"default":"first-frame"},"images":{"max_items":1,"max_items_by_mode":{"first-frame":1,"text-to-video":0}}}},
  {"id":"sora-2-official","public_id":"sr-2-official","name":"SR-2 官方无水印","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16"],"default":"9:16"},"duration":{"enum":["4","8","12"],"default":"4"},"mode":{"enum":["text-to-video","first-frame"],"default":"text-to-video"},"images":{"max_items":1}}},
  {"id":"omni-flash-1-1","public_id":"omni-flash-1-1","name":"Omni Flash 1.1","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16"],"default":"16:9"},"resolution":{"enum":["720p","1080p"],"default":"720p"},"duration":{"enum":["10"],"default":"10"},"mode":{"enum":["text-to-video","first-frame","first-last","reference"],"default":"first-frame"},"images":{"max_items":7,"max_items_by_mode":{"first-frame":7,"first-last":7,"reference":7,"text-to-video":0}}}},
  {"id":"veo-4-omni","public_id":"vo-4-omni","name":"VO-4 Omni","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16"],"default":"16:9","available_when":{"mode":["text-to-video","first-frame","first-last","reference"]}},"resolution":{"enum":["720p","1080p"],"default":"720p","available_when":{"mode":["text-to-video","first-frame","first-last","reference"]}},"duration":{"enum":["4","6","8","10","3","5","7","9"],"default":"3","available_when":{"mode":["text-to-video","first-frame","first-last","reference"]}},"mode":{"enum":["text-to-video","first-frame","first-last","reference","extend"],"default":"first-frame"},"images":{"max_items":7,"max_items_by_mode":{"extend":0,"first-frame":7,"first-last":7,"reference":7,"text-to-video":0}},"videos":{"max_items":1,"max_items_by_mode":{"extend":1,"first-frame":0,"first-last":0,"reference":0,"text-to-video":0},"max_total_duration_sec":12}}},
  {"id":"veo-3.1","public_id":"vo-3.1","name":"VO-3.1","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["9:16","16:9"],"default":"16:9"},"resolution":{"enum":["720p","1080p"],"default":"720p"},"duration":{"enum":["8"],"default":"8"},"mode":{"enum":["text-to-video","first-frame","first-last","reference"],"default":"first-frame"},"images":{"max_items":3,"max_items_by_mode":{"first-frame":3,"first-last":3,"reference":3,"text-to-video":0}},"quality":{"enum":["经济","快速","高质量"],"default":"快速"}}},
  {"id":"seedance-2-0-9tu-special","public_id":"seedance-2-0-9tu-special","name":"Seedance 2.0 · 九图特价","type":"video","exclusive":true,"params":{"aspect_ratio":{"enum":["9:16","16:9"],"default":"9:16"},"resolution":{"enum":["720p","480p"],"default":"720p"},"duration":{"enum":["15","10","5"],"default":"15"},"mode":{"enum":["text-to-video","reference","first-frame"],"default":"reference"},"images":{"max_items":9,"max_items_by_mode":{"first-frame":9,"reference":9,"text-to-video":0}},"quality":{"enum":["Fast","标准"],"default":"Fast"}}},
  {"id":"grok-imagine-1-5-7tu-special","public_id":"gk-imagine-1-5-7tu-special","name":"GK Imagine 1.5 Pro","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16","1:1","4:3","3:4","3:2","2:3"],"default":"16:9"},"resolution":{"enum":["480p","720p"],"default":"480p"},"duration":{"enum":["3","5","6","8","10","12","15"],"default":"3"},"mode":{"enum":["text-to-video","first-frame","reference","first-last"],"default":"reference"},"images":{"max_items":14,"max_items_by_mode":{"first-frame":14,"first-last":2,"reference":14,"text-to-video":0}}}},
  {"id":"grok-imagine-1.5","public_id":"gk-imagine-1.5","name":"GK Imagine 1.5","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16","1:1"],"default":"16:9"},"resolution":{"enum":["720p","480p","1080p"],"default":"480p"},"duration":{"enum":["6","10","15","20","30","4","8","12"],"default":"4"},"mode":{"enum":["text-to-video","first-frame","reference","first-last"],"default":"first-frame"},"images":{"max_items":7,"max_items_by_mode":{"first-frame":7,"first-last":2,"reference":7,"text-to-video":0}}}},
  {"id":"grok-imagine-video","public_id":"gk-imagine-video","name":"GK Imagine 1.0","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16","1:1","4:3","3:4"],"default":"16:9","available_when":{"mode":["text-to-video","first-frame","reference"]}},"resolution":{"enum":["720p","480p"],"default":"480p","available_when":{"mode":["text-to-video","first-frame","reference"]}},"duration":{"enum":["6","10","15","20","30","3","4","5","8","12"],"default":"3"},"mode":{"enum":["text-to-video","first-frame","reference","extend"],"default":"first-frame"},"images":{"max_items":7,"max_items_by_mode":{"extend":0,"first-frame":7,"reference":7,"text-to-video":0}},"videos":{"max_items":1,"max_items_by_mode":{"extend":1,"first-frame":0,"reference":0,"text-to-video":0},"min_duration_sec":2,"max_total_duration_sec":15}}},
  {"id":"kling-v3","public_id":"kling-v3","name":"Kling V3","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16","1:1"],"default":"16:9"},"resolution":{"enum":["720p","1080p"],"default":"720p"},"duration":{"enum":["5","10","15"],"default":"5"},"mode":{"enum":["text-to-video","first-frame","first-last"],"default":"first-frame"},"images":{"max_items":2,"max_items_by_mode":{"first-frame":2,"first-last":2,"text-to-video":0}},"generate_audio":{"default":true}}},
  {"id":"kling-3.0-turbo","public_id":"kling-3.0-turbo","name":"Kling 3.0 Turbo","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16"],"default":"16:9"},"resolution":{"enum":["720p"],"default":"720p"},"duration":{"enum":["3","5","8","10","15"],"default":"3"},"mode":{"enum":["text-to-video","first-frame"],"default":"first-frame"},"images":{"max_items":1,"max_items_by_mode":{"first-frame":1,"text-to-video":0}},"generate_audio":{"default":false}}},
  {"id":"pixverse-v6","public_id":"pixverse-v6","name":"PixVerse V6","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16","1:1"],"default":"16:9"},"resolution":{"enum":["720p","1080p"],"default":"720p"},"duration":{"enum":["5","8"],"default":"5"},"mode":{"enum":["text-to-video","first-frame"],"default":"first-frame"},"images":{"max_items":1,"max_items_by_mode":{"first-frame":1,"text-to-video":0}}}},
  {"id":"happyhorse-1-1","public_id":"happyhorse-1-1","name":"HappyHorse 1.1","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16","1:1","4:3","3:4","4:5","5:4","9:21","21:9"],"default":"16:9"},"resolution":{"enum":["1080p","720p"],"default":"720p"},"duration":{"enum":["3","5","10","15"],"default":"3"},"mode":{"enum":["text-to-video","first-frame","reference"],"default":"first-frame"},"images":{"max_items":9,"max_items_by_mode":{"first-frame":5,"reference":5,"text-to-video":0}}}},
  {"id":"viduq3","public_id":"viduq3","name":"Vidu Q3","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16","4:3","3:4","1:1"],"default":"16:9"},"resolution":{"enum":["540p","720p","1080p"],"default":"540p"},"duration":{"enum":["5","4","8","12","16"],"default":"4"},"mode":{"enum":["text-to-video","first-frame","first-last","reference"],"default":"first-frame"},"images":{"max_items":7,"max_items_by_mode":{"first-frame":7,"first-last":7,"reference":7,"text-to-video":0}},"model_variant":{"enum":["turbo","pro"],"default":"turbo"},"tier":{"enum":["turbo","pro","mix"],"default":"pro"}}},
  {"id":"qwen-image-3.0","public_id":"qwen-image-3.0","name":"Qwen Image 3.0","type":"image","params":{"resolution":{"enum":["1K","2K"],"default":"2K"},"size":{"enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":3},"quality":{"enum":["标准","pro"],"default":"标准"}}},
  {"id":"gpt-image-2-official","public_id":"gt-image-2-official","name":"GT Image 2 Official","type":"image","params":{"resolution":{"enum":["1k","2k","4k"],"default":"1k"},"size":{"enum":["1:1","3:2","2:3","4:3","3:4","5:4","4:5","16:9","9:16","2:1","1:2","3:1","1:3","21:9","9:21","auto"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":16},"quality":{"enum":["low","medium","high"],"default":"low"}}},
  {"id":"gpt-image-1.5-all","public_id":"gt-image-1.5-all","name":"GT Image 1.5","type":"image","params":{"size":{"enum":["1024x1024","1536x1024","1024x1536"],"default":"1024x1024"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":10}}},
  {"id":"doubao-seedream-4-5","public_id":"doubao-seedream-4-5","name":"Doubao Seedream 4.5","type":"image","params":{"resolution":{"enum":["2k","4k","1k"],"default":"2k"},"size":{"enum":["1:1","4:3","3:4","16:9","9:16","3:2","2:3","21:9","5:4","4:5","2:1","1:2","3:1","1:3","9:21"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":4}}},
  {"id":"qwen-image-2.0","public_id":"qwen-image-2.0","name":"Qwen Image 2.0","type":"image","params":{"resolution":{"enum":["1k","2k"],"default":"2k"},"size":{"enum":["1:1","3:2","2:3","4:3","3:4","16:9","9:16"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":6}}},
  {"id":"wan2.7-image","public_id":"wan2.7-image","name":"Wan 2.7 Image","type":"image","params":{"resolution":{"enum":["1k","2k"],"default":"1k"},"size":{"enum":["1:1","3:2","2:3","4:3","3:4","5:4","4:5","16:9","9:16","2:1","1:2","3:1","1:3","21:9","9:21","auto"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":3},"quality":{"enum":["standard","pro"],"default":"standard"}}},
  {"id":"grok-imagine-image","public_id":"gk-imagine-image","name":"GK Imagine 1.0 Image","type":"image","params":{"size":{"enum":["1:1","16:9","9:16","3:2","2:3","4:3","3:4"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":7}}},
  {"id":"minimax-hailuo-2-3","public_id":"minimax-hailuo-2-3","name":"MiniMax Hailuo 2.3","type":"video","params":{"resolution":{"enum":["768p","1080p"],"default":"768p"},"duration":{"enum":["6","10"],"default":"6"},"mode":{"enum":["text-to-video","first-frame"],"default":"first-frame"},"images":{"max_items":1,"max_items_by_mode":{"first-frame":1,"text-to-video":0}}}},
  {"id":"wan2.7-video","public_id":"wan2.7-video","name":"Wan 2.7 Video","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16","1:1","4:3","3:4"],"default":"16:9"},"resolution":{"enum":["720p","1080p"],"default":"720p"},"duration":{"enum":["2","3","4","5","6","8","10","12","15"],"default":"2"},"mode":{"enum":["text-to-video","first-frame","first-last","continuation"],"default":"first-frame"},"images":{"max_items":2}}},
  {"id":"grok-imagine-video-special","public_id":"gk-imagine-video-special","name":"GK-1.0 多图 · 特价","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16"],"default":"16:9"},"resolution":{"enum":["720p"],"default":"720p"},"duration":{"enum":["6","10"],"default":"6"},"mode":{"enum":["text-to-video","first-frame","reference"],"default":"first-frame"},"images":{"max_items":7,"max_items_by_mode":{"first-frame":7,"reference":7,"text-to-video":0}}}},
  {"id":"grok-imagine-1.5-special","public_id":"gk-imagine-1.5-special","name":"GK-1.5 图生 · 特价","type":"video","params":{"aspect_ratio":{"enum":["16:9","9:16"],"default":"16:9"},"resolution":{"enum":["720p"],"default":"720p"},"duration":{"enum":["6","15"],"default":"15"},"images":{"max_items":1,"max_items_by_mode":{"first-frame":1,"reference":1,"text-to-video":0}}}},
  {"id":"gemini-3.1-flash-lite-image","public_id":"gm-3.1-flash-lite-image","name":"GM-3.1 Flash Lite Image","type":"image","params":{"aspect_ratio":{"enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"1:1"},"size":{"enum":["1K"],"default":"1K"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":14}}},
  {"id":"flux-2","public_id":"fx-2","name":"FX-2.0 Pro","type":"image","params":{"size":{"enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","21:9"],"default":"1:1"},"mode":{"enum":["text-to-image","multi-reference"],"default":"text-to-image"},"images":{"max_items":8}}},
  {"id":"flux-kontext","public_id":"fx-kontext","name":"FX Kontext","type":"image","params":{"size":{"enum":["1:1","16:9","9:16","4:3","3:4"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":4},"quality":{"enum":["pro","max"],"default":"pro"}}},
  {"id":"gpt-image-2-c","public_id":"gt-image-2-c","name":"GT Image 2 C","type":"image","params":{"size":{"enum":["1024x1024","1792x1024","1024x1792"],"default":"1024x1024"},"mode":{"enum":["text-to-image","image-edit"],"default":"text-to-image"},"images":{"max_items":1},"quality":{"enum":["auto","high","medium","low"],"default":"high"}}},
  {"id":"flux-3","public_id":"fx-3","name":"FX-3","type":"image","params":{"resolution":{"enum":["1k","2k","4k"],"default":"1k"},"size":{"enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","21:9","9:21","auto"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":10}}},
  {"id":"kling-image-o3","public_id":"kling-image-o3","name":"Kling Image O3","type":"image","params":{"aspect_ratio":{"enum":["1:1","9:16","16:9","4:3","3:4","3:2","2:3","21:9"],"default":"1:1"},"size":{"enum":["1K","2K","4K"],"default":"4K"},"mode":{"enum":["text-to-image","multi-reference","image-edit"],"default":"text-to-image"},"images":{"max_items":8}}},
  {"id":"grok-imagine-image-2.0","public_id":"gk-imagine-image-2.0","name":"GK Imagine 2.0 图像","type":"image","params":{"size":{"enum":["1:1","16:9","9:16","3:2","2:3","4:3","3:4"],"default":"1:1"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":5}}},
  {"id":"gemini-nano-banana-2.1-image","public_id":"gm-nano-banana-2.1-image","name":"GM NB 2.1 Image","type":"image","params":{"aspect_ratio":{"enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9","1:4","4:1","8:1"],"default":"1:1"},"size":{"enum":["1K","2K","4K"],"default":"4K"},"mode":{"enum":["text-to-image","image-edit","multi-reference"],"default":"text-to-image"},"images":{"max_items":14}}},
  {"id":"speech-2.8","public_id":"speech-2.8","name":"MiniMax Speech 2.8 (Voice Clone)","type":"audio","params":{"voice":{},"speed":{"enum":["0.5","0.75","1","1.25","1.5","2"],"default":"1"},"version":{"enum":["2.8","2.6"],"default":"2.8"}}},
  {"id":"music","public_id":"music","name":"Suno Music","type":"audio","params":{"title":{},"lyrics":{},"mode":{"enum":["song","instrumental"],"default":"song"},"version":{"enum":["chirp-v6","chirp-v6-mini","chirp-v5","chirp-v4-5"],"default":"chirp-v6"}}},
  {"id":"gemini-3.1-flash-tts","public_id":"gm-3.1-flash-tts","name":"GM-3.1 Flash TTS","type":"audio","params":{"voice":{"enum":["Zephyr","Puck","Charon","Kore","Fenrir","Leda","Orus","Aoede","Callirrhoe","Autonoe","Enceladus","Iapetus","Umbriel","Algieba","Despina","Erinome","Algenib","Rasalgethi","Laomedeia","Achernar","Alnilam","Schedar","Gacrux","Pulcherrima","Achird","Zubenelgenubi","Vindemiatrix","Sadachbia","Sadaltager","Sulafat"],"default":"Zephyr"},"response_format":{"enum":["wav"],"default":"wav"}}},
  {"id":"gemini-2.5-pro-tts","public_id":"gm-2.5-pro-tts","name":"GM-2.5 Pro TTS","type":"audio","params":{"voice":{"enum":["Zephyr","Puck","Charon","Kore","Fenrir","Leda","Orus","Aoede","Callirrhoe","Autonoe","Enceladus","Iapetus","Umbriel","Algieba","Despina","Erinome","Algenib","Rasalgethi","Laomedeia","Achernar","Alnilam","Schedar","Gacrux","Pulcherrima","Achird","Zubenelgenubi","Vindemiatrix","Sadachbia","Sadaltager","Sulafat"],"default":"Zephyr"},"response_format":{"enum":["wav"],"default":"wav"}}},
  {"id":"gpt-4o-mini-tts","public_id":"gt-4o-mini-tts","name":"GT-4o Mini TTS","type":"audio","params":{"voice":{"enum":["alloy","echo","fable","onyx","nova","shimmer"],"default":"alloy"},"response_format":{"enum":["mp3","opus","aac","flac","wav","pcm"],"default":"mp3"},"speed":{"default":"1.0"}}},
  {"id":"doubao-tts-2.0","public_id":"doubao-tts-2.0","name":"Doubao TTS 2.0","type":"audio","params":{"voice":{},"response_format":{"enum":["mp3","wav"],"default":"mp3"},"speed":{"enum":["0.5","0.75","1","1.25","1.5","2"],"default":"1"}}},
];

const SNAPSHOT_BY_ID = new Map(SNAPSHOT.flatMap((model) => [
  [model.id, model], [model.public_id, model],
] as const));

/** 仅列已审计的精确 internal ID；公开别名继续由原始快照解析。 */
const IMAGE_TEMPLATES: Partial<Record<string, ImageCapabilityTemplateId>> = {
  'gpt-image-2.5-sunburst': 'gpt-image-2.5', 'gpt-image-2.5-flare': 'gpt-image-2.5',
  'gpt-image-2': 'gpt-image-2', 'gpt-image-2-official': 'gpt-image-2',
  'gpt-image-1.5-all': 'gpt-image-1.5', 'gpt-image-2-c': 'gpt-image-2',
  'gemini-3.1-flash-image': 'nano-banana-2', 'gemini-3-pro-image': 'nano-banana-pro',
  'gemini-nano-banana-2.1-image': 'nano-banana-2.1',
  'doubao-seedream-4-5': 'seedream-4.5', 'doubao-seedream-5-0': 'seedream-5-lite',
  'doubao-seedream-5-0-pro': 'seedream-5-pro',
};
const VIDEO_TEMPLATES: Partial<Record<string, VideoCapabilityTemplateId>> = {
  'seedance-2-5': 'seedance-2.5', 'seedance-2-5-special': 'seedance-2.5',
  'seedance-2-5-promo': 'seedance-2.5',
  'seedance-2-0-official': 'seedance-2.0', 'seedance-2-0-promo': 'seedance-2.0',
  'seedance-2-0-special': 'seedance-2.0', 'seedance-2-0-manju-special': 'seedance-2.0',
  'seedance-2-0-ecom-special': 'seedance-2.0', 'seedance-2-0-9tu-special': 'seedance-2.0',
  'minimax-h3': 'minimax-h3',
};

/** 统一内部目录名；仅接受本批实际审计过的 internal/public 两种 ID。 */
export function resolveLibapiModelId(id: string): string | undefined {
  return SNAPSHOT_BY_ID.get(id)?.id;
}

function asyncProtocol(category: 'image' | 'video' | 'audio', params: Record<string, ProtocolJsonValue>, operation?: string): NormalizedModelExecutionProtocol {
  return {
    version: 2, mode: 'async', auth: { type: 'bearer' },
    submit: { method: 'POST', path: '/api/v1/model-runtime/invoke', pathMode: 'origin', bodyEncoding: 'json',
      body: { model_id: '{{model}}', modality: category, ...(operation ? { operation } : category === 'image' ? { operation: 'generate' } : {}), params } },
    response: { type: 'json', taskIdPath: 'task_id', errorPath: 'error.message' },
    poll: {
      method: 'GET', path: '/v1/tasks/{{submit.task_id}}', pathMode: 'origin', intervalMs: 3_000, maxDurationMs: 7_200_000,
      response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
        progressPath: 'progress', errorPath: 'error', result: { urlPath: 'output_url' } },
      retry: { httpStatuses: [408, 429, 500, 502, 503, 504], maxRetries: 3,
        backoff: 'exponential', maxDelayMs: 60_000, honorRetryAfter: true, retryNetworkErrors: true },
    },
  };
}

function enumOf(model: LibapiModelSnapshot, field: string): string[] | undefined {
  return model.params[field]?.enum ? [...model.params[field].enum!] : undefined;
}
function stringDefault(model: LibapiModelSnapshot, field: string): string | undefined {
  const value = model.params[field]?.default;
  return typeof value === 'string' ? value : undefined;
}
function isRatioField(values: readonly string[] | undefined): boolean {
  return Boolean(values?.some((value) => /^\d+:\d+$/.test(value)));
}
function isPixelField(values: readonly string[] | undefined): boolean {
  return Boolean(values?.some((value) => /^\d+x\d+$/.test(value)));
}
function pixelCapability(values: readonly string[]): Pick<ImageModelCapability, 'resolutions' | 'defaultResolution' | 'ratios' | 'defaultRatio' | 'dimensionPresets'> {
  const dimensions: Record<string, readonly [number, number]> = {};
  for (const value of values) {
    if (!/^\d+x\d+$/.test(value)) continue;
    const [width, height] = value.split('x').map(Number);
    const gcd = (left: number, right: number): number => right ? gcd(right, left % right) : left;
    const divisor = gcd(width, height);
    dimensions[`${width / divisor}:${height / divisor}`] = [width, height];
  }
  return { resolutions: ['1K'], defaultResolution: '1K', ratios: Object.keys(dimensions),
    defaultRatio: dimensions['1:1'] ? '1:1' : Object.keys(dimensions)[0],
    dimensionPresets: { '1K': dimensions } };
}

function imageModel(model: LibapiModelSnapshot): ProviderModelSelection {
  const size = enumOf(model, 'size');
  const pixels = isPixelField(size);
  const ratioField = model.params.aspect_ratio ? 'aspect_ratio' : isRatioField(size) ? 'size' : undefined;
  const resolutionField = model.params.resolution ? 'resolution' : size && !isRatioField(size) && !pixels ? 'size' : undefined;
  const capability: ImageModelCapability = {
    ...(pixels ? pixelCapability(size!) : {}),
    ...(ratioField ? { ratios: enumOf(model, ratioField), defaultRatio: stringDefault(model, ratioField) } : {}),
    ...(resolutionField ? { resolutions: enumOf(model, resolutionField), defaultResolution: stringDefault(model, resolutionField) } : {}),
    ...(model.params.quality ? { qualities: enumOf(model, 'quality'), defaultQuality: stringDefault(model, 'quality') } : {}),
    // 接口默认不主动发送 background；用户明确选择时才映射。
    ...(model.params.background ? { backgrounds: enumOf(model, 'background') } : {}),
    supportsBatch: false, maxBatchCount: 1, supportsImageReference: Boolean(model.params.images),
    maxImageReferences: model.params.images?.max_items, supportsDataUrlReference: false,
  };
  const params: Record<string, ProtocolJsonValue> = { prompt: '{{prompt}}', count: 1, images: '{{imageUrls}}' };
  if (ratioField) params[ratioField] = '{{aspectRatio}}';
  if (resolutionField) params[resolutionField] = '{{imageSize}}';
  if (pixels) params.size = '{{size}}';
  if (model.params.quality) params.quality = '{{imageQuality}}';
  if (model.params.background) Object.assign(params, { background: '{{imageBackground}}', output_format: 'png' });
  const template = IMAGE_TEMPLATES[model.id];
  return { id: model.public_id, name: model.name, provider: 'libapi', category: 'image',
    inputModalities: ['text', 'image'], imageCapability: template ? getImageCapabilityTemplate(template, {
      // 原合同没有的控件与像素表不得从官方默认值补齐。
      resolutions: undefined, defaultResolution: undefined, ratios: undefined, defaultRatio: undefined,
      qualities: undefined, defaultQuality: undefined, backgrounds: undefined, defaultBackground: undefined,
      dimensionPresets: undefined, ...capability,
    }) : capability,
    executionProfile: { preset: 'custom', protocol: asyncProtocol('image', params) } };
}

function videoModel(model: LibapiModelSnapshot): ProviderModelSelection {
  const modes = enumOf(model, 'mode') ?? [];
  const durations = enumOf(model, 'duration')?.map(Number).filter(Number.isFinite);
  const supportsReference = modes.includes('reference');
  const requiresReference = !modes.includes('text-to-video');
  const video = model.params.videos;
  const audio = model.params.audios;
  const maxVideos = supportsReference ? video?.max_items_by_mode?.reference ?? video?.max_items ?? 0 : 0;
  const constraints = (input: ParameterSnapshot | undefined) => input ? {
    ...(input.min_duration_sec !== undefined || input.max_duration_sec !== undefined
      ? { durationSeconds: { min: input.min_duration_sec, max: input.max_duration_sec } } : {}),
    ...(input.max_total_duration_sec !== undefined ? { totalDurationSeconds: { max: input.max_total_duration_sec } } : {}),
  } : undefined;
  const capability: VideoModelCapability = {
    operations: [...(!requiresReference ? ['text-to-video' as const] : []),
      ...(model.params.images || audio ? ['image-to-video' as const] : []),
      ...(maxVideos > 0 ? ['video-to-video' as const] : [])],
    requiresReference, resolutions: enumOf(model, 'resolution'), defaultResolution: stringDefault(model, 'resolution'),
    ratios: enumOf(model, 'aspect_ratio'), defaultRatio: stringDefault(model, 'aspect_ratio'),
    durations, defaultDuration: Number(model.params.duration?.default) || durations?.[0],
    supportsAudio: model.params.generate_audio ? true : undefined,
    // 只有该卡明确声明可以仅用音频驱动；有 audios 字段不等于允许纯音频。
    supportsStandaloneAudio: model.id === 'seedance-2-5',
    allowFrameAndReferenceMix: false,
    maxImageReferences: model.params.images?.max_items ?? 0,
    maxVideoReferences: maxVideos,
    maxAudioReferences: model.id === 'seedance-2-5-special' ? 0 : supportsReference ? audio?.max_items ?? 0 : 0,
    inputConstraints: { promptMinCharacters: 1, referenceVideo: constraints(video), referenceAudio: constraints(audio) },
  };
  // 官方单首帧/首尾帧的画幅受输入图决定，不能宣称输出比例独立可调。
  if (model.params.aspect_ratio?.available_when?.mode
    && !model.params.aspect_ratio.available_when.mode.includes('first-frame')) {
    capability.inputModeCapabilities = { keyframe: { requiresRatio: false } };
  }
  const params: Record<string, ProtocolJsonValue> = { prompt: '{{prompt}}', count: 1,
    images: '{{imageUrls}}', mode: '{{videoInputMode}}' };
  if (model.params.aspect_ratio) params.aspect_ratio = '{{aspectRatio}}';
  if (model.params.resolution) params.resolution = '{{seedanceResolution}}';
  if (model.params.duration) params.duration = '{{durationText}}';
  if (video && supportsReference) params.videos = '{{referenceVideoUrls}}';
  if (audio && supportsReference && model.id !== 'seedance-2-5-special') params.audios = '{{referenceAudioUrls}}';
  if (model.params.generate_audio) params.generate_audio = '{{generateAudio}}';
  // 无质量控件的现有视频参数面板沿用该卡的公开默认值，不伪造可调映射。
  for (const field of ['quality', 'model_variant', 'tier']) {
    if (field === 'model_variant' && model.params.tier) continue;
    const value = model.params[field]?.default;
    if (value !== undefined) params[field] = value;
  }
  const template = VIDEO_TEMPLATES[model.id];
  return { id: model.public_id, name: model.name, provider: 'libapi', category: 'video',
    inputModalities: ['text', 'image'], videoCapability: template ? getVideoCapabilityTemplate(template, {
      // 离散时长、生成音频和输入模式以本渠道快照为准，不继承官方额外能力。
      minDuration: undefined, maxDuration: undefined, automaticDurationValue: undefined,
      inputModeCapabilities: undefined, operationCapabilities: undefined, ...capability,
    }) : capability,
    executionProfile: { preset: 'custom', protocol: asyncProtocol('video', params) } };
}

/** 音频参数只存在于运行期精确合同，未知型号不借用同名厂商的音色或格式。 */
export function getLibapiAudioCapability(modelId: string): AudioModelCapability | undefined {
  const model = SNAPSHOT_BY_ID.get(modelId);
  if (model?.type !== 'audio') return undefined;
  if (model.id === 'music') return { kind: 'music', supportsVoiceReference: false,
    musicControls: { title: true, lyrics: true, bpm: false, duration: false, autoGenerateLyrics: false } };
  const voices = enumOf(model, 'voice');
  // 原始 PCM 的采样率、声道和位深尚无合同，不当作可播放的容器格式开放。
  const formats = enumOf(model, 'response_format')?.filter((format) => format !== 'pcm') as AudioOutputFormat[] | undefined;
  const speedOptions = enumOf(model, 'speed')?.map(Number);
  return { kind: 'speech', supportsVoiceReference: false,
    voiceInput: voices?.length ? 'select' : 'id', voices, defaultVoice: stringDefault(model, 'voice'),
    formats, defaultFormat: stringDefault(model, 'response_format') as AudioOutputFormat | undefined,
    ...(model.params.speed ? { speed: model.id === 'gpt-4o-mini-tts'
      ? { min: 0.25, max: 4, step: 0.25, default: 1 }
      : { min: 0.5, max: 2, step: 0.25, options: speedOptions, default: Number(model.params.speed.default) } } : {}),
  };
}

function audioModel(model: LibapiModelSnapshot): ProviderModelSelection {
  const capability = getLibapiAudioCapability(model.id)!;
  const params: Record<string, ProtocolJsonValue> = capability.kind === 'music'
    ? { prompt: '{{prompt}}', title: '{{musicTitle}}', lyrics: '{{musicLyrics}}' }
    : { input: '{{prompt}}', voice: '{{audioVoice}}',
      ...(capability.formats?.length ? { response_format: '{{audioFormat}}' } : {}),
      ...(capability.speed ? { speed: '{{audioSpeed}}' } : {}) };
  return { id: model.public_id, name: model.name, provider: 'libapi', category: 'audio', inputModalities: ['text'],
    description: capability.kind === 'music' ? '普通音乐生成；可填标题和歌词，不支持直接引用素材、续写或翻唱'
      : capability.voiceInput === 'id' ? '语音合成；请填写平台已有音色 ID，不会自动上传参考音频克隆声音' : '语音合成；使用该型号已公布的预置音色',
    executionProfile: { preset: 'custom', protocol: asyncProtocol('audio', params, capability.kind === 'music' ? 'generate' : 'speech') } };
}

export const LIBAPI_MODEL_MANIFEST: readonly ProviderModelSelection[] = SNAPSHOT.map((model): ProviderModelSelection => (
  model.type === 'chat' ? { id: model.public_id, name: model.name, provider: 'libapi', category: 'text',
    inputModalities: model.vision ? ['text', 'image'] : ['text'], contextWindow: model.context,
    executionProfile: { preset: 'openai-chat' } } : model.type === 'image' ? imageModel(model)
    : model.type === 'video' ? videoModel(model) : audioModel(model)
));
const MODEL_BY_ID = new Map(LIBAPI_MODEL_MANIFEST.map((model) => [model.id, model]));

/** 只有完整命中内置合同，执行层才可做厂商字段转换；用户改过的协议原样保留。 */
export function usesLibapiModelProtocol(modelId: string, profile?: ModelExecutionProfile): boolean {
  const snapshot = SNAPSHOT_BY_ID.get(modelId);
  const known = snapshot && MODEL_BY_ID.get(snapshot.public_id);
  if (!known || known.category === 'text') return false;
  const actual = comparableProtocol(profile);
  return actual !== undefined && actual === comparableProtocol(known.executionProfile);
}

/** 保留认证目录实际返回的请求 ID 和连接身份，内部名/公开别名不重复列出。 */
export function matchLibapiCatalog(models: readonly ProviderModelSelection[]): ProviderModelSelection[] {
  const seen = new Set<string>();
  return models.flatMap((remote) => {
    const snapshot = SNAPSHOT_BY_ID.get(remote.id);
    const known = snapshot && MODEL_BY_ID.get(snapshot.public_id);
    if (!known || seen.has(snapshot!.id)) return [];
    seen.add(snapshot!.id);
    return [{ ...remote, ...structuredClone(known), id: remote.id, provider: remote.provider }];
  });
}

function requireSnapshot(id: string, category: LibapiModelSnapshot['type']): LibapiModelSnapshot {
  const model = SNAPSHOT_BY_ID.get(id);
  if (!model || model.type !== category) throw new Error(`LIBAPI 模型“${id}”尚未适配此类调用`);
  return model;
}
function canonicalEnum(model: LibapiModelSnapshot, field: string, value: ProtocolJsonValue | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const options = model.params[field]?.enum;
  if (!options) return typeof value === 'string' ? value : undefined;
  const matched = typeof value === 'string' ? options.find((option) => option.toLowerCase() === value.toLowerCase()) : undefined;
  if (!matched) throw new Error(`LIBAPI 模型“${model.public_id}”的 ${field} 不支持“${String(value)}”`);
  return matched;
}

export function assertLibapiImageInput(modelId: string, referenceCount: number, count: number): void {
  const model = requireSnapshot(modelId, 'image');
  if (count !== 1) throw new Error('LIBAPI 每个异步图片任务仅提交 1 张，请使用应用批量生成');
  if (referenceCount > (model.params.images?.max_items ?? 0)) {
    throw new Error(`LIBAPI 模型“${modelId}”最多接受 ${model.params.images?.max_items ?? 0} 张参考图，当前为 ${referenceCount} 张`);
  }
}

/** 每次执行只修改临时副本的生成模式，不往普通模型增加可信变量或覆盖用户保存的协议。 */
export function libapiImageExecutionProfile(modelId: string, referenceCount: number): ModelExecutionProfile {
  const snapshot = requireSnapshot(modelId, 'image');
  assertLibapiImageInput(modelId, referenceCount, 1);
  const modes = snapshot.params.mode?.enum ?? [];
  const desired = referenceCount === 0 ? 'text-to-image'
    : referenceCount === 1 && modes.includes('image-edit') ? 'image-edit' : 'multi-reference';
  if (!modes.includes(desired)) throw new Error(`LIBAPI 模型“${modelId}”不支持 ${desired}，请调整参考图片数量`);
  const profile = structuredClone(MODEL_BY_ID.get(snapshot.public_id)!.executionProfile!);
  const body = profile.protocol!.submit.body as Record<string, ProtocolJsonValue>;
  const params = body.params as Record<string, ProtocolJsonValue>;
  params.mode = desired;
  return profile;
}

/** 只归一化已公布字段的大小写，不把非法选项替换成另一个付费档位。 */
export function libapiImageVariables(modelId: string, variables: ModelProtocolVariables): ModelProtocolVariables {
  const model = requireSnapshot(modelId, 'image');
  const size = model.params.size?.enum;
  const ratioField = model.params.aspect_ratio ? 'aspect_ratio' : isRatioField(size) ? 'size' : undefined;
  const resolutionField = model.params.resolution ? 'resolution' : size && !isRatioField(size) && !isPixelField(size) ? 'size' : undefined;
  return { ...variables,
    ...(ratioField ? { aspectRatio: canonicalEnum(model, ratioField, variables.aspectRatio) } : {}),
    ...(resolutionField ? { imageSize: canonicalEnum(model, resolutionField, variables.imageSize) } : {}),
    ...(isPixelField(size) ? { size: canonicalEnum(model, 'size', variables.size) } : {}),
    ...(model.params.quality ? { imageQuality: canonicalEnum(model, 'quality', variables.imageQuality) } : {}),
    ...(model.params.background ? { imageBackground: canonicalEnum(model, 'background', variables.imageBackground) } : {}),
  };
}

function videoMode(request: CanonicalVideoRequest): string {
  const { images, videos, audios } = request.references;
  if (images.some((reference) => reference.role === 'last_frame')) return 'first-last';
  if (images.some((reference) => reference.role === 'first_frame')) return 'first-frame';
  return images.length || videos.length || audios.length ? 'reference' : 'text-to-video';
}

/** 在上传与付费提交之前校验角色和已审计模式，禁止静默截断素材或改成视频编辑。 */
export function assertLibapiVideoInput(request: CanonicalVideoRequest): void {
  const model = requireSnapshot(request.modelId, 'video');
  const { images, videos, audios } = request.references;
  const first = images.filter((reference) => reference.role === 'first_frame');
  const last = images.filter((reference) => reference.role === 'last_frame');
  const ordinary = images.filter((reference) => reference.role === 'reference');
  const fail = (reason: string): never => { throw new Error(`LIBAPI 模型“${request.modelId}”：${reason}。本次尚未提交生成请求`); };
  if (first.length > 1 || last.length > 1) fail('首帧和尾帧各只能设置一张');
  if (last.length && !first.length) fail('尾帧必须与首帧一起设置');
  if ((first.length || last.length) && (ordinary.length || videos.length || audios.length)) fail('首尾帧不能与普通参考图、视频或音频混用');
  if (audios.length && !images.length && !videos.length && model.id !== 'seedance-2-5') fail('参考音频需搭配参考图或参考视频，不能单独使用');
  if (audios.length && model.id === 'seedance-2-0-official' && !images.length) fail('该型号的参考音频需搭配至少一张主图');
  const mode = videoMode(request);
  const modes = model.params.mode?.enum;
  // gk-imagine-1.5-special 没有 mode 字段，是明确的单首帧图生视频卡。
  if (!modes && model.id === 'grok-imagine-1.5-special') {
    if (mode !== 'first-frame') fail('该型号仅支持首帧图生视频，请设置一张首帧');
  } else if (!modes?.includes(mode)) fail(`不支持 ${mode} 输入模式，请调整参考素材角色`);
  for (const [field, values] of [['images', images], ['videos', videos], ['audios', audios]] as const) {
    const schema = model.params[field];
    const limit = field === 'audios' && model.id === 'seedance-2-5-special' ? 0
      : schema?.max_items_by_mode?.[mode] ?? schema?.max_items ?? 0;
    if (values.length > limit) fail(`${mode} 模式最多接受 ${limit} 个 ${field}，当前为 ${values.length} 个`);
  }
  if (request.output.candidateCount !== 1) fail('每个异步任务只提交一个结果');
  if (!request.prompt.trim()) fail('提示词不能为空');
  canonicalEnum(model, 'duration', String(request.output.durationSeconds));
  if (model.params.resolution && request.output.resolutionPreset) canonicalEnum(model, 'resolution', request.output.resolutionPreset);
}

export function libapiVideoVariables(request: CanonicalVideoRequest, variables: ModelProtocolVariables): ModelProtocolVariables {
  assertLibapiVideoInput(request);
  const model = requireSnapshot(request.modelId, 'video');
  const mode = videoMode(request);
  const images = [...request.references.images.filter((reference) => reference.role === 'first_frame'),
    ...request.references.images.filter((reference) => reference.role === 'last_frame'),
    ...request.references.images.filter((reference) => reference.role === 'reference')].map((reference) => reference.url);
  const ratioModes = model.params.aspect_ratio?.available_when?.mode;
  return { ...variables, imageUrls: images, videoInputMode: model.params.mode ? mode : undefined,
    durationText: model.params.duration ? String(request.output.durationSeconds) : undefined,
    aspectRatio: ratioModes && !ratioModes.includes(mode) ? undefined : variables.aspectRatio,
    ...(model.params.resolution ? { seedanceResolution: canonicalEnum(model, 'resolution', request.output.resolutionPreset ?? undefined) } : {}),
  };
}

function hasAudioParameter(value: ProtocolJsonValue | undefined): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** 付费提交前严格校验；不能把不支持的用户选择静默丢掉或替换为另一计费档位。 */
export function libapiAudioVariables(modelId: string, variables: ModelProtocolVariables): ModelProtocolVariables {
  const model = requireSnapshot(modelId, 'audio');
  const capability = getLibapiAudioCapability(model.id)!;
  const fail = (reason: string): never => { throw new Error(`LIBAPI 模型“${modelId}”：${reason}。本次尚未提交生成请求`); };
  if (typeof variables.prompt !== 'string' || !variables.prompt.trim()) fail('生成内容不能为空');
  for (const name of ['n', 'batchCount']) {
    if (hasAudioParameter(variables[name]) && variables[name] !== 1) fail('每次只提交一个音频任务');
  }
  if (capability.kind === 'music') {
    for (const name of ['audioVoice', 'audioFormat', 'audioSpeed', 'musicBpm', 'duration']) {
      if (hasAudioParameter(variables[name])) fail(`普通音乐生成未公布 ${name} 参数，请清除该设置`);
    }
    for (const name of ['musicTitle', 'musicLyrics']) {
      if (hasAudioParameter(variables[name]) && typeof variables[name] !== 'string') fail(`${name} 必须为文本`);
    }
    return { ...variables };
  }
  for (const name of ['musicTitle', 'musicLyrics', 'musicBpm', 'duration']) {
    if (hasAudioParameter(variables[name])) fail(`语音合成不支持 ${name} 参数，请清除该设置`);
  }
  const voiceValue = variables.audioVoice === undefined ? capability.defaultVoice : variables.audioVoice;
  if (typeof voiceValue !== 'string' || !voiceValue.trim()) return fail('请先填写或选择该平台已存在的音色 ID');
  if (Array.from(voiceValue).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code >= 127 && code <= 159;
  })) fail('音色 ID 不能包含控制字符');
  const voice = voiceValue.trim();
  if (voice.length > 256) fail('音色 ID 最多 256 个字符');
  if (capability.voiceInput === 'select' && !capability.voices?.includes(voice)) fail(`音色“${voice}”不在该型号的预置列表中`);
  const result: ModelProtocolVariables = { ...variables, audioVoice: voice };
  if (!capability.formats) {
    if (hasAudioParameter(variables.audioFormat)) fail('该型号未公布可选输出格式，请使用接口默认');
    result.audioFormat = undefined;
  } else {
    const formatValue = variables.audioFormat === undefined ? capability.defaultFormat : variables.audioFormat;
    if (typeof formatValue !== 'string' || !capability.formats.includes(formatValue as AudioOutputFormat)) fail('该型号不支持所选输出格式');
    result.audioFormat = formatValue;
  }
  if (!capability.speed) {
    if (hasAudioParameter(variables.audioSpeed)) fail('该型号未公布速度倍率，请使用接口默认');
    result.audioSpeed = undefined;
  } else {
    const speed = variables.audioSpeed === undefined ? capability.speed.default : variables.audioSpeed;
    if (typeof speed !== 'number' || !Number.isFinite(speed)
      || speed < capability.speed.min || speed > capability.speed.max
      || capability.speed.options && !capability.speed.options.includes(speed)) fail('该型号不支持所选速度倍率');
    result.audioSpeed = speed;
  }
  return result;
}
