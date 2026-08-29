/**
 * settings/providerConnection/ProviderConnectionForm — 连接信息区块。
 * 负责凭证字段、OAuth 登录态、重复地址提示与「验证连接」，模型选择不在这里。
 */
import { Icon } from '@iconify/react';
import type { Dispatch, SetStateAction } from 'react';
import { useT } from '../../../i18n';
import { normalizeBaseUrl } from '../../../services/ai/providerBaseUrl';
import type { ProviderDefinition } from '../../../services/ai/providerCatalogService';
import AnimatedButton from '../../shared/AnimatedButton';
import { PROVIDER_LINKS, openExternal, type CatalogStatus } from './providerConnectionShared';

interface ProviderConnectionFormProps {
  editing: boolean;
  definition: ProviderDefinition;
  isWebSearchProvider: boolean;
  connectionName: string;
  setConnectionName: Dispatch<SetStateAction<string>>;
  apiKey: string;
  setApiKey: Dispatch<SetStateAction<string>>;
  baseUrl: string;
  setBaseUrl: Dispatch<SetStateAction<string>>;
  workflowApiKey: string;
  setWorkflowApiKey: Dispatch<SetStateAction<string>>;
  dreaminaLoggedIn: boolean;
  dreaminaLoading: boolean;
  onDreaminaLogin: () => void;
  duplicateConnectionName: string;
  catalogStatus: CatalogStatus;
  catalogMessage: string;
  missingCredentials: boolean;
  onReturnToPicker: () => void;
  onTestConnection: () => void;
}

export default function ProviderConnectionForm({
  editing,
  definition,
  isWebSearchProvider,
  connectionName,
  setConnectionName,
  apiKey,
  setApiKey,
  baseUrl,
  setBaseUrl,
  workflowApiKey,
  setWorkflowApiKey,
  dreaminaLoggedIn,
  dreaminaLoading,
  onDreaminaLogin,
  duplicateConnectionName,
  catalogStatus,
  catalogMessage,
  missingCredentials,
  onReturnToPicker,
  onTestConnection,
}: ProviderConnectionFormProps) {
  const t = useT();

  return (
    <section className="provider-config-section">
      <div className="provider-section-heading">
        <div>
          <h4>{t('连接信息')}</h4>
          <p>{definition.description}</p>
        </div>
        {!editing && !isWebSearchProvider && (
          <AnimatedButton
            type="button"
            className="provider-text-btn"
            onClick={onReturnToPicker}
          >
            {t('更换厂商')}
          </AnimatedButton>
        )}
      </div>

      {definition.id === 'custom-openai' && (
        <div className="provider-catalog-message is-warning provider-custom-openai-warning">
          <Icon icon="mdi:alert-circle-outline" width="16" />
          <span>
            {t('提示：每个中转站提供的模型和参数规则都不一样，从接口拉取下来的模型，不一定能直接拿来用。不同中转站对同一个模型的名字、传入图片、尺寸等参数往往不同，直接使用可能会报错。请先查看你所用中转站的官方文档，把对应的参数改成文档里的值。如果你不会改，可以这样做：直接把中转站的文档发给对话助手，或者开启智能体并接入 MCP，让助手照着文档帮你添加和配置。')}
          </span>
        </div>
      )}

      {definition.id === 'custom-openai' && (
        <label className="provider-field">
          <span>{t('连接名称')}</span>
          <input
            type="text"
            value={connectionName}
            placeholder={t('例如：团队模型网关')}
            onChange={(event) => setConnectionName(event.target.value)}
          />
        </label>
      )}

      {definition.authType === 'oauth' ? (
        <div className="provider-oauth-row">
          <span className={`provider-connection-dot${dreaminaLoggedIn ? ' is-online' : ''}`} />
          <div>
            <strong>{dreaminaLoggedIn ? t('即梦账号已登录') : t('即梦账号未登录')}</strong>
            <small>{t('模型调用使用桌面端 OAuth 登录态')}</small>
          </div>
          <AnimatedButton
            type="button"
            className="provider-secondary-btn"
            disabled={dreaminaLoading}
            onClick={onDreaminaLogin}
          >
            {dreaminaLoading ? t('处理中...') : dreaminaLoggedIn ? t('重新登录') : t('OAuth 登录')}
          </AnimatedButton>
        </div>
      ) : (
        <div className="provider-fields-grid">
          {definition.credentials.map((field) => {
            const value = field.key === 'apiKey' ? apiKey : baseUrl;
            const baseUrlLocked = field.key === 'baseUrl'
              && definition.allowCustomBaseUrl === false;
            return (
              <label key={field.key} className="provider-field">
                <span>{field.label}{field.required ? ' *' : ''}</span>
                <input
                  type={field.secret ? 'password' : 'text'}
                  value={value}
                  placeholder={field.placeholder}
                  readOnly={baseUrlLocked}
                  disabled={baseUrlLocked}
                  onChange={(event) => {
                    if (field.key === 'apiKey') setApiKey(event.target.value);
                    else setBaseUrl(event.target.value);
                  }}
                  onBlur={(event) => {
                    // 补协议、去尾斜杠、剥掉误贴的 /chat/completions，
                    // 让用户在保存前就看见真正会被请求的地址
                    if (field.key === 'baseUrl') setBaseUrl(normalizeBaseUrl(event.target.value));
                  }}
                />
              </label>
            );
          })}
          {definition.id === 'runninghub-model' && (
            <label className="provider-field">
              <span>{t('消费级-会员 API Key')}</span>
              <input
                type="password"
                value={workflowApiKey}
                placeholder={t('用于 RunningHub 工作流执行（可选）')}
                onChange={(event) => setWorkflowApiKey(event.target.value)}
              />
            </label>
          )}
        </div>
      )}

      {duplicateConnectionName && (
        <div className="provider-catalog-message is-warning">
          <Icon icon="mdi:content-duplicate" width="14" />
          <span>
            {t('已有连接「{name}」使用相同接口地址。继续保存会新建第二条同网关连接；如果只是想加模型，建议回列表编辑「{name}」。', {
              name: duplicateConnectionName,
            })}
          </span>
        </div>
      )}

      {(definition.externalUrl || PROVIDER_LINKS[definition.id]) && (
        <button
          type="button"
          className="provider-external-link"
          onClick={() => void openExternal(
            definition.externalUrl || PROVIDER_LINKS[definition.id],
          )}
        >
          <Icon icon="mdi:open-in-new" width="13" />
          {definition.id === 'grsai' ? t('前往 API Key 页面') : t('前往厂商控制台')}
        </button>
      )}

      {definition.authType !== 'oauth' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <AnimatedButton
            type="button"
            className="provider-secondary-btn"
            disabled={missingCredentials || catalogStatus === 'loading'}
            onClick={() => void onTestConnection()}
          >
            <Icon
              icon={catalogStatus === 'loading' ? 'mdi:loading' : 'mdi:connection'}
              className={catalogStatus === 'loading' ? 'settings-spin' : undefined}
              width="15"
            />
            {catalogStatus === 'loading' ? t('验证中') : t('验证连接')}
          </AnimatedButton>
          {isWebSearchProvider && catalogMessage && (
            <div className={`provider-catalog-message is-${catalogStatus} m-0 flex-1`}>
              <Icon
                icon={catalogStatus === 'error' ? 'mdi:alert-circle-outline' : 'mdi:information-outline'}
                width="14"
              />
              <span>{catalogMessage}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
