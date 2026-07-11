/**
 * ChatInput — 输入区组件
 *
 * 包含输入框 + 三组模型选择器（文本 / 生图 / 视频）+ 发送按钮 + 免责声明。
 * 模型选择器直接复用节点中的 ModelSelector 组件，通过 ChatModelSelector 包装桥接。
 */
import { useRef, useEffect, useCallback } from 'react';
import { Icon } from '@iconify/react';
import AnimatedButton from '../shared/AnimatedButton';
import ChatModelSelector from './ChatModelSelector';

interface ChatInputProps {
  /** 当前选中的文本模型 ID */
  assistantModelId?: string;
  /** 当前选中的图片模型 ID */
  assistantImageModelId?: string;
  /** 当前选中的视频模型 ID */
  assistantVideoModelId?: string;
  onAssistantModelChange: (modelId?: string) => void;
  onImageModelChange: (modelId?: string) => void;
  onVideoModelChange: (modelId?: string) => void;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
}

export default function ChatInput({
  assistantModelId,
  assistantImageModelId,
  assistantVideoModelId,
  onAssistantModelChange,
  onImageModelChange,
  onVideoModelChange,
  inputValue,
  onInputChange,
  onSend,
  disabled = false,
}: ChatInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend],
  );

  // 自动聚焦
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  return (
    <div className="chat-panel-input-area flex-shrink-0 px-3 pt-2 pb-1">
      <div
        className="chat-panel-input-box flex flex-col bg-canvas-card border border-canvas-border rounded-[14px]
                    focus-within:border-canvas-text-secondary transition-colors px-4 pt-4 pb-3 shadow-lg"
      >
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，描述你想对画布进行的修改"
          rows={1}
          disabled={disabled}
          className="chat-panel-textarea w-full resize-none bg-transparent text-[15px] leading-6 text-canvas-text
                     placeholder:text-canvas-text-muted outline-none
                     min-h-[64px] max-h-[160px]"
        />

        <div className="chat-panel-input-toolbar mt-2 flex items-end justify-between gap-3">
          {/* ── 三组模型选择器：直接复用节点中 ModelSelector ── */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* 文本模型（助手对话） */}
            <ChatModelSelector
              category="text"
              selectedId={assistantModelId}
              onSelect={onAssistantModelChange}
            />

            {/* 生图模型 */}
            <ChatModelSelector
              category="image"
              selectedId={assistantImageModelId}
              onSelect={onImageModelChange}
            />

            {/* 生视频模型 */}
            <ChatModelSelector
              category="video"
              selectedId={assistantVideoModelId}
              onSelect={onVideoModelChange}
            />
          </div>

          <AnimatedButton
            scale={1.05}
            disabled={!inputValue.trim() || disabled}
            aria-label="发送消息"
            className={`chat-panel-send-btn flex shrink-0 items-center justify-center w-10 h-10 rounded-full transition-colors
                        ${inputValue.trim() && !disabled
                          ? 'bg-canvas-text text-canvas-bg hover:opacity-90'
                          : 'bg-canvas-hover text-canvas-text-muted cursor-not-allowed'
                        }`}
            onClick={onSend}
          >
            <Icon icon="mdi:arrow-up" width="20" height="20" />
          </AnimatedButton>
        </div>
      </div>

      {/* Disclaimer */}
      <p className="chat-panel-disclaimer text-[10px] text-canvas-text-muted mt-1 text-center px-4">
        AI 助手仅理解画布操作指令，不会执行未授权的修改。
      </p>
    </div>
  );
}
