import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { diag, logEnvironment, redact } from '../lib/diag';
import { mpvEnabled } from '../lib/mpv';
import { mediaSrc, proxied } from '../lib/net';
import { MpvPlayer } from './MpvPlayer';
import { clearPosition, getPosition, prefs, setPosition } from '../lib/store';
import type { PlaySpec } from '../lib/types';
import { cx } from '../lib/util';
import { copyText, Icon } from './ui';

type Engine = 'hls' | 'ts' | 'native';
interface Attempt {
  url: string;
  engine: Engine;
}

function kindOf(url: string): Engine | 'unknown' {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
  if (path.endsWith('.ts') || path.endsWith('.mpegts')) return 'ts';
  if (/\.(mp4|m4v|mkv|webm|mov|avi|mp3|aac|ogg)$/.test(path)) return 'native';
  return 'unknown';
}

/** Order in which engines are tried for a stream: we switch to the next one on failure. */
function attemptsFor(urls: string[], live: boolean): Attempt[] {
  const out: Attempt[] = [];
  for (const url of urls) {
    const k = kindOf(url);
    if (k === 'unknown') {
      if (live) out.push({ url, engine: 'ts' }, { url, engine: 'hls' });
      else out.push({ url, engine: 'native' }, { url, engine: 'hls' });
    } else {
      out.push({ url, engine: k });
      if (k === 'native' && !live) out.push({ url, engine: 'ts' });
    }
  }
  return out;
}

/** Seconds of data available after the current position. */
function bufferedAhead(v: HTMLVideoElement): number {
  const t = v.currentTime;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= t + 0.05 && v.buffered.end(i) > t) return v.buffered.end(i) - t;
  }
  return 0;
}

interface State {
  loading: boolean;
  error?: string;
  /** Number of the reconnection attempt in progress */
  reconnecting?: number;
}

const MAX_RECONNECTS = 8;

/** Player: native mpv when available, otherwise the web player (hls.js / mpegts.js). */
export function Player(props: { spec: PlaySpec; mode: 'inline' | 'overlay'; onClose?: () => void }) {
  const forced = props.spec.forceEngine || props.spec.tsOverride;
  return mpvEnabled() && !forced ? <MpvPlayer {...props} /> : <WebPlayer {...props} />;
}

