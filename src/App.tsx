import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GuideView } from './components/Guide';
import { LiveView } from './components/Live';
import { DownloadsView } from './components/Downloads';
import { ItemModal, OrganizeModal, type ItemTarget } from './components/Organize';
import { Player } from './components/Player';
import { SearchView } from './components/Search';
import { AddSourceForm, DEMO_SOURCE, SettingsView } from './components/Settings';
import { Icon, Logo, SearchBox } from './components/ui';
import { FavoritesView } from './components/Favorites';
import { MoviesView, SeriesView } from './components/Vod';
import { Ctx, useApp, type AppCtx, type EpgStatus, type PendingOpen, type Status, type View } from './context';
import { applyRules, loadRules, saveRules, type ContentRules, type Kind } from './lib/content';
import { downloadsAvailable, useDownloads } from './lib/downloads';
import { loadLists, saveLists, type ChannelList } from './lib/lists';
import { epgUrlFor, loadCatalog, loadEpg, markNewTitles } from './lib/catalog';
import { db, prefs } from './lib/store';
import type { Catalog, Epg, PlaySpec, Section, Settings, Source } from './lib/types';
import { cx, errMsg, fmtCount, uid } from './lib/util';
import { t } from './lib/i18n';

const DAY = 86400_000;
const EPG_TTL = 12 * 3600_000;

const NAV: { id: View & Section; label: string; icon: string }[] = [
  { id: 'live', label: t("Direct"), icon: 'tv' },
  { id: 'guide', label: t("Guide"), icon: 'guide' },
  { id: 'movies', label: t("Films"), icon: 'film' },
  { id: 'series', label: t("Séries"), icon: 'series' },
];

