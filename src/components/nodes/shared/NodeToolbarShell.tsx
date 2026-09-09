import { memo, useState, type ReactNode } from 'react';

interface NodeToolbarShellProps {
  visible?: boolean;
  children: ReactNode;
}

/** 首次显示才挂载工具栏；随后保留子树，避免淡出时丢失编辑状态或已打开的弹窗。 */
function NodeToolbarShell({ visible = false, children }: NodeToolbarShellProps) {
  const [hasOpened, setHasOpened] = useState(visible);
  if (visible && !hasOpened) setHasOpened(true);

  return (
    <div className={`node-toolbar-shell ${visible ? 'is-visible' : ''}`}>
      {visible || hasOpened ? children : null}
    </div>
  );
}

export default memo(NodeToolbarShell);