function WebPlayer({
  spec,
  mode,
  onClose,
}: {
  spec: PlaySpec;
  mode: 'inline' | 'overlay';
  onClose?: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>({ loading: true });
  const [retry, setRetry] = useState(0);
  const [chrome, setChrome] = useState(true);
  const [copied, setCopied] = useState(false);
  const hideTimer = useRef<number>(undefined);
  const urlsKey = spec.urls.join('|');

  /* Playback engine, with automatic reconnection */
  useEffect(() => {
    const v = videoRef.current!;
    const attempts = spec.forceEngine ? spec.urls.map((url) => ({ url, engine: spec.forceEngine! })) : attemptsFor(spec.urls, spec.live);
    logEnvironment({ hlsSupported: Hls.isSupported(), mpegtsSupported: mpegts.isSupported(), mpegts: mpegts.getFeatureList() });
    diag('lecture', spec.live ? 'direct' : 'vod', spec.title, attempts.map((a) => `${a.engine}:${redact(a.url)}`));
    let disposed = false;
    let token = -1;
    let destroy: (() => void) | null = null;
    let engine: Engine | null = null;
    let timer: number | undefined;
    let retryTimer: number | undefined;
    let hadPlayed = false;
    let working = 0;
    let reconnects = 0;
    let stableTimer: number | undefined;
    let resumeAt = 0;
    let lastT = -1;
    let frozenFor = 0;

    const teardown = () => {
      window.clearTimeout(timer);
      if (destroy) {
        try {
          destroy();
        } catch {
          /* ignored */
        }
        destroy = null;
      }
      if (v.getAttribute('src')) {
        v.removeAttribute('src');
        try {
          v.load();
        } catch {
          /* ignored */
        }
      }
    };

    const scheduleReconnect = (): void => {
      reconnects++;
      token = -2;
      const delay = Math.min(1000 * 2 ** (reconnects - 1), 15000);
      setState({ loading: true, reconnecting: reconnects });
      retryTimer = window.setTimeout(() => !disposed && run(working), delay);
    };

    const fail = (t: number, why: string): void => {
      if (disposed || t !== token) return;
      diag('échec', t, attempts[t]?.engine, why);
      if (hadPlayed && !spec.live && v.currentTime > 1) resumeAt = v.currentTime;
      window.clearTimeout(stableTimer);
      teardown();
      // Decode error: reloading the same source would not help, switch to the next engine.
      const decode = /code 3|decode|MSEError|MediaError/i.test(why);
      if (decode && t + 1 < attempts.length) return run(t + 1);
      // Dropped while playing: reload the source that was working, with an increasing delay.
      if (hadPlayed && !decode && reconnects < MAX_RECONNECTS) return scheduleReconnect();
      if (!hadPlayed && t + 1 < attempts.length) return run(t + 1);
      token = -1;
      setState({ loading: false, error: hadPlayed ? `Connexion perdue (${why})` : why });
    };

    const run = (i: number): void => {
      token = i;
      const t = i;
      const a = attempts[i];
      engine = a.engine;
      diag('essai', i, a.engine, redact(a.url));
      lastT = -1;
      frozenFor = 0;
      setState((s) => (s.reconnecting ? s : { loading: true }));
      timer = window.setTimeout(() => fail(t, 'Le flux ne répond pas (délai dépassé)'), spec.live ? 15000 : 25000);
      try {
        if (a.engine === 'hls') {
          if (Hls.isSupported()) {
            const hls = new Hls({
              enableWorker: true,
              maxBufferLength: spec.live ? 20 : 60,
              manifestLoadingTimeOut: 8000,
              manifestLoadingMaxRetry: 1,
              levelLoadingMaxRetry: 3,
              fragLoadingMaxRetry: 4,
              startPosition: resumeAt > 0 ? resumeAt : -1,
            });
            let recovered = false;
            hls.on(Hls.Events.ERROR, (_e, d) => {
              if (!d.fatal) return;
              if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
                recovered = true;
                hls.recoverMediaError();
                return;
              }
              fail(t, `HLS : ${d.details}`);
            });
            hls.loadSource(proxied(a.url));
            hls.attachMedia(v);
            destroy = () => hls.destroy();
          } else {
            v.src = mediaSrc(a.url);
          }
        } else if (a.engine === 'ts') {
          if (!mpegts.isSupported()) return fail(t, 'MPEG-TS non pris en charge');
          const p = mpegts.createPlayer(
            { type: 'mpegts', isLive: spec.tsOverride?.isLive ?? spec.live, url: proxied(a.url) },
            {
              enableWorker: true,
              enableStashBuffer: !spec.live,
              liveBufferLatencyChasing: spec.live,
              autoCleanupSourceBuffer: true,
              lazyLoad: !spec.live,
              ...spec.tsOverride?.config,
            },
          );
          p.on(mpegts.Events.ERROR, (type: string, detail: string) => fail(t, `MPEG-TS : ${type} / ${detail}`));
          p.attachMediaElement(v);
          p.load();
          destroy = () => {
            p.pause();
            p.unload();
            p.detachMediaElement();
            p.destroy();
          };
        } else {
          v.src = mediaSrc(a.url);
        }
        v.play().catch(() => {});
      } catch (e) {
        fail(t, e instanceof Error ? e.message : String(e));
      }
    };

    const onPlaying = () => {
      window.clearTimeout(timer);
      if (!hadPlayed) diag('lecture démarrée', engine, `${v.videoWidth}x${v.videoHeight}`);
      if (token >= 0) {
        hadPlayed = true;
        working = token;
        // The reconnection counter is only reset after 30 s of stable playback,
        // otherwise a stream that starts then fails right away would be reloaded forever.
        window.clearTimeout(stableTimer);
        stableTimer = window.setTimeout(() => (reconnects = 0), 30000);
      }
      setState({ loading: false });
    };
    const onCanPlay = () => {
      window.clearTimeout(timer);
      setState((s) => (s.error || s.reconnecting ? s : { loading: false }));
    };
    const onMeta = () => {
      if (resumeAt > 0 && engine !== 'hls') {
        v.currentTime = resumeAt;
      }
      resumeAt = 0;
    };
    const onWaiting = () => setState((s) => (s.error || s.reconnecting ? s : { loading: true }));
    const onError = () => {
      if (engine === 'hls' || token < 0) return;
      const err = v.error;
      if (!err) return;
      diag('erreur média', engine, err.code, err.message);
      fail(token, `Format non pris en charge (code ${err.code})`);
    };

    // Frozen stream detection: the picture no longer moves while playback is running.
    let nudges = 0;
    const watchdog = window.setInterval(() => {
      if (token < 0 || v.paused || v.ended || v.seeking) {
        frozenFor = 0;
        lastT = v.currentTime;
        return;
      }
      if (v.currentTime === lastT) frozenFor += 1;
      else {
        frozenFor = 0;
        nudges = 0;
      }
      lastT = v.currentTime;
      // WebKit (macOS): the media clock sometimes stays stuck at the start even though the data is there.
      // A small jump forward restarts it.
      if (frozenFor >= 2 && nudges < 3 && v.readyState >= 3 && bufferedAhead(v) > 0.5) {
        nudges++;
        frozenFor = 0;
        diag('relance image figée', v.currentTime.toFixed(3));
        v.currentTime = v.currentTime + 0.1;
        return;
      }
      if (hadPlayed && frozenFor >= (spec.live ? 12 : 20)) fail(token, 'flux figé');
    }, 1000);

    // Network is back: no need to wait for the delay to expire.
    const onOnline = () => {
      if (token === -2) {
        window.clearTimeout(retryTimer);
        run(working);
      }
    };

    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('error', onError);
    window.addEventListener('online', onOnline);
    if (attempts.length) run(0);
    else setState({ loading: false, error: 'Aucune adresse de flux' });

    return () => {
      disposed = true;
      window.clearInterval(watchdog);
      window.clearTimeout(retryTimer);
      window.clearTimeout(stableTimer);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('error', onError);
      window.removeEventListener('online', onOnline);
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.key, urlsKey, spec.live, retry]);

  /* Resume and end of playback */
  useEffect(() => {
    const v = videoRef.current!;
    const key = spec.resumeKey;
    let last = 0;
    const onMeta = () => {
      if (!key || spec.live) return;
      const p = getPosition(key);
      if (p && p.t > 30 && (!isFinite(v.duration) || p.t < v.duration - 60)) v.currentTime = p.t;
    };
    const onTime = () => {
      if (!key || spec.live) return;
      const n = Date.now();
      if (n - last < 5000) return;
      last = n;
      if (isFinite(v.duration) && v.duration > 0 && v.currentTime > 5) setPosition(key, v.currentTime, v.duration);
    };
    const onEnded = () => {
      if (key) clearPosition(key);
      spec.onEnded?.();
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('ended', onEnded);
    return () => {
      if (key && !spec.live && isFinite(v.duration) && v.currentTime > 5 && v.currentTime < v.duration - 30) {
        setPosition(key, v.currentTime, v.duration);
      }
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('ended', onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.key]);

  /* Remembered volume */
  useEffect(() => {
    const v = videoRef.current!;
    v.volume = Math.max(0, Math.min(1, prefs.volume()));
    const onVol = () => prefs.setVolume(v.volume);
    v.addEventListener('volumechange', onVol);
    return () => v.removeEventListener('volumechange', onVol);
  }, []);

  const toggleFs = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else wrap.current?.requestFullscreen().catch(() => {});
  }, []);

  /* Keyboard shortcuts (full-screen player) */
  useEffect(() => {
    if (mode !== 'overlay') return;
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current!;
      if (e.key === 'Escape') {
        // Prevents the movie/series page underneath from closing at the same time.
        e.stopImmediatePropagation();
        if (!document.fullscreenElement) onClose?.();
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFs();
      } else if ((e.key === ' ' || e.key === 'k') && e.target !== v) {
        e.preventDefault();
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      } else if (!spec.live && e.key === 'ArrowRight' && e.target !== v) {
        v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10);
      } else if (!spec.live && e.key === 'ArrowLeft' && e.target !== v) {
        v.currentTime = Math.max(0, v.currentTime - 10);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode, onClose, toggleFs, spec.live]);

  const poke = () => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 2800);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const copy = async () => {
    if (await copyText(spec.urls[0])) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <div ref={wrap} className={cx('player', mode, !chrome && 'idle')} onMouseMove={poke}>
      <video ref={videoRef} controls autoPlay playsInline poster={spec.poster ? mediaSrc(spec.poster) : undefined} />
      {mode === 'overlay' && (
        <div className="player-top">
          <button className="icon-btn" onClick={onClose} aria-label="Retour">
            <Icon name="back" size={22} />
          </button>
          <div className="player-titles">
            <div className="player-title">{spec.title}</div>
            {spec.subtitle && <div className="player-sub">{spec.subtitle}</div>}
          </div>
        </div>
      )}
      {mode === 'inline' && (
        <button className="icon-btn player-fs" onClick={toggleFs} title="Plein écran" aria-label="Plein écran">
          <Icon name="expand" size={18} />
        </button>
      )}
      {state.loading && !state.error && (
        <div className="player-msg">
          <span className="spinner" />
          {state.reconnecting && (
            <span className="player-reconnect">
              Connexion perdue — reconnexion ({state.reconnecting}/{MAX_RECONNECTS})…
            </span>
          )}
        </div>
      )}
      {state.error && (
        <div className="player-msg error">
          <strong>Impossible de lire ce flux</strong>
          <small>{state.error}</small>
          <div className="row">
            <button className="btn" onClick={() => setRetry((r) => r + 1)}>
              <Icon name="refresh" size={16} /> Réessayer
            </button>
            <button className="btn ghost" onClick={copy}>
              <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Copiée' : "Copier l'adresse"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
