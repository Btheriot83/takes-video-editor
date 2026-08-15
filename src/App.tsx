import { useEffect } from 'react';
import { Routes, Route } from 'react-router';
import { useStore } from './state/store';
import Camera from './screens/Camera';
import Editor from './screens/Editor';

function Main() {
  const { ready, screen, init, recoveredNotice, dismissNotice } = useStore();

  useEffect(() => { init(); }, [init]);

  if (!ready) {
    return (
      <div className="fixed inset-0 bg-black text-white flex items-center justify-center">
        <div className="text-white/60 text-sm animate-pulse">Loading…</div>
      </div>
    );
  }

  return (
    <>
      {screen === 'camera' ? <Camera /> : <Editor />}
      {recoveredNotice && (
        <div className="fixed top-4 inset-x-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-[60] bg-neutral-900 border border-amber-400/40 rounded-xl px-4 py-3 text-sm flex items-center gap-3">
          <span>{recoveredNotice}</span>
          <button onClick={dismissNotice} className="text-white/50 text-xs underline">Dismiss</button>
        </div>
      )}
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Main />} />
    </Routes>
  );
}
