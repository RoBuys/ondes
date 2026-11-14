import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { mediaSrc } from '../lib/net';
import { cx } from '../lib/util';
import { t } from '../lib/i18n';

const PATHS: Record<string, ReactNode> = {
  tv: (
    <>
      <rect x="3" y="6.5" width="18" height="12.5" rx="2.5" />
      <path d="M8.5 3l3.5 3.5L15.5 3" />
    </>
  ),
  guide: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M3 14.5h18M9 9.5v10.5M15 4v5.5M13 14.5V20" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21" />
    </>
  ),
  series: (
    <>
      <rect x="3" y="7.5" width="18" height="12.5" rx="2.5" />
      <path d="M6 4.5h12M10 11.5v5l4.5-2.5z" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  star: <path d="M12 3.6l2.55 5.2 5.75.84-4.15 4.05.98 5.72L12 16.7l-5.13 2.7.98-5.72L3.7 9.64l5.75-.84z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  play: <path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.6-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.35-5.65" />
      <path d="M20 4.5V9h-4.5" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  left: <path d="M14.5 6l-6 6 6 6" />,
  right: <path d="M9.5 6l6 6-6 6" />,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  trash: <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
      <path d="M15.5 8.5V5.5a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3" />
    </>
  ),
  file: (
    <>
      <path d="M14 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
      <path d="M14 3.5v5h5" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </>
  ),
  server: (
    <>
      <rect x="3.5" y="4" width="17" height="7" rx="2" />
      <rect x="3.5" y="13" width="17" height="7" rx="2" />
      <path d="M7.5 7.5h.01M7.5 16.5h.01" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  top: <path d="M6 18l6-6 6 6M6 6h12" />,
  eyeoff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13 13 0 0 1-2.6 3.7M6.6 6.6C4.4 8 3 10.2 2.5 12c1 2.5 4.5 7 9.5 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />,
  folder: <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  pause: <path d="M8.5 5v14M15.5 5v14" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  volume: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </>
  ),
  subtitles: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M7 13h4M13 13h4M7 16h7" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z" />
    </>
  ),
};

export function Icon({ name, size = 20, filled = false }: { name: keyof typeof PATHS | string; size?: number; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffc56b" />
          <stop offset="1" stopColor="#ff8a3d" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="208" fill="#1c2130" />
      <g fill="none" stroke="url(#lg)" strokeLinecap="round" strokeWidth="72">
        <path d="M232 560c56-120 112-120 168 0s112 120 168 0 112-120 168 0 56 90 56 90" />
        <path d="M300 380a300 300 0 0 1 424 0" opacity=".55" />
      </g>
    </svg>
  );
}

/** Remote image falling back to the initials. */
export function Img({ src, alt, className }: { src?: string; alt: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (!src || broken) {
    const initials = alt
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
    return <div className={cx(className, 'img-fallback')}>{initials || '•'}</div>;
  }
  return (
    <img
      className={className}
      src={mediaSrc(src)}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

/** Virtualized list with a fixed row height (playlists with tens of thousands of entries). */
export function VirtualList<T>({
  items,
  rowHeight,
  render,
  className,
  resetKey,
  ensureVisible,
}: {
  items: T[];
  rowHeight: number;
  render: (item: T, index: number) => ReactNode;
  className?: string;
  resetKey?: unknown;
  ensureVisible?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(800);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el || ensureVisible == null || ensureVisible < 0) return;
    const top = ensureVisible * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  }, [ensureVisible, rowHeight]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 6);
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + 6);

  return (
    <div ref={ref} className={cx('vlist', className)} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        {items.slice(start, end).map((it, i) => (
          <div key={start + i} style={{ position: 'absolute', top: (start + i) * rowHeight, left: 0, right: 0, height: rowHeight }}>
            {render(it, start + i)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Modal({ onClose, children, className }: { onClose: () => void; children: ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', className)} role="dialog" aria-modal="true">
        <button className="icon-btn modal-close" onClick={onClose} aria-label={t("Fermer")}>
          <Icon name="x" />
        </button>
        {children}
      </div>
    </div>
  );
}

export function useNow(interval = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(t);
  }, [interval]);
  return now;
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="search">
      <Icon name="search" size={17} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} />
      {value && (
        <button className="search-clear" onClick={() => onChange('')} aria-label={t("Effacer")}>
          <Icon name="x" size={15} />
        </button>
      )}
    </label>
  );
}

export interface GroupItem {
  id: string;
  label: string;
  count: number;
  icon?: string;
}

export function GroupList({
  groups,
  value,
  onChange,
  onManage,
}: {
  groups: GroupItem[];
  value: string;
  onChange: (id: string) => void;
  onManage?: () => void;
}) {
  return (
    <div className="groups">
      {onManage && (
        <button className="group manage" onClick={onManage} title={t("Masquer, renommer, réordonner les groupes")}>
          <Icon name="sliders" size={15} />
          <span className="group-label">{t("Organiser")}</span>
        </button>
      )}
      {groups.map((g) => (
        <button key={g.id} className={cx('group', g.id === value && 'on')} onClick={() => onChange(g.id)} title={g.label}>
          {g.icon && <Icon name={g.icon} size={15} filled={g.icon === 'star'} />}
          <span className="group-label">{g.label}</span>
          <span className="group-count">{g.count}</span>
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children, icon = 'tv' }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={30} />
      </div>
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
