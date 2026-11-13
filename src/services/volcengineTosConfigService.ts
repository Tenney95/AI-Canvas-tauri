import type { VolcengineTosConfig, VolcengineTosCredentials } from '../types/volcengineTos';
import { deleteAppSecret, writeAppSecret } from './providerSecretService';

const CREDENTIAL_REF = /^secret:provider\/volcengine\/tos\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function validateVolcengineTosConfig(config: VolcengineTosConfig | undefined, credentials?: VolcengineTosCredentials): void {
  const accessKeyId = credentials?.accessKeyId.trim() ?? '';
  const secretAccessKey = credentials?.secretAccessKey.trim() ?? '';
  const bucket = config?.bucket.trim() ?? '';
  const ref = config?.credentialRef ?? '';
  if (!bucket && !ref && !accessKeyId && !secretAccessKey) return;
  if (!config || !BUCKET.test(bucket)) throw new Error('TOS Bucket 名须为 3–63 位小写字母、数字或短横线，首尾须为字母或数字');
  if (config.region !== 'cn-beijing') throw new Error('方舟参考素材的 TOS 区域必须为北京（cn-beijing）');
  if (ref && !CREDENTIAL_REF.test(ref)) throw new Error('TOS 凭据引用无效，请重新配置');
  if (!!accessKeyId !== !!secretAccessKey) throw new Error('更新 TOS 凭据时必须同时填写 Access Key 和 Secret Key');
  if (accessKeyId && (!/^[A-Za-z0-9_-]{1,256}$/.test(accessKeyId) || new TextEncoder().encode(secretAccessKey).length > 2048 || /\s/.test(`${accessKeyId}${secretAccessKey}`)
    || [...accessKeyId, ...secretAccessKey].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    throw new Error('TOS Access Key 或 Secret Key 格式无效');
  }
  if (!accessKeyId && !ref) throw new Error('请填写 TOS 自己的 Access Key 和 Secret Key，方舟 API Key 不能代替');
}

/** 新 AK/SK 使用一个不可变 bundle 引用，保存失败不会覆盖旧连接凭据。 */
export async function persistVolcengineTosConfig(
  config: VolcengineTosConfig | undefined,
  credentials: VolcengineTosCredentials,
): Promise<VolcengineTosConfig | undefined> {
  validateVolcengineTosConfig(config, credentials);
  if (!config?.bucket.trim()) return undefined;
  const next = { bucket: config.bucket.trim(), region: config.region, credentialRef: config.credentialRef };
  const accessKeyId = credentials.accessKeyId.trim();
  const secretAccessKey = credentials.secretAccessKey.trim();
  if (accessKeyId && secretAccessKey) {
    const key = `provider/volcengine/tos/${crypto.randomUUID()}`;
    if (!await writeAppSecret(key, JSON.stringify({ accessKeyId, secretAccessKey }), { value: null })) {
      throw new Error('TOS 凭据保存失败，请确认桌面凭据存储可用后重试');
    }
    next.credentialRef = `secret:${key}`;
  }
  return next;
}

export async function deleteVolcengineTosCredential(ref: string | undefined): Promise<void> {
  if (ref && CREDENTIAL_REF.test(ref) && !await deleteAppSecret(ref.slice('secret:'.length))) {
    throw new Error('旧 TOS 凭据清理失败');
  }
}
