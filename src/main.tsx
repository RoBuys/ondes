import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { SelfTest, type SelfTestItem } from './components/SelfTest';
import { mpvInit } from './lib/mpv';
import { initNet, isTauri } from './lib/net';
import { prefs } from './lib/store';
import './styles.css';

async function selfTestItems(): Promise<SelfTestItem[] | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<string | null>('selftest_spec');
    return raw ? (JSON.parse(raw) as SelfTestItem[]) : null;
  } catch {
    return null;
  }
}

(async () => {
  await initNet();
  if (isTauri && prefs.settings().engine !== 'web') {
    const info = await mpvInit();
    const { diag } = await import('./lib/diag');
    diag('mpv', info ?? 'indisponible');
  }
  const tests = await selfTestItems();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>{tests ? <SelfTest items={tests} /> : <App />}</StrictMode>,
  );
})();
