import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import RootView from './RootView'
import type { AppConfig } from './types'

// 复用同一入口，通过 ?view= 区分窗口类型
const searchParams = new URLSearchParams(window.location.search)
const view = searchParams.get('view')
const isChatWindow = view === 'chat'

if (isChatWindow && /Windows NT/i.test(navigator.userAgent)) {
  document.documentElement.setAttribute('data-chat-window-platform', 'windows')
}

async function applyInitialChatWindowTheme() {
  if (!isChatWindow) return

  let effectiveTheme: AppConfig['theme'] = 'dark'
  try {
    const { loadConfig } = await import('./services/fileService')
    const config = await loadConfig() as AppConfig | null
    effectiveTheme = config?.canvasBackground === 'off-white'
      ? 'light'
      : config?.theme === 'light' ? 'light' : 'dark'
  } catch (error) {
    console.warn('[main] failed to load chat window theme:', error)
  }
  document.documentElement.setAttribute('data-theme', effectiveTheme)
}

async function mountRoot() {
  await applyInitialChatWindowTheme()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RootView view={view} />
    </StrictMode>,
  )
}

void mountRoot()
