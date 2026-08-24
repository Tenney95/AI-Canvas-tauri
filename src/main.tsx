/**
 * React 应用入口，根据查询参数选择主窗口或独立窗口，并在挂载前应用窗口主题。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import RootView from './RootView'
import type { AppConfig } from './types'
import { setLocale } from './i18n'

// 复用同一入口，通过 ?view= 区分窗口类型
const searchParams = new URLSearchParams(window.location.search)
const view = searchParams.get('view')
const isChatWindow = view === 'chat'

if (/Windows NT/i.test(navigator.userAgent)) {
  // Windows 走 ClearType 次像素抗锯齿，见 base.css 的 font-smoothing 分支
  document.documentElement.setAttribute('data-os', 'windows')
  if (isChatWindow) {
    document.documentElement.setAttribute('data-chat-window-platform', 'windows')
  }
}

async function applyInitialChatWindowTheme() {
  if (!isChatWindow) return

  let effectiveTheme: AppConfig['theme'] = 'dark'
  let nativeCursor = false
  try {
    // 只要主题字段，不必为此去读凭据存储
    const { loadConfigWithoutSecrets } = await import('./services/fileService')
    const config = await loadConfigWithoutSecrets() as AppConfig | null
    effectiveTheme = config?.canvasBackground === 'off-white'
      ? 'light'
      : config?.theme === 'light' ? 'light' : 'dark'
    // 与主题同批应用，避免独立窗口先闪一帧中文
    nativeCursor = config?.customCursor === false
    setLocale(config?.language)
  } catch (error) {
    console.warn('[main] failed to load chat window theme:', error)
  }
  document.documentElement.setAttribute('data-theme', effectiveTheme)
  document.documentElement.toggleAttribute('data-native-cursor', nativeCursor)
}

async function mountRoot() {
  await applyInitialChatWindowTheme()
  const { installMcpScreenshotResponder } = await import('./services/mcp/mcpUiRuntimeService')
  void installMcpScreenshotResponder()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RootView view={view} />
    </StrictMode>,
  )
}

void mountRoot()
