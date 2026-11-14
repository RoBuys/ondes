import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { SelfTest, type SelfTestItem } from './components/SelfTest';
import { mpvInit } from './lib/mpv';
import { initNet, isTauri } from './lib/net';
import { lang } from './lib/i18n';
import { prefs } from './lib/store';

document.documentElement.lang = lang;
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
    // Prefer audio in the interface language (French broadcasts often carry English or audio-description tracks).
    if (info) {
      const { mpv } = await import('./lib/mpv');
      await mpv.set('alang', lang === 'en' ? 'eng,en,english,fre,fra,fr' : 'fre,fra,fr,french,eng,en').catch(() => {});
    }
    const { diag } = await import('./lib/diag');
    diag('mpv', info ?? 'indisponible');
  }
  const tests = await selfTestItems();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>{tests ? <SelfTest items={tests} /> : <App />}</StrictMode>,
  );
})();
