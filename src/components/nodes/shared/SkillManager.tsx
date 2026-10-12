/**
 * SkillManager Skill 管理器 — 统一查看 Skill，支持删除手动上传记录
 */
import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '../../../store/useAppStore';
import { isAgentPackageSkill } from '../../../types/agentPackage';
import AnimatedButton from '../../shared/AnimatedButton';
import PopupCloseButton from '../../shared/PopupCloseButton';

interface SkillManagerProps {
  open: boolean;
  onClose: () => void;
}

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const panelVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 20 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 350, damping: 30 },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 20,
    transition: { duration: 0.15, ease: 'easeIn' as const },
  },
};

function formatDate(ts: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}

export default function SkillManager({ open, onClose }: SkillManagerProps) {
  const userSkills = useAppStore((s) => s.userSkills);
  const agentPackageSkills = useAppStore((s) => s.agentPackageSkills);
  const skills = useMemo(() => [...userSkills, ...agentPackageSkills], [userSkills, agentPackageSkills]);
  const deleteSkill = useAppStore((s) => s.deleteSkill);
  const showToast = useAppStore((s) => s.showToast);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeSelectedId = selectedId ?? skills[0]?.id ?? null;

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === activeSelectedId) ?? skills[0] ?? null,
    [activeSelectedId, skills],
  );

  const handleDelete = useCallback(async (id: string) => {
    const skill = userSkills.find((item) => item.id === id);
    if (!skill) return;
    await deleteSkill(id);
    const state = useAppStore.getState();
    const remaining = [...state.userSkills, ...state.agentPackageSkills];
    setSelectedId(remaining[0]?.id ?? null);
    showToast(`已删除 Skill「${skill.name}」`);
  }, [deleteSkill, showToast, userSkills]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            data-tauri-drag-region
            className="preset-modal-overlay"
            variants={backdropVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          <div className="preset-modal-wrapper">
            <motion.div
              className="preset-modal preset-modal--manager"
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="preset-manager-title-row">
                <div className="preset-manager-title-group">
                  <div className="preset-modal-title">Skill 管理</div>
                  <div className="preset-modal-desc">查看 Skill 内容；包内 Skill 由智能体中心管理</div>
                </div>
                <PopupCloseButton onClick={onClose} />
              </div>

              <div className="preset-manager-shell">
                <div className="preset-manager-sidebar">
                  <div className="preset-manager-list">
                    {skills.map((skill) => (
                      <div
                        key={skill.id}
                        role="button"
                        tabIndex={0}
                        className={`preset-manager-list-item${selectedSkill?.id === skill.id ? ' is-active' : ''}`}
                        onClick={() => setSelectedId(skill.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setSelectedId(skill.id);
                        }}
                      >
                        <span className="preset-manager-list-thumb">
                          <span className="preset-manager-list-thumb-plus">S</span>
                        </span>
                        <span className="preset-manager-list-text">
                          <span className="preset-manager-list-title">{skill.name}</span>
                          <span className="preset-manager-list-desc">
                            {isAgentPackageSkill(skill) ? `${skill.packageName} · ` : ''}
                            {skill.description || skill.fileName}
                          </span>
                        </span>
                        {isAgentPackageSkill(skill) ? (
                          <span className="ui-badge">只读</span>
                        ) : (
                          <AnimatedButton
                            type="button"
                            className="preset-manager-list-delete"
                            aria-label={`删除 ${skill.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDelete(skill.id);
                            }}
                          >
                            ×
                          </AnimatedButton>
                        )}
                      </div>
                    ))}
                    {skills.length === 0 && (
                      <div className="preset-manager-list-empty">
                        暂无 Skill，可上传文件或在智能体中心导入
                      </div>
                    )}
                  </div>
                </div>

                <div className="preset-manager-detail-pane">
                  {selectedSkill ? (
                    <div className="preset-manager-detail">
                      <label className="preset-manager-field">
                        <span className="preset-manager-label">名称</span>
                        <input
                          className="preset-manager-input"
                          type="text"
                          value={selectedSkill.name}
                          readOnly
                        />
                      </label>
                      <label className="preset-manager-field">
                        <span className="preset-manager-label">说明</span>
                        <input
                          className="preset-manager-input"
                          type="text"
                          value={selectedSkill.description || '上传的只读 Skill'}
                          readOnly
                        />
                      </label>
                      <label className="preset-manager-field">
                        <span className="preset-manager-label">来源</span>
                        <input
                          className="preset-manager-input"
                          type="text"
                          value={isAgentPackageSkill(selectedSkill)
                            ? `智能体：${selectedSkill.packageName}`
                            : selectedSkill.sourceType === 'folder' ? '文件夹' : '文件'}
                          readOnly
                        />
                      </label>
                      <label className="preset-manager-field">
                        <span className="preset-manager-label">入口文件</span>
                        <input
                          className="preset-manager-input"
                          type="text"
                          value={isAgentPackageSkill(selectedSkill)
                            ? selectedSkill.entryPath
                            : selectedSkill.entryFileName || selectedSkill.fileName}
                          readOnly
                        />
                      </label>
                      <label className="preset-manager-field">
                        <span className="preset-manager-label">保存位置</span>
                        <input
                          className="preset-manager-input"
                          type="text"
                          value={isAgentPackageSkill(selectedSkill)
                            ? '由智能体中心管理（只读）'
                            : selectedSkill.storagePath || '-'}
                          readOnly
                        />
                      </label>
                      <label className="preset-manager-field">
                        <span className="preset-manager-label">上传时间</span>
                        <input
                          className="preset-manager-input"
                          type="text"
                          value={formatDate(selectedSkill.createdAt)}
                          readOnly
                        />
                      </label>
                      <label className="preset-manager-field">
                        <span className="preset-manager-label">内容预览</span>
                        <textarea
                          className="preset-manager-input"
                          value={selectedSkill.content}
                          readOnly
                          rows={10}
                        />
                      </label>
                    </div>
                  ) : (
                    <div className="preset-manager-detail-empty">
                      选择左侧 Skill 查看内容
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
