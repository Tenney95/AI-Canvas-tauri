import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import AssetSearchWindow from './components/AssetSearchWindow'

// 资源搜索窗口复用同一入口，通过 ?view=assets 区分
const isAssetSearchWindow =
  new URLSearchParams(window.location.search).get('view') === 'assets'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAssetSearchWindow ? <AssetSearchWindow /> : <App />}
  </StrictMode>,
)
