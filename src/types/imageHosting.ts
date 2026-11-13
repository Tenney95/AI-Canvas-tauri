/** 自定义连接的图片上传配置；密钥只保存原生凭据引用。 */
export interface ImageHostingConfig {
  enabled: boolean;
  uploadUrl: string;
  fileField: string;
  responseUrlPath: string;
  auth: 'none' | 'bearer' | 'header' | 'form' | 'basic';
  authField?: string;
  /** 不声明时沿用独立图床密钥；连接密钥只允许发送给同源上传接口。 */
  credentialSource?: 'separate' | 'connection';
  credentialRef?: string;
  formFields?: Array<{ name: string; value: string }>;
  successPath?: string;
  successValue?: string;
  /** Catbox 等接口直接返回纯文本链接；未声明时沿用 JSON。 */
  responseFormat?: 'json' | 'text';
  /** 部分图床需将当前上传文件名另存为普通表单字段。 */
  fileNameField?: string;
  /** 模板保留厂商的真实字节限制，不把十进制 MB 与 MiB 混用。 */
  maxFileBytes?: number;
  allowedExtensions?: string[];
}

export type PublicImageHostingProvider = 'scdn' | 'picui' | 'helloimg' | 'imgurl' | 'bohe'
  | 'uguu' | 'imgbb' | 'freeimage' | 'catbox' | 'imagekit' | 'cloudinary';

/** 全局公共图床；各服务独立保留配置及原生凭据引用。 */
export interface GlobalImageHostingConfig {
  provider: PublicImageHostingProvider;
  configs: Partial<Record<PublicImageHostingProvider, ImageHostingConfig>>;
}
