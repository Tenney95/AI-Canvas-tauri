import type { ImageHostingConfig } from '../types/imageHosting';

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
