import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import RootView from './RootView'

// 复用同一入口，通过 ?view= 区分窗口类型
const searchParams = new URLSearchParams(window.location.search)
const view = searchParams.get('view')
const isChatWindow = view === 'chat'

if (isChatWindow && /Windows NT/i.test(navigator.userAgent)) {
  document.documentElement.setAttribute('data-chat-window-platform', 'windows')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootView view={view} />
  </StrictMode>,
)
