import type { GlobalImageHostingConfig, ImageHostingConfig, PublicImageHostingProvider } from '../types/imageHosting';

/** 对照 uploadService 现有上传合同填写；只生成用户显式选择的连接草稿。 */
export const IMAGE_HOSTING_TEMPLATES: ReadonlyArray<{ id: string; label: string; config: ImageHostingConfig }> = [
  { id: 'apimart', label: 'APIMart 上传格式', config: {
    enabled: true, uploadUrl: '{{baseUrl}}/uploads/images', fileField: 'file', responseUrlPath: 'url',
    auth: 'bearer', credentialSource: 'connection', maxFileBytes: 20_000_000,
  } },
  { id: 'toapis', label: 'ToAPIs 上传格式', config: {
    enabled: true, uploadUrl: '{{baseUrl}}/uploads/images', fileField: 'file', responseUrlPath: 'data.url',
    auth: 'bearer', credentialSource: 'connection', formFields: [{ name: 'purpose', value: 'generation' }],
    successPath: 'success', successValue: 'true', maxFileBytes: 10 * 1024 * 1024,
    allowedExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  } },
  { id: 'libapi', label: 'LibAPI 上传格式', config: {
    enabled: true, uploadUrl: '{{baseUrl}}/files', fileField: 'file', responseUrlPath: 'url',
    auth: 'bearer', credentialSource: 'connection', maxFileBytes: 50 * 1024 * 1024,
    allowedExtensions: ['jpg', 'png', 'webp', 'gif', 'heic'],
  } },
  { id: 'uguu', label: 'Uguu 公共图床格式', config: {
    enabled: true, uploadUrl: 'https://uguu.se/upload', fileField: 'files[]', responseUrlPath: 'files[0].url',
    auth: 'none', successPath: 'success', successValue: 'true',
  } },
];

/** SCDN 官方公开的大陆线路；只决定返回的图片直链，不修改上传接口。 */
export const SCDN_IMAGE_HOSTING_CDNS = [
  { value: 'esaimg.cdn1.vip', label: 'ESA 大陆线路' },
  { value: 'edgeoneimg.cdn1.vip', label: 'EdgeOne 大陆线路' },
] as const;

