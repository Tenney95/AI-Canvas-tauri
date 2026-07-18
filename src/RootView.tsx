import { lazy, Suspense } from 'react';

const App = lazy(() => import('./App'));
const AssetSearchWindow = lazy(() => import('./components/AssetSearchWindow'));
const ChatWindow = lazy(() => import('./components/chat/ChatWindow'));

interface RootViewProps {
  view: string | null;
}

export default function RootView({ view }: RootViewProps) {
  return (
    <Suspense fallback={null}>
      {view === 'assets' ? <AssetSearchWindow /> : view === 'chat' ? <ChatWindow /> : <App />}
    </Suspense>
  );
}
