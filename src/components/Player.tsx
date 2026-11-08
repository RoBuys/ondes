import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaSrc, proxied } from '../lib/net';
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

/** Ordre d'essai des moteurs pour un flux : on bascule au suivant en cas d'échec. */
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

interface State {
  loading: boolean;
  error?: string;
  /** Numéro de la tentative de reconnexion en cours */
  reconnecting?: number;
}

const MAX_RECONNECTS = 8;

export function Player({
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

  /* Moteur de lecture, avec reconnexion automatique */
  useEffect(() => {
    const v = videoRef.current!;
    const attempts = attemptsFor(spec.urls, spec.live);
    let disposed = false;
    let token = -1;
    let destroy: (() => void) | null = null;
    let engine: Engine | null = null;
    let timer: number | undefined;
    let retryTimer: number | undefined;
    let hadPlayed = false;
    let working = 0;
    let reconnects = 0;
    let resumeAt = 0;
    let lastT = -1;
    let frozenFor = 0;

    const teardown = () => {
      window.clearTimeout(timer);
      if (destroy) {
        try {
          destroy();
        } catch {
          /* ignoré */
        }
        destroy = null;
      }
      if (v.getAttribute('src')) {
        v.removeAttribute('src');
        try {
          v.load();
        } catch {
          /* ignoré */
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
      if (hadPlayed && !spec.live && v.currentTime > 1) resumeAt = v.currentTime;
      teardown();
      // Coupure en cours de lecture : on relance la source qui fonctionnait, avec un délai croissant.
      if (hadPlayed && reconnects < MAX_RECONNECTS) return scheduleReconnect();
      if (!hadPlayed && t + 1 < attempts.length) return run(t + 1);
      token = -1;
      setState({ loading: false, error: hadPlayed ? `Connexion perdue (${why})` : why });
    };

    const run = (i: number): void => {
      token = i;
      const t = i;
      const a = attempts[i];
      engine = a.engine;
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
            { type: 'mpegts', isLive: spec.live, url: proxied(a.url) },
            {
              enableWorker: true,
              enableStashBuffer: !spec.live,
              liveBufferLatencyChasing: spec.live,
              autoCleanupSourceBuffer: true,
              lazyLoad: !spec.live,
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
      if (token >= 0) {
        hadPlayed = true;
        working = token;
        reconnects = 0;
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
      fail(token, `Format non pris en charge (code ${err.code})`);
    };

    // Détection de flux figé : l'image ne progresse plus alors que la lecture est en cours.
    const watchdog = window.setInterval(() => {
      if (token < 0 || !hadPlayed || v.paused || v.ended) {
        frozenFor = 0;
        return;
      }
      if (v.currentTime === lastT) frozenFor += 2;
      else frozenFor = 0;
      lastT = v.currentTime;
      if (frozenFor >= (spec.live ? 12 : 20)) fail(token, 'flux figé');
    }, 2000);

    // Retour du réseau : on n'attend pas la fin du délai.
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

  /* Reprise de lecture et fin */
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

  /* Volume mémorisé */
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

  /* Raccourcis clavier (lecteur plein écran) */
  useEffect(() => {
    if (mode !== 'overlay') return;
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current!;
      if (e.key === 'Escape') {
        // Empêche la fiche film/série située dessous de se fermer en même temps.
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