export default function App() {
  const [sources, setSources] = useState<Source[]>(prefs.sources);
  const [activeId, setActiveIdState] = useState<string | null>(() => prefs.activeId() ?? prefs.sources()[0]?.id ?? null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [status, setStatus] = useState<Status>({ loading: false });
  const [epg, setEpg] = useState<Epg | null>(null);
  const [epgStatus, setEpgStatus] = useState<EpgStatus>({ state: 'none' });
  const [settings, setSettingsState] = useState<Settings>(prefs.settings);
  const [favs, setFavs] = useState<Set<string>>(prefs.favorites);
  const [view, setView] = useState<View>(() => prefs.get<View>('view', 'live'));
  const [liveSel, setLiveSelState] = useState<string | null>(() => prefs.get<string | null>('liveSel', null));
  const [overlay, setOverlay] = useState<PlaySpec | null>(null);
  const [rules, setRulesState] = useState<ContentRules>(() => loadRules(activeId ?? ''));
  const [lists, setListsState] = useState<ChannelList[]>(() => loadLists(activeId ?? ''));
  const [organizeKind, setOrganizeKind] = useState<Kind | 'lists' | null>(null);
  const [itemTarget, setItemTarget] = useState<ItemTarget | null>(null);
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
  const [globalQ, setGlobalQ] = useState('');
  const prevView = useRef<View>('live');
  const downloads = useDownloads();

  const active = useMemo(() => sources.find((s) => s.id === activeId) ?? null, [sources, activeId]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const loadSeq = useRef(0);
  const epgSeq = useRef(0);

  useEffect(() => {
    if (view !== 'search') prefs.set('view', view);
  }, [view]);

  useEffect(() => {
    setRulesState(loadRules(active?.id ?? ''));
    setListsState(loadLists(active?.id ?? ''));
  }, [active?.id]);
  const setLists = useCallback((l: ChannelList[]) => {
    const id = activeRef.current?.id;
    if (!id) return;
    saveLists(id, l);
    setListsState(l);
  }, []);

  /* Tabs shown for the active source; leave a tab that has been hidden. */
  const sectionOn = (s: Section) => active?.sections?.[s] !== false;
  const nav = NAV.filter((n) => sectionOn(n.id));
  useEffect(() => {
    if ((['live', 'guide', 'movies', 'series'] as View[]).includes(view) && !sectionOn(view as Section)) {
      setView(nav[0]?.id ?? 'favorites');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.sections, view]);
  const setRules = useCallback((r: ContentRules) => {
    const id = activeRef.current?.id;
    if (!id) return;
    saveRules(id, r);
    setRulesState(r);
  }, []);
  const viewCatalog = useMemo(() => (catalog ? applyRules(catalog, rules) : null), [catalog, rules]);

  const onGlobalSearch = (q: string) => {
    setGlobalQ(q);
    if (q && view !== 'search') {
      prevView.current = view;
      setView('search');
    } else if (!q && view === 'search') setView(prevView.current);
  };

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    prefs.setActiveId(id);
  }, []);

  const setLiveSel = useCallback((id: string | null) => {
    setLiveSelState(id);
    prefs.set('liveSel', id);
  }, []);

  /* ---------- Playlist ---------- */
  const fetchCatalog = useCallback(async (src: Source, force: boolean) => {
    const seq = ++loadSeq.current;
    setStatus({ loading: true, message: t("Chargement de la playlist…") });
    try {
      if (!force) {
        const cached = await db.catalog(src.id);
        if (seq !== loadSeq.current) return;
        if (cached) {
          setCatalog(cached);
          if (Date.now() - cached.fetchedAt < DAY) {
            setStatus({ loading: false });
            return;
          }
          setStatus({ loading: true, message: t("Mise à jour de la playlist…") });
        }
      }
      const previous = catalogRef.current?.sourceId === src.id ? catalogRef.current : await db.catalog(src.id);
      const fresh = markNewTitles(await loadCatalog(src), previous);
      if (seq !== loadSeq.current) return;
      setCatalog(fresh);
      setStatus({ loading: false });
      db.setCatalog(fresh);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setStatus({ loading: false, error: errMsg(e) });
    }
  }, []);

  useEffect(() => {
    setCatalog(null);
    setEpg(null);
    setEpgStatus({ state: 'none' });
    if (active) fetchCatalog(active, false);
    else setStatus({ loading: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  const refresh = useCallback(() => {
    if (activeRef.current) fetchCatalog(activeRef.current, true);
  }, [fetchCatalog]);

  /* ---------- Guide ---------- */
  const fetchEpg = useCallback(async (force: boolean) => {
    const src = activeRef.current;
    const cat = catalogRef.current;
    if (!src || !cat || cat.sourceId !== src.id) return;
    const url = epgUrlFor(src, cat);
    const seq = ++epgSeq.current;
    if (!url) {
      setEpg(null);
      setEpgStatus({ state: 'none' });
      return;
    }
    setEpgStatus({ state: 'loading' });
    try {
      if (!force) {
        const cached = await db.epg(src.id);
        if (seq !== epgSeq.current) return;
        if (cached && Date.now() - cached.fetchedAt < EPG_TTL) {
          setEpg(cached);
          setEpgStatus({ state: 'ready' });
          return;
        }
        if (cached) setEpg(cached);
      }
      const fresh = await loadEpg(url, cat);
      if (seq !== epgSeq.current) return;
      setEpg(fresh);
      setEpgStatus({ state: 'ready' });
      db.setEpg(src.id, fresh);
    } catch (e) {
      if (seq !== epgSeq.current) return;
      setEpgStatus({ state: 'error', error: errMsg(e) });
    }
  }, []);

  const epgKey = active && catalog && catalog.sourceId === active.id ? `${active.id}|${epgUrlFor(active, catalog) ?? ''}|${catalog.fetchedAt}` : '';
  useEffect(() => {
    if (epgKey) fetchEpg(false);
  }, [epgKey, fetchEpg]);

  /* ---------- Sources ---------- */
  const addSource = useCallback(
    async (s: Source, fileText?: string) => {
      if (fileText != null) await db.setFile(s.id, fileText);
      setSources((prev) => {
        const next = [...prev, s];
        prefs.setSources(next);
        return next;
      });
      setActiveId(s.id);
      setLiveSel(null);
      setView('live');
    },
    [setActiveId, setLiveSel],
  );

  const updateSource = useCallback((s: Source) => {
    setSources((prev) => {
      const next = prev.map((x) => (x.id === s.id ? s : x));
      prefs.setSources(next);
      return next;
    });
  }, []);

  const removeSource = useCallback(
    async (id: string) => {
      await db.removeSource(id);
      setSources((prev) => {
        const next = prev.filter((x) => x.id !== id);
        prefs.setSources(next);
        if (activeRef.current?.id === id) {
          const nid = next[0]?.id ?? null;
          setActiveIdState(nid);
          prefs.setActiveId(nid);
        }
        return next;
      });
    },
    [],
  );

  const setSettings = useCallback((p: Partial<Settings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...p };
      prefs.setSettings(next);
      return next;
    });
  }, []);

  const toggleFav = useCallback((id: string) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      prefs.setFavorites(next);
      return next;
    });
  }, []);

  const clearCaches = useCallback(async () => {
    await db.clearCaches();
  }, []);

  const closeOverlay = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setOverlay(null);
  }, []);

  const ctx: AppCtx = {
    sources,
    active,
    setActiveId,
    addSource,
    updateSource,
    removeSource,
    catalog: viewCatalog,
    rawCatalog: catalog,
    rules,
    setRules,
    organize: (k?: Kind | 'lists') => setOrganizeKind(k ?? 'l'),
    editItem: (id: string, label: string) => {
      const find = (c: Catalog | null) => c && [...c.live, ...c.movies, ...c.series].find((x) => x.id === id);
      const shown = find(viewCatalog);
      const orig = find(catalog);
      if (shown && orig) setItemTarget({ id, label, name: shown.name, original: orig.name });
    },
    status,
    refresh,
    epg,
    epgStatus,
    refreshEpg: () => fetchEpg(true),
    settings,
    setSettings,
    favs,
    toggleFav,
    lists,
    setLists,
    view,
    setView,
    liveSel,
    setLiveSel,
    pendingOpen,
    setPendingOpen,
    downloads,
    overlay,
    play: setOverlay,
    clearCaches,
  };

  if (!sources.length) {
    return (
      <Ctx.Provider value={ctx}>
        <Welcome />
      </Ctx.Provider>
    );
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <nav className="rail">
          <div className="rail-logo" title="Ondes">
            <Logo size={34} />
          </div>
          {nav.map((n) => (
            <button key={n.id} className={cx('rail-btn', view === n.id && 'on')} onClick={() => setView(n.id)}>
              <Icon name={n.icon} size={22} />
              <span>{n.label}</span>
            </button>
          ))}
          <button className={cx('rail-btn', view === 'favorites' && 'on')} onClick={() => setView('favorites')}>
            <Icon name="star" size={22} />
            <span>{t("Favoris")}</span>
          </button>
          {downloadsAvailable && (
            <button className={cx('rail-btn', view === 'downloads' && 'on')} onClick={() => setView('downloads')}>
              <Icon name="download" size={22} />
              <span>{t("Téléchargés")}</span>
              {Object.values(downloads.items).some((d) => d.status === 'downloading') && <i className="rail-dot" />}
            </button>
          )}
          <div className="rail-spacer" />
          <button className={cx('rail-btn', view === 'settings' && 'on')} onClick={() => setView('settings')}>
            <Icon name="sliders" size={22} />
            <span>{t("Réglages")}</span>
          </button>
        </nav>

        <main className="main">
          <header className="topbar">
            <select className="select source-select" value={activeId ?? ''} onChange={(e) => setActiveId(e.target.value)}>
              {sources.filter((s) => !s.hidden || s.id === activeId).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {viewCatalog && (
              <span className="muted small counts">
                {t('{live} chaînes · {movies} films · {series} séries', { live: fmtCount(viewCatalog.live.length), movies: fmtCount(viewCatalog.movies.length), series: fmtCount(viewCatalog.series.length) })}
              </span>
            )}
            <div className="topbar-spacer" />
            <div className="global-search">
              <SearchBox value={globalQ} onChange={onGlobalSearch} placeholder={t("Rechercher dans toutes les sources")} />
            </div>
            {status.loading && (
              <span className="status">
                <span className="spinner small" /> {status.message}
              </span>
            )}
            {!status.loading && epgStatus.state === 'loading' && (
              <span className="status">
                <span className="spinner small" /> {t("Chargement du guide…")}
              </span>
            )}
            {status.error && (
              <span className="status error" title={status.error}>
                {status.error}
              </span>
            )}
            <button className="icon-btn" onClick={refresh} title={t("Actualiser la playlist")} disabled={status.loading}>
              <Icon name="refresh" size={18} />
            </button>
          </header>

          <section className="content">
            {view === 'settings' ? (
              <SettingsView />
            ) : view === 'search' ? (
              <SearchView query={globalQ} onDone={() => setGlobalQ('')} />
            ) : view === 'downloads' ? (
              <DownloadsView />
            ) : !catalog ? (
              <div className="center-msg">
                {status.error ? (
                  <div className="load-error">
                    <h3>{t('Impossible de charger « {name} »', { name: active?.name ?? '' })}</h3>
                    <p className="muted">{status.error}</p>
                    <div className="row">
                      <button className="btn" onClick={refresh}>
                        <Icon name="refresh" size={16} /> {t("Réessayer")}
                      </button>
                      <button className="btn ghost" onClick={() => setView('settings')}>
                        {t("Gérer les sources")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="spinner" /> {status.message ?? t("Chargement…")}
                  </>
                )}
              </div>
            ) : view === 'live' ? (
              <LiveView />
            ) : view === 'favorites' ? (
              <FavoritesView />
            ) : view === 'guide' ? (
              <GuideView />
            ) : view === 'movies' ? (
              <MoviesView />
            ) : (
              <SeriesView />
            )}
          </section>
        </main>

        {organizeKind && <OrganizeModal initialKind={organizeKind} onClose={() => setOrganizeKind(null)} />}
        {itemTarget && <ItemModal target={itemTarget} onClose={() => setItemTarget(null)} />}
        {overlay && (
          <div className="overlay">
            <Player spec={overlay} mode="overlay" onClose={closeOverlay} />
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

function Welcome() {
  const { addSource } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-head">
          <Logo size={56} />
          <div>
            <h1>{t("Bienvenue dans Ondes")}</h1>
            <p className="muted">{t("Ajoutez votre playlist de streams pour commencer : lien M3U, fichier ou identifiants Xtream Codes.")}</p>
          </div>
        </div>
        <AddSourceForm />
        <div className="welcome-demo">
          <span className="muted small">{t("Pas de playlist sous la main ?")}</span>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await addSource({ id: uid(), createdAt: Date.now(), kind: 'm3u', name: DEMO_SOURCE.name, url: DEMO_SOURCE.url });
            }}
          >
            {t("Essayer avec des chaînes gratuites")}
          </button>
        </div>
      </div>
    </div>
  );
}

