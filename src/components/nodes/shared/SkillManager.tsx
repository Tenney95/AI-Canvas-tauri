/**
 * SkillManager Skill 管理器 — 只读查看用户上传的 Skill，并支持删除
 */
import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '../../../store/useAppStore';
import AnimatedButton from '../../shared/AnimatedButton';

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
  const deleteSkill = useAppStore((s) => s.deleteSkill);
  const showToast = useAppStore((s) => s.showToast);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeSelectedId = selectedId ?? userSkills[0]?.id ?? null;

  const selectedSkill = useMemo(
    () => userSkills.find((skill) => skill.id === activeSelectedId) ?? userSkills[0] ?? null,
    [activeSelectedId, userSkills],
  );

  const handleDelete = useCallback(async (id: string) => {
    const skill = userSkills.find((item) => item.id === id);
    await deleteSkill(id);
    const remaining = userSkills.filter((item) => item.id !== id);
    setSelectedId(remaining[0]?.id ?? null);
    showToast(`已删除 Skill「${skill?.name ?? '未命名 Skill'}」`);
  }, [deleteSkill, showToast, userSkills]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
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
                  <div className="preset-modal-desc">查看已上传 Skill，删除不再使用的 Skill</div>
                </div>
                <AnimatedButton
                  type="button"
                  className="preset-manager-close-btn"
                  aria-label="关闭"
                  onClick={onClose}
                >
                  ×
                </AnimatedButton>
              </div>

              <div className="preset-manager-shell">
                <div className="preset-manager-sidebar">
                  <div className="preset-manager-list">
                    {userSkills.map((skill) => (
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
                            {skill.description || skill.fileName}
                          </span>
                        </span>
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
                      </div>
                    ))}
                    {userSkills.length === 0 && (
                      <div className="preset-manager-list-empty">
                        暂无 Skill，请在 / 指令菜单上传
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
                          value={selectedSkill.sourceType === 'folder' ? '文件夹' : '文件'}
                          readOnly
                        />
                      </label>
                      <label className="preset-manager-field">
                        <span className="preset-manager-label">入口文件</span>
                        <input
                          className="preset-manager-input"
                          type="text"
                          value={selectedSkill.entryFileName || selectedSkill.fileName}
                          readOnly
                        />
                      </label>
                      <label className="preset-manager-field">
                        <span className="preset-manager-label">保存位置</span>
                        <input
                          className="preset-manager-input"
                          type="text"
                          value={selectedSkill.storagePath || '-'}
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
