import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { diag, redact } from '../lib/diag';
import { mpv, type MpvTrack } from '../lib/mpv';
import { clearPosition, getPosition, prefs, setPosition } from '../lib/store';
import type { PlaySpec } from '../lib/types';
import { cx } from '../lib/util';
import { copyText, Icon } from './ui';

const MAX_RECONNECTS = 8;

/** Downloaded file: the web view's "asset://" address is converted back to a local path for mpv. */
function toMpvUrl(u: string): string {
  const m = /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/(.+)$/.exec(u);
  return m ? decodeURIComponent(m[1]) : u;
}

const fmt = (s?: number) => {
  if (s == null || !isFinite(s)) return '--:--';
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const LANGS: Record<string, string> = {
  fre: 'Français', fra: 'Français', fr: 'Français', eng: 'Anglais', en: 'Anglais', ger: 'Allemand', deu: 'Allemand',
  spa: 'Espagnol', ita: 'Italien', ara: 'Arabe', por: 'Portugais', nld: 'Néerlandais', dut: 'Néerlandais', qad: 'Audiodescription',
};

function trackLabel(t: MpvTrack, i: number) {
  const lang = t.lang ? LANGS[t.lang.toLowerCase()] ?? t.lang.toUpperCase() : null;
  const parts = [t.title, lang].filter(Boolean);
  const codec = t.codec ? t.codec.toUpperCase().replace('DVB_SUBTITLE', 'DVB') : '';
  return `${parts.length ? parts.join(' · ') : `Piste ${i + 1}`}${codec ? ` (${codec})` : ''}`;
}

interface Status {
  loading: boolean;
  error?: string;
  reconnecting?: number;
}

/**
 * Native mpv player: the video is drawn below the page, inside this element's rectangle
 * (or the whole window in full screen). Controls, tracks and reconnection are handled here.
 */
export function MpvPlayer({ spec, mode, onClose }: { spec: PlaySpec; mode: 'inline' | 'overlay'; onClose?: () => void }) {
  const hole = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ loading: true });
  const [time, setTime] = useState<number>();
  const [duration, setDuration] = useState<number>();
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(() => Math.round(prefs.volume() * 100));
  const [muted, setMuted] = useState(false);
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const [menu, setMenu] = useState<'audio' | 'sub' | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [retry, setRetry] = useState(0);
  const hideTimer = useRef<number>(undefined);
  const timeRef = useRef<number | undefined>(undefined);
  const savedAt = useRef(0);
  const durationRef = useRef<number | undefined>(undefined);
  const live = spec.live;
  const big = fullscreen || mode === 'overlay';

  /* Picture placement: mpv margins computed from the element's rectangle. */
  const place = useCallback(() => {
    const el = hole.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (!W || !H) return;
    mpv
      .margins({ left: r.left / W, right: (W - r.right) / W, top: r.top / H, bottom: (H - r.bottom) / H })
      .catch(() => {});
  }, []);

  useLayoutEffect(() => {
    document.documentElement.classList.add('mpv-on');
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    const ro = new ResizeObserver(schedule);
    if (hole.current) ro.observe(hole.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [place, big]);

  /* Stop and clean up on unmount. */
  useEffect(
    () => () => {
      mpv.command('stop').catch(() => {});
      document.documentElement.classList.remove('mpv-on');
      getCurrentWindow().setFullscreen(false).catch(() => {});
    },
    [],
  );

  /* Full screen / movie player: black background and the rest of the UI hidden (the video is below the whole page). */
  useEffect(() => {
    mpv.set('background-color', big ? '#000000' : '#0d0f14').catch(() => {});
    document.documentElement.classList.toggle('mpv-full', big);
    return () => document.documentElement.classList.remove('mpv-full');
  }, [big]);

  /* Loading, reconnection and fallback to the next address. */
  useEffect(() => {
    let disposed = false;
    const urls = spec.urls.map(toMpvUrl);
    let index = 0;
    let reconnects = 0;
    let playing = false;
    let retryTimer: number | undefined;
    let stableTimer: number | undefined;
    let lastPos = -1;
    let frozen = 0;
    let resumeAt = 0;
    let stopping = false;
    const unl: (() => void)[] = [];

    const saved = !live && spec.resumeKey ? getPosition(spec.resumeKey) : undefined;
    if (saved && saved.t > 30 && (!saved.d || saved.t < saved.d - 60)) resumeAt = saved.t;

    let loadAt = 0;
    const load = (i: number) => {
      loadAt = performance.now();
      if (disposed) return;
      index = i;
      playing = false;
      lastPos = -1;
      frozen = 0;
      setStatus((s) => (s.reconnecting ? s : { loading: true }));
      diag('mpv lecture', live ? 'direct' : 'vod', spec.title, redact(urls[i]));
      const start = resumeAt > 0 ? String(Math.floor(resumeAt)) : 'none';
      mpv
        .set('start', start)
        .then(() => mpv.command('loadfile', urls[i], 'replace'))
        .catch((e) => fail(`chargement : ${e}`));
    };

    const fail = (why: string) => {
      if (disposed || stopping) return;
      diag('mpv échec', why);
      window.clearTimeout(stableTimer);
      if (playing && !live && timeRef.current != null) resumeAt = timeRef.current;
      // Dropped while playing: reload the address that was working.
      if (playing && reconnects < MAX_RECONNECTS) {
        reconnects++;
        playing = false;
        const delay = Math.min(1000 * 2 ** (reconnects - 1), 15000);
        setStatus({ loading: true, reconnecting: reconnects });
        retryTimer = window.setTimeout(() => load(index), delay);
        return;
      }
      if (!playing && index + 1 < urls.length) return load(index + 1);
      setStatus({ loading: false, error: why });
    };

    (async () => {
      unl.push(
        await mpv.onEvent((e) => {
          if (disposed) return;
          if (e.event === 'playback-restart') {
            if (!playing) diag('mpv lecture démarrée', `${Math.round(performance.now() - loadAt)} ms`);
            playing = true;
            mpv.set('start', 'none').catch(() => {});
            window.clearTimeout(stableTimer);
            stableTimer = window.setTimeout(() => (reconnects = 0), 30000);
            setStatus({ loading: false });
          } else if (e.event === 'file-loaded') {
            mpv.tracks().then((t) => !disposed && setTracks(t)).catch(() => {});
          } else if (e.event === 'end-file') {
            if (e.reason === 'error') fail(e.error ?? 'erreur de lecture');
            else if (e.reason === 'eof') {
              if (live) fail('fin du flux');
              else {
                if (spec.resumeKey) clearPosition(spec.resumeKey);
                spec.onEnded?.();
              }
            }
          }
        }),
      );
      unl.push(
        await mpv.onProp((name, value) => {
          if (disposed) return;
          switch (name) {
            case 'time-pos':
              if (typeof value === 'number') {
                setTime(value);
                timeRef.current = value;
                // Position saved every 5 s (movies and episodes).
                const d = durationRef.current;
                if (!live && spec.resumeKey && d && value > 5 && value < d - 30 && Date.now() - savedAt.current > 5000) {
                  savedAt.current = Date.now();
                  setPosition(spec.resumeKey, value, d);
                }
              }
              break;
            case 'duration':
              durationRef.current = typeof value === 'number' && value > 0 ? value : undefined;
              setDuration(durationRef.current);
              break;
            case 'pause':
              setPaused(value === true);
              break;
            case 'paused-for-cache':
              if (playing) setStatus((s) => (s.error || s.reconnecting ? s : { loading: value === true }));
              break;
            case 'volume':
              if (typeof value === 'number') setVolume(Math.round(value));
              break;
            case 'mute':
              setMuted(value === true);
              break;
            case 'aid':
            case 'sid':
            case 'track-list/count':
              mpv.tracks().then((t) => !disposed && setTracks(t)).catch(() => {});
              break;
          }
        }),
      );
      await mpv.set('volume', Math.round(prefs.volume() * 100)).catch(() => {});
      await mpv.set('pause', false).catch(() => {});
      load(0);
    })();

    // Frozen stream (live): the position no longer moves while playback is running.
    const watchdog = window.setInterval(async () => {
      if (disposed || !playing) return;
      const [pos, pausedNow] = await Promise.all([mpv.get('time-pos'), mpv.get('pause')]);
      if (pausedNow === 'yes' || pos == null) {
        frozen = 0;
        return;
      }
      const p = Number(pos);
      frozen = p === lastPos ? frozen + 2 : 0;
      lastPos = p;
      if (frozen >= (live ? 15 : 30)) {
        frozen = 0;
        fail('flux figé');
      }
    }, 2000);

    return () => {
      disposed = true;
      stopping = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(stableTimer);
      window.clearInterval(watchdog);
      unl.forEach((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.key, spec.urls.join('|'), retry]);

  const togglePause = useCallback(() => mpv.command('cycle', 'pause').catch(() => {}), []);
  const seekBy = useCallback((s: number) => !live && mpv.command('seek', s, 'relative').catch(() => {}), [live]);
  const setVol = (v: number) => {
    const n = Math.max(0, Math.min(100, Math.round(v)));
    setVolume(n);
    prefs.setVolume(n / 100);
    mpv.set('volume', n).catch(() => {});
    if (muted && n > 0) mpv.set('mute', false).catch(() => {});
  };

  const toggleFullscreen = useCallback(async () => {
    const next = !fullscreen;
    setFullscreen(next);
    await getCurrentWindow().setFullscreen(next).catch(() => {});
  }, [fullscreen]);

  /* Keyboard shortcuts. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'Escape') {
        if (!menu && !fullscreen && mode !== 'overlay') return;
        // Prevents the movie/series page underneath from closing at the same time.
        e.stopImmediatePropagation();
        if (menu) setMenu(null);
        else if (fullscreen) toggleFullscreen();
        else onClose?.();
      } else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
      else if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePause();
      } else if (e.key === 'm' || e.key === 'M') mpv.command('cycle', 'mute').catch(() => {});
      else if (big && e.key === 'ArrowRight') seekBy(10);
      else if (big && e.key === 'ArrowLeft') seekBy(-10);
      else if (big && e.key === 'ArrowUp') {
        e.preventDefault();
        setVol(volume + 5);
      } else if (big && e.key === 'ArrowDown') {
        e.preventDefault();
        setVol(volume - 5);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const poke = () => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 3000);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const audio = tracks.filter((t) => t.type === 'audio');
  const subs = tracks.filter((t) => t.type === 'sub');
  const pct = duration && time != null ? Math.min(100, ((seekPreview ?? time) / duration) * 100) : 0;
  const showChrome = chrome || paused || !!menu || !!status.error;

  return (
    <div
      className={cx('player mpv', mode, big && 'big', !showChrome && 'idle')}
      onMouseMove={poke}
      onMouseLeave={() => !paused && setChrome(false)}
    >
      <div ref={hole} className="mpv-hole" onClick={() => (menu ? setMenu(null) : togglePause())} onDoubleClick={toggleFullscreen} />

      {(mode === 'overlay' || fullscreen) && (
        <div className="player-top">
          <button className="icon-btn" onClick={fullscreen && mode !== 'overlay' ? toggleFullscreen : onClose} aria-label="Retour">
            <Icon name="back" size={22} />
          </button>
          <div className="player-titles">
            <div className="player-title">{spec.title}</div>
            {spec.subtitle && <div className="player-sub">{spec.subtitle}</div>}
          </div>
        </div>
      )}

      {status.loading && !status.error && (
        <div className="player-msg">
          <span className="spinner" />
          {status.reconnecting && (
            <span className="player-reconnect">
              Connexion perdue — reconnexion ({status.reconnecting}/{MAX_RECONNECTS})…
            </span>
          )}
        </div>
      )}

      {status.error && (
        <div className="player-msg error">
          <strong>Impossible de lire ce flux</strong>
          <small>{status.error}</small>
          <div className="row">
            <button className="btn" onClick={() => setRetry((r) => r + 1)}>
              <Icon name="refresh" size={16} /> Réessayer
            </button>
            <button
              className="btn ghost"
              onClick={async () => {
                if (await copyText(spec.urls[0])) {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                }
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Copiée' : "Copier l'adresse"}
            </button>
          </div>
        </div>
      )}

      <div className="mpv-controls" onClick={(e) => e.stopPropagation()}>
        {!live && duration ? (
          <div className="mpv-seek">
            <span className="mpv-time">{fmt(seekPreview ?? time)}</span>
            <input
              type="range"
              min={0}
              max={duration}
              step={1}
              value={seekPreview ?? time ?? 0}
              style={{ ['--pct' as string]: `${pct}%` }}
              onChange={(e) => setSeekPreview(Number(e.target.value))}
              onMouseUp={() => {
                if (seekPreview != null) mpv.command('seek', seekPreview, 'absolute').catch(() => {});
                setSeekPreview(null);
              }}
              onKeyUp={() => {
                if (seekPreview != null) mpv.command('seek', seekPreview, 'absolute').catch(() => {});
                setSeekPreview(null);
              }}
              aria-label="Position"
            />
            <span className="mpv-time">{fmt(duration)}</span>
          </div>
        ) : null}
        <div className="mpv-bar">
          <button className="icon-btn" onClick={togglePause} aria-label={paused ? 'Lecture' : 'Pause'}>
            <Icon name={paused ? 'play' : 'pause'} size={20} filled={paused} />
          </button>
          {!live && (
            <>
              <button className="icon-btn" onClick={() => seekBy(-10)} title="Reculer de 10 s">
                <Icon name="left" size={20} />
              </button>
              <button className="icon-btn" onClick={() => seekBy(30)} title="Avancer de 30 s">
                <Icon name="right" size={20} />
              </button>
            </>
          )}
          {live && (
            <span className="mpv-live">
              <span className="live-dot" /> Direct
            </span>
          )}
          <div className="mpv-volume">
            <button className="icon-btn" onClick={() => mpv.command('cycle', 'mute').catch(() => {})} aria-label="Muet">
              <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={20} />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : volume}
              style={{ ['--pct' as string]: `${muted ? 0 : volume}%` }}
              onChange={(e) => setVol(Number(e.target.value))}
              aria-label="Volume"
            />
          </div>
          <div className="topbar-spacer" />
          {audio.length > 1 && (
            <div className="mpv-menu-wrap">
              <button className={cx('btn ghost sm', menu === 'audio' && 'active')} onClick={() => setMenu(menu === 'audio' ? null : 'audio')}>
                <Icon name="volume" size={15} /> Audio
              </button>
              {menu === 'audio' && (
                <div className="mpv-menu">
                  {audio.map((t, i) => (
                    <button
                      key={t.id}
                      className={cx(t.selected && 'on')}
                      onClick={() => {
                        mpv.set('aid', t.id ?? 'auto').catch(() => {});
                        setMenu(null);
                      }}
                    >
                      {t.selected && <Icon name="check" size={14} />} {trackLabel(t, i)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {subs.length > 0 && (
            <div className="mpv-menu-wrap">
              <button className={cx('btn ghost sm', menu === 'sub' && 'active')} onClick={() => setMenu(menu === 'sub' ? null : 'sub')}>
                <Icon name="subtitles" size={15} /> Sous-titres
              </button>
              {menu === 'sub' && (
                <div className="mpv-menu">
                  <button
                    className={cx(!subs.some((s) => s.selected) && 'on')}
                    onClick={() => {
                      mpv.set('sid', 'no').catch(() => {});
                      setMenu(null);
                    }}
                  >
                    {!subs.some((s) => s.selected) && <Icon name="check" size={14} />} Désactivés
                  </button>
                  {subs.map((t, i) => (
                    <button
                      key={t.id}
                      className={cx(t.selected && 'on')}
                      onClick={() => {
                        mpv.set('sid', t.id ?? 'no').catch(() => {});
                        setMenu(null);
                      }}
                    >
                      {t.selected && <Icon name="check" size={14} />} {trackLabel(t, i)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button className="icon-btn" onClick={toggleFullscreen} title="Plein écran (F)" aria-label="Plein écran">
            <Icon name="expand" size={19} />
          </button>
        </div>
      </div>
    </div>
  );
}
