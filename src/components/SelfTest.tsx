import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { diag } from '../lib/diag';
import { mpv, mpvInit } from '../lib/mpv';
import type { PlaySpec } from '../lib/types';
import { Player } from './Player';

export interface SelfTestItem {
  title: string;
  url: string;
  live: boolean;
  seconds?: number;
  tsOverride?: PlaySpec['tsOverride'];
  forceEngine?: PlaySpec['forceEngine'];
  /** Play with native mpv; optional screenshot path */
  mpv?: boolean;
  shot?: string;
}

/**
 * Player self-test (development builds, ONDES_SELFTEST variable):
 * plays each stream for a few seconds and writes the result to the log.
 */
/** Event-loop lag: how late a 100 ms timer fires (UI responsiveness in the web view). */
const lag = { sum: 0, n: 0, max: 0 };
let lagLast = performance.now();
window.setInterval(() => {
  const now = performance.now();
  const d = Math.max(0, now - lagLast - 100);
  lagLast = now;
  lag.sum += d;
  lag.n += 1;
  lag.max = Math.max(lag.max, d);
}, 100);

export function SelfTest({ items }: { items: SelfTestItem[] }) {
  const [i, setI] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Playback engine errors and warnings also go to the log.
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (...a: unknown[]) => (diag('console.error', ...a.map(String)), origErr(...a));
    console.warn = (...a: unknown[]) => (diag('console.warn', ...a.map(String)), origWarn(...a));
    return () => {
      console.error = origErr;
      console.warn = origWarn;
    };
  }, []);

  /* mpv self-test: native engine, margins, properties and window view order */
  useEffect(() => {
    const it = items[i];
    if (!it?.mpv) return;
    let off = false;
    const unl: (() => void)[] = [];
    (async () => {
      const info = await mpvInit();
      diag('mpv init', info);
      if (!info || off) return;
      unl.push(await mpv.onEvent((e) => diag('mpv événement', e)));
      unl.push(await mpv.onLog((l) => diag('mpv log', l)));
      document.documentElement.classList.add('mpv-on');
      await mpv.margins({ left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 });
      if ((it.seconds ?? 12) > 15) await mpv.set('loop-file', 'inf');
      await mpv.command('loadfile', it.url).catch((e) => diag('mpv loadfile', String(e)));
      window.setTimeout(async () => {
        if (off) return;
        const names = ['time-pos', 'duration', 'video-params/w', 'video-params/h', 'video-params/pixelformat', 'hwdec-current', 'current-vo',
          'vo-configured', 'estimated-vf-fps', 'frame-drop-count', 'decoder-frame-drop-count', 'deinterlace', 'deinterlace-active', 'vf', 'video-codec', 'audio-codec-name', 'aid'];
        const props: Record<string, string | null> = {};
        for (const n of names) props[n] = await mpv.get(n).catch(() => null);
        diag('mpv bilan', it.title, props);
        diag('mpv pistes', (await mpv.tracks()).map((t) => `${t.type}#${t.id} ${t.codec} ${t.lang ?? ''}${t.selected ? ' *' : ''}`));
        diag('mpv vues', await mpv.debugViews());
        if (it.shot) await mpv.command('screenshot-to-file', it.shot, 'window').catch((e) => diag('mpv capture', String(e)));
      }, ((it.seconds ?? 12) - 2) * 1000);
    })();
    return () => {
      off = true;
      unl.forEach((f) => f());
    };
  }, [i, items]);

  useEffect(() => {
    if (i >= items.length) {
      diag('autotest terminé');
      return;
    }
    const it = items[i];
    diag('autotest', i, it.title);
    const t = window.setTimeout(async () => {
      const v = box.current?.querySelector('video');
      const stats = await invoke('mpv_stats').catch(() => null);
      diag('autotest perf', it.title, { ...(stats as object), lagAvgMs: Math.round(lag.sum / Math.max(1, lag.n)), lagMaxMs: Math.round(lag.max) });
      lag.sum = lag.n = lag.max = 0;
      diag('autotest bilan', it.title, {
        currentTime: v?.currentTime,
        readyState: v?.readyState,
        size: v ? `${v.videoWidth}x${v.videoHeight}` : null,
        paused: v?.paused,
        buffered: v ? Array.from({ length: v.buffered.length }, (_, k) => `${v.buffered.start(k).toFixed(3)}-${v.buffered.end(k).toFixed(3)}`).join(' ') : null,
        playbackRate: v?.playbackRate,
        error: v?.error ? `${v.error.code} ${v.error.message}` : null,
        message: box.current?.querySelector('.player-msg')?.textContent ?? null,
      });
      setI(i + 1);
    }, (it.seconds ?? 20) * 1000);
    return () => window.clearTimeout(t);
  }, [i, items]);

  const it = items[i];
  const spec: PlaySpec | null = it ? { key: `selftest-${i}`, title: it.title, urls: [it.url], live: it.live, tsOverride: it.tsOverride, forceEngine: it.forceEngine } : null;
  return (
    <div ref={box} style={{ width: '100%', height: '100%' }}>
      {it?.mpv ? (
        <div style={{ padding: 20, color: '#fff', background: 'rgba(200,0,0,.5)', width: 260 }}>Calque web (doit apparaître au-dessus de la vidéo)</div>
      ) : spec ? (
        <Player key={spec.key} spec={spec} mode="inline" />
      ) : (
        <p style={{ padding: 20 }}>Autotest terminé.</p>
      )}
    </div>
  );
}
