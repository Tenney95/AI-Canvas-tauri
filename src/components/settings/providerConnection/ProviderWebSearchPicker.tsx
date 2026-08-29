/**
 * settings/providerConnection/ProviderWebSearchPicker — 联网搜索厂商切换卡片。
 * 所有厂商密钥都保留在本地，这里只决定当前使用哪一家。
 */
import { Icon } from '@iconify/react';
import { useT } from '../../../i18n';
import type { ApiProviderConfig } from '../../../types';
import type { ProviderDefinition } from '../../../services/ai/providerCatalogService';

interface ProviderWebSearchPickerProps {
  definitions: readonly ProviderDefinition[];
  providerConfigs: Record<string, ApiProviderConfig>;
  currentDefinition: ProviderDefinition;
  onChoose: (definition: ProviderDefinition) => void;
}

export default function ProviderWebSearchPicker({
  definitions,
  providerConfigs,
  currentDefinition,
  onChoose,
}: ProviderWebSearchPickerProps) {
  const t = useT();

  return (
    <section className="provider-model-section">
      <div className="provider-section-heading">
        <div>
          <h4>{t('搜索厂商')}</h4>
          <p>{t('选择当前使用的服务，其他厂商密钥会保留在本地')}</p>
        </div>
      </div>
      <div className="provider-picker-grid">
        {definitions.map((item) => {
          const selected = item.id === currentDefinition.id;
          const configured = Boolean(providerConfigs[item.id]?.apiKey?.trim());
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              className={`provider-picker-item ${selected ? 'ring-1 ring-indigo-400/60 bg-indigo-500/10' : ''}`}
              onClick={() => onChoose(item)}
            >
              <span className={`provider-badge provider-badge--${item.id}`}>{item.badgeText}</span>
              <span className="provider-picker-copy">
                <strong>{item.name}</strong>
                <small>{configured ? t('API Key 已配置') : item.description}</small>
              </span>
              <Icon icon={selected ? 'mdi:check-circle' : 'mdi:chevron-right'} width="18" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
