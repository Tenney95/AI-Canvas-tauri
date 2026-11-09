/**
 * NodeError — 节点报错提示
 *
 * 只展示节点已有错误；再次运行时由生成入口清除，不随时间修改节点状态。
 */
import { Icon } from '@iconify/react';
export default function NodeError({ message }: { nodeId: string; message: string }) {

  return (
    <div
      role="alert"
      aria-atomic="true"
      className="node-error nodrag nopan nowheel"
    >
      <Icon className="node-error__icon" icon="lucide:triangle-alert" width={13} height={13} aria-hidden="true" />
      <span className="node-error__message">{message}</span>
    </div>
  );
}
