/** 方舟本地参考素材使用的私有 TOS；普通配置只保留凭据引用。 */
export interface VolcengineTosConfig {
  bucket: string;
  region: 'cn-beijing';
  credentialRef: string;
}

/** 仅用于设置草稿和原生凭据写入，不进入 Store 或普通配置。 */
export interface VolcengineTosCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}