/** 国内候选排在前面；缺省服务仍由配置解析明确指定为 Uguu。 */
export const PUBLIC_IMAGE_HOSTING_TEMPLATES: ReadonlyArray<{
  id: PublicImageHostingProvider;
  label: string;
  description: string;
  docsUrl: string;
  config: ImageHostingConfig;
}> = [
  { id: 'scdn', label: 'SCDN（大陆线路）', description: '无需密钥，可选 ESA 或 EdgeOne 大陆线路，图片转为 PNG；连续 60 天未访问会清理。',
    docsUrl: 'https://img.scdn.io/api_docs.php', config: {
      enabled: true, uploadUrl: 'https://img.scdn.io/api/v1.php', fileField: 'image', responseUrlPath: 'data.url',
      auth: 'none', successPath: 'success', successValue: 'true',
      formFields: [{ name: 'cdn_domain', value: SCDN_IMAGE_HOSTING_CDNS[0].value }, { name: 'outputFormat', value: 'png' }],
      allowedExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff'],
    } },
  { id: 'picui', label: 'PICUI', description: '支持游客上传；可填写个人中心 Token，额度以账号为准。', docsUrl: 'https://picui.cn/page/api-docs.html', config: {
    enabled: true, uploadUrl: 'https://picui.cn/api/v1/upload', fileField: 'file', responseUrlPath: 'data.links.url',
    auth: 'none', formFields: [{ name: 'permission', value: '1' }], successPath: 'status', successValue: 'true', maxFileBytes: 20_000_000,
  } },
  { id: 'helloimg', label: 'Hello图床', description: '可填写个人中心 Token；游客上传、注册实名要求与额度以站点当前策略为准。',
    docsUrl: 'https://www.helloimg.com/page/api-docs.html', config: {
      enabled: true, uploadUrl: 'https://www.helloimg.com/api/v1/upload', fileField: 'file', responseUrlPath: 'data.links.url',
      auth: 'none', formFields: [{ name: 'permission', value: '1' }], successPath: 'status', successValue: 'true',
    } },
  { id: 'imgurl', label: 'ImgURL', description: '需要控制台的开放接口 Token；API 权限、单图大小和上传额度以账号套餐为准。',
    docsUrl: 'https://www.imgurl.org/docs/upload-v3', config: {
      enabled: true, uploadUrl: 'https://www.imgurl.org/api/v3/upload', fileField: 'file', responseUrlPath: 'data.url',
      auth: 'bearer', successPath: 'code', successValue: '200',
    } },
  { id: 'bohe', label: '薄荷图床（会员 API）', description: 'API 需高级会员并在后台开启；填写会员专用上传地址与 API Token，免费网页上传不包含 API。',
    docsUrl: 'https://zixiaoyun.com/docs/help.html', config: {
      enabled: true, uploadUrl: '', fileField: 'uploadedFile', responseUrlPath: 'url',
      auth: 'form', authField: 'api_token', formFields: [{ name: 'upload_format', value: 'file' }],
      successPath: 'status', successValue: 'success',
    } },
  { id: 'uguu', label: 'Uguu', description: '无需密钥；临时文件约 3 小时后过期。', docsUrl: 'https://uguu.se/api/', config: {
    enabled: true, uploadUrl: 'https://uguu.se/upload', fileField: 'files[]', responseUrlPath: 'files[0].url',
    auth: 'none', successPath: 'success', successValue: 'true', maxFileBytes: 128 * 1024 * 1024,
  } },
  { id: 'imgbb', label: 'ImgBB', description: '需要 ImgBB API Key，单张最高 32 MB。', docsUrl: 'https://api.imgbb.com/', config: {
    enabled: true, uploadUrl: 'https://api.imgbb.com/1/upload', fileField: 'image', responseUrlPath: 'data.url',
    auth: 'form', authField: 'key', successPath: 'success', successValue: 'true', maxFileBytes: 32_000_000,
  } },
  { id: 'freeimage', label: 'Freeimage.host', description: '需要图床 API Key，单张最高 64 MB。', docsUrl: 'https://freeimage.host/api', config: {
    enabled: true, uploadUrl: 'https://freeimage.host/api/1/upload/', fileField: 'source', responseUrlPath: 'image.url',
    auth: 'form', authField: 'key', formFields: [{ name: 'action', value: 'upload' }, { name: 'format', value: 'json' }],
    successPath: 'status_code', successValue: '200', maxFileBytes: 64_000_000,
  } },
  { id: 'catbox', label: 'Catbox', description: '可匿名上传；GIF 最高 20 MB，其他文件最高 200 MB。商业服务外链须事先获许可。',
    docsUrl: 'https://catbox.moe/tools.php', config: {
      enabled: true, uploadUrl: 'https://catbox.moe/user/api.php', fileField: 'fileToUpload', responseUrlPath: '',
      auth: 'none', responseFormat: 'text', formFields: [{ name: 'reqtype', value: 'fileupload' }], maxFileBytes: 200_000_000,
    } },
  { id: 'imagekit', label: 'ImageKit', description: '使用 Private API Key；免费额度及文件上限以账号套餐为准。',
    docsUrl: 'https://imagekit.io/docs/api-reference/upload-file/upload-file', config: {
      enabled: true, uploadUrl: 'https://upload.imagekit.io/api/v1/files/upload', fileField: 'file', responseUrlPath: 'url',
      auth: 'basic', fileNameField: 'fileName', formFields: [{ name: 'useUniqueFileName', value: 'true' }, { name: 'isPrivateFile', value: 'false' }],
      maxFileBytes: 25_000_000,
    } },
  { id: 'cloudinary', label: 'Cloudinary', description: '填写 Cloud name 和允许 unsigned 上传的 Upload preset，无需提供 API Secret。',
    docsUrl: 'https://cloudinary.com/documentation/image_upload_api_reference', config: {
      enabled: true, uploadUrl: 'https://api.cloudinary.com/v1_1/{{cloudName}}/image/upload', fileField: 'file', responseUrlPath: 'secure_url',
      auth: 'none', formFields: [{ name: 'upload_preset', value: '' }], maxFileBytes: 10_000_000,
    } },
];

/** 没有全局配置时保持 Uguu；损坏或停用的已选配置必须显式报错。 */
export function resolveGlobalImageHosting(config?: GlobalImageHostingConfig): ImageHostingConfig {
  const provider = config?.provider ?? 'uguu';
  const template = PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === provider);
  if (!template) throw new Error('全局图床类型无效，请在 API Key 设置中重新选择');
  const resolved = structuredClone({ ...template.config, ...config?.configs?.[provider] });
  if (!resolved.enabled) throw new Error('全局图床已停用，请在 API Key 设置中重新配置');
  if (resolved.credentialSource === 'connection') throw new Error('全局图床只能使用自己的密钥');
  return resolved;
}
