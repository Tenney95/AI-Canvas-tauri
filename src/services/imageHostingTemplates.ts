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

/** 仅保留支持图片、视频和音频的服务；国内候选在前，缺省仍为 Uguu。 */
export const PUBLIC_IMAGE_HOSTING_TEMPLATES: ReadonlyArray<{
  id: PublicImageHostingProvider;
  label: string;
  description: string;
  docsUrl: string;
  config: ImageHostingConfig;
}> = [
  { id: 'bohe', label: '薄荷图床（国内会员 API）', description: '支持图片、视频和音频；API 需高级会员，免费网页上传不包含 API。默认单文件 30 MB，以会员后台限制为准。',
    docsUrl: 'https://zixiaoyun.com/docs/help.html', config: {
      enabled: true, uploadUrl: '', fileField: 'uploadedFile', responseUrlPath: 'url',
      auth: 'form', authField: 'api_token', formFields: [{ name: 'upload_format', value: 'file' }],
      successPath: 'status', successValue: 'success', maxFileBytes: 30_000_000,
    } },
  { id: 'uguu', label: 'Uguu', description: '免费且无需密钥；支持图片、视频和音频，单文件 128 MiB，约 3 小时后过期。', docsUrl: 'https://uguu.se/api/', config: {
    enabled: true, uploadUrl: 'https://uguu.se/upload', fileField: 'files[]', responseUrlPath: 'files[0].url',
    auth: 'none', successPath: 'success', successValue: 'true', maxFileBytes: 128 * 1024 * 1024,
  } },
  { id: 'catbox', label: 'Catbox', description: '支持图片、视频和音频，可免费匿名上传；GIF 最高 20 MB，其他文件最高 200 MB。商业服务外链须事先获许可。',
    docsUrl: 'https://catbox.moe/tools.php', config: {
      enabled: true, uploadUrl: 'https://catbox.moe/user/api.php', fileField: 'fileToUpload', responseUrlPath: '',
      auth: 'none', responseFormat: 'text', formFields: [{ name: 'reqtype', value: 'fileupload' }], maxFileBytes: 200_000_000,
    } },
  // 免费套餐上限：https://imagekit.io/plans/；音频由同一个文件上传 API 处理。
  { id: 'imagekit', label: 'ImageKit', description: '支持图片、视频和音频，使用 Private API Key；免费套餐图片和音频 25 MB、视频 100 MB，另有存储与流量额度。',
    docsUrl: 'https://imagekit.io/docs/api-reference/upload-file/upload-file', config: {
      enabled: true, uploadUrl: 'https://upload.imagekit.io/api/v1/files/upload', fileField: 'file', responseUrlPath: 'url',
      auth: 'basic', fileNameField: 'fileName', formFields: [{ name: 'useUniqueFileName', value: 'true' }, { name: 'isPrivateFile', value: 'false' }],
      maxFileBytes: 25_000_000, maxFileBytesByKind: { image: 25_000_000, video: 100_000_000, audio: 25_000_000 },
    } },
  // resource_type=auto 识别全部素材，音频归 video；免费上限：https://cloudinary.com/pricing/compare-plans。
  { id: 'cloudinary', label: 'Cloudinary', description: '支持图片、视频和音频；填写 Cloud name 和 unsigned Upload preset，无需 API Secret。免费套餐图片 10 MB、音视频 100 MB。',
    docsUrl: 'https://cloudinary.com/documentation/image_upload_api_reference', config: {
      enabled: true, uploadUrl: 'https://api.cloudinary.com/v1_1/{{cloudName}}/auto/upload', fileField: 'file', responseUrlPath: 'secure_url',
      auth: 'none', formFields: [{ name: 'upload_preset', value: '' }], maxFileBytes: 10_000_000,
      maxFileBytesByKind: { image: 10_000_000, video: 100_000_000, audio: 100_000_000 },
    } },
];

/** 只兼容已知 Cloudinary 图片旧入口，不改第三方端点，也不原地修改保存的配置。 */
export function normalizeGlobalImageHostingConfig(provider: PublicImageHostingProvider, config: ImageHostingConfig): ImageHostingConfig {
  const next = { ...config };
  if (provider !== 'cloudinary') return next;
  try {
    const endpoint = new URL(config.uploadUrl);
    if (endpoint.protocol === 'https:' && endpoint.hostname === 'api.cloudinary.com' && !endpoint.port
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      && /^\/v1_1\/[a-zA-Z0-9_-]{1,128}\/(?:image|auto)\/upload$/.test(endpoint.pathname)) {
      endpoint.pathname = endpoint.pathname.replace(/\/(?:image|auto)\/upload$/, '/auto/upload');
      next.uploadUrl = endpoint.href;
    }
  } catch { /* 未配置或自定义地址交由保存校验，不猜测替代端点。 */ }
  return next;
}

/** 没有全局配置时保持 Uguu；损坏或停用的已选配置必须显式报错。 */
export function resolveGlobalImageHosting(config?: GlobalImageHostingConfig): ImageHostingConfig {
  const provider = config?.provider ?? 'uguu';
  const template = PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === provider);
  if (!template) throw new Error('当前图床不支持图片、视频和音频通用上传，请在 API Key 设置中重新选择');
  const resolved = normalizeGlobalImageHostingConfig(provider, structuredClone({ ...template.config, ...config?.configs?.[provider] }));
  if (!resolved.enabled) throw new Error('全局图床已停用，请在 API Key 设置中重新配置');
  if (resolved.credentialSource === 'connection') throw new Error('全局图床只能使用自己的密钥');
  return resolved;
}
