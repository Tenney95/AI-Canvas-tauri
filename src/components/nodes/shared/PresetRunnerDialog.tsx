import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import type { Node } from '@xyflow/react';
import type {
  BaseNodeData,
  PresetParameterDefinition,
  PresetParameterValue,
  UserPreset,
} from '../../../types';
import { PRESET_NODE_TYPE_LABELS, getNodeTypeConfig } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import {
  createPresetParameterValues,
  validatePresetParameterValues,
  type PresetParameterValues,
} from '../../../services/presetTemplateService';
import { isAdvancedPreset, runPresetSequence } from '../../../services/presetSequenceService';
import PopupCloseButton from '../../shared/PopupCloseButton';

const EMPTY_PARAMETERS: PresetParameterDefinition[] = [];
const EMPTY_STEPS: NonNullable<UserPreset['advanced']>['steps'] = [];

const runnerPanelVariants = {
  hidden: { opacity: 0, scale: 0.97, y: 12 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 380, damping: 32 },
  },
  exit: { opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.14 } },
};

function ParameterInput({
  parameter,
  value,
  onChange,
}: {
  parameter: PresetParameterDefinition;
  value: PresetParameterValue;
  onChange: (value: PresetParameterValue) => void;
}) {
  if (parameter.type === 'boolean') {
    return (
      <label className="preset-runner-toggle">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="preset-runner-toggle-track" aria-hidden="true">
          <span />
        </span>
        <span>{value === true ? '开启' : '关闭'}</span>
      </label>
    );
  }

  if (parameter.type === 'select') {
    return (
      <select
        className="preset-manager-input"
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">请选择</option>
        {(parameter.options ?? []).filter(Boolean).map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }

  if (parameter.type === 'textarea') {
    return (
      <textarea
        className="preset-manager-input preset-runner-textarea"
        value={String(value ?? '')}
        placeholder={'输入' + parameter.label}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <input
      className="preset-manager-input"
      type={parameter.type === 'number' ? 'number' : 'text'}
      value={String(value ?? '')}
      placeholder={'输入' + parameter.label}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function PresetRunnerContent({
  preset,
  sourceNode,
  onClose,
}: {
  preset: UserPreset;
  sourceNode: Node<BaseNodeData>;
  onClose: () => void;
}) {
  const parameters = preset.advanced?.parameters ?? EMPTY_PARAMETERS;
  const steps = preset.advanced?.steps ?? EMPTY_STEPS;
  const [values, setValues] = useState<PresetParameterValues>(
    () => createPresetParameterValues(parameters),
  );
  const showToast = useAppStore((state) => state.showToast);
  const errors = useMemo(
    () => validatePresetParameterValues(parameters, values),
    [parameters, values],
  );

  const handleRun = () => {
    if (errors[0]) {
      showToast(errors[0], 'error');
      return;
    }
    onClose();
    void runPresetSequence({
      preset,
      sourceNodeId: sourceNode.id,
      values,
    }).then((result) => {
      if (!result.success && result.failedStepIndex === undefined && result.message) {
        useAppStore.getState().showToast(result.message, 'error');
      }
    });
  };

  return (
    <>
      <motion.div
        className="preset-modal-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <div className="preset-modal-wrapper">
        <motion.div
          className="preset-modal preset-runner-modal"
          variants={runnerPanelVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          role="dialog"
          aria-modal="true"
          aria-labelledby="preset-runner-title"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="preset-runner-header">
            <div className="preset-runner-heading">
              <span className="preset-runner-heading-icon">
                <Icon icon="mdi:play-sequence-outline" width={20} height={20} />
              </span>
              <div>
                <h2 id="preset-runner-title">{preset.name}</h2>
                <p>将从“{sourceNode.data.label || sourceNode.id}”开始顺序执行</p>
              </div>
            </div>
            <PopupCloseButton onClick={onClose} />
          </header>

          <div className="preset-runner-body">
            {parameters.length > 0 ? (
              <section className="preset-runner-parameters" aria-labelledby="preset-runner-parameters-title">
                <div className="preset-runner-section-heading">
                  <h3 id="preset-runner-parameters-title">运行参数</h3>
                  <span>{parameters.filter((parameter) => parameter.required).length} 项必填</span>
                </div>
                <div className="preset-runner-fields">
                  {parameters.map((parameter) => (
                    <label
                      className={'preset-manager-field' + (parameter.type === 'textarea' ? ' preset-runner-field-wide' : '')}
                      key={parameter.id}
                    >
                      <span className="preset-manager-label">
                        {parameter.label}
                        {parameter.required ? <em>必填</em> : null}
                      </span>
                      <ParameterInput
                        parameter={parameter}
                        value={values[parameter.key]}
                        onChange={(value) => setValues((current) => ({
                          ...current,
                          [parameter.key]: value,
                        }))}
                      />
                    </label>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="preset-runner-preview" aria-labelledby="preset-runner-preview-title">
              <div className="preset-runner-section-heading">
                <h3 id="preset-runner-preview-title">执行预览</h3>
                <span>{steps.length} 次模型生成</span>
              </div>
              <div className="preset-runner-step-list">
                {steps.map((step, index) => {
                  const visual = getNodeTypeConfig(step.nodeType);
                  return (
                    <div className="preset-runner-step" key={step.id}>
                      <span className={'preset-runner-step-icon ' + visual.bg + ' ' + visual.color}>
                        <Icon icon={visual.icon} width={16} height={16} />
                      </span>
                      <span className="preset-runner-step-index">{index + 1}</span>
                      <span className="preset-runner-step-name">{step.name}</span>
                      <span className="preset-runner-step-type">
                        {PRESET_NODE_TYPE_LABELS[step.nodeType].replace('预设', '')}
                      </span>
                      {index < steps.length - 1 ? (
                        <Icon className="preset-runner-step-arrow" icon="mdi:arrow-right" width={15} height={15} />
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div className="preset-runner-notice">
                <Icon icon="mdi:information-outline" width={16} height={16} />
                <span>任一步失败后会停止执行；已完成节点和结果会保留。</span>
              </div>
            </section>
          </div>

          <footer className="preset-modal-actions preset-runner-actions">
            <span>每完成一个节点记录一次生成历史</span>
            <div>
              <button type="button" className="preset-modal-btn-secondary" onClick={onClose}>取消</button>
              <button
                type="button"
                className="preset-modal-btn-primary"
                disabled={steps.length === 0}
                onClick={handleRun}
              >
                <Icon icon="mdi:play" width={15} height={15} />
                <span>开始执行 {steps.length} 步</span>
              </button>
            </div>
          </footer>
        </motion.div>
      </div>
    </>
  );
}

export default function PresetRunnerDialog() {
  const request = useAppStore((state) => state.presetRunRequest);
  const preset = useAppStore((state) => (
    request ? state.userPresets.find((item) => item.id === request.presetId) : undefined
  ));
  const sourceNode = useAppStore((state) => (
    request ? state.nodes.find((node) => node.id === request.sourceNodeId) as Node<BaseNodeData> | undefined : undefined
  ));
  const setPresetRunRequest = useAppStore((state) => state.setPresetRunRequest);
  const close = () => setPresetRunRequest(null);

  useEffect(() => {
    if (request && (!preset || !sourceNode || !isAdvancedPreset(preset))) {
      setPresetRunRequest(null);
    }
  }, [preset, request, setPresetRunRequest, sourceNode]);

  return createPortal(
    <AnimatePresence>
      {request && preset && sourceNode && isAdvancedPreset(preset) ? (
        <PresetRunnerContent
          key={request.presetId + ':' + request.sourceNodeId}
          preset={preset}
          sourceNode={sourceNode}
          onClose={close}
        />
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
