import { useState, type FormEvent } from 'react';
import { useApp } from '../context';
import type { Source } from '../lib/types';
import { cx, errMsg, fmtCount, fmtDate, uid } from '../lib/util';
import { xtLogin } from '../lib/xtream';
import { Icon } from './ui';

type Tab = 'url' | 'file' | 'xtream';

export const DEMO_SOURCE = {
  name: 'Chaînes gratuites (iptv-org, France)',
  url: 'https://iptv-org.github.io/iptv/countries/fr.m3u',
};

export function AddSourceForm({ onDone, onCancel }: { onDone?: () => void; onCancel?: () => void }) {
  const { addSource } = useApp();
  const [tab, setTab] = useState<Tab>('url');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const base = { id: uid(), createdAt: Date.now(), epgUrl: epgUrl.trim() || undefined };
      if (tab === 'url') {
        const u = url.trim();
        if (!/^https?:\/\//i.test(u)) throw new Error('Saisissez une adresse commençant par http:// ou https://');
        await addSource({ ...base, kind: 'm3u', name: name.trim() || new URL(u).host, url: u });
      } else if (tab === 'file') {
        if (!file) throw new Error('Choisissez un fichier .m3u ou .m3u8');
        const text = await file.text();
        if (!/#EXTINF/i.test(text)) throw new Error("Ce fichier n'est pas une playlist M3U");
        await addSource({ ...base, kind: 'm3u', name: name.trim() || file.name.replace(/\.m3u8?$/i, ''), isFile: true }, text);
      } else {
        if (!server.trim() || !username.trim()) throw new Error('Serveur et identifiant sont requis');
        const src: Source = {
          ...base,
          kind: 'xtream',
          name: name.trim() || server.trim().replace(/^https?:\/\//i, '').replace(/[:/].*$/, ''),
          server: server.trim(),
          username: username.trim(),
          password,
        };
        await xtLogin(src);
        await addSource(src);
      }
      onDone?.();
    } catch (e2) {
      setErr(errMsg(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-form" onSubmit={submit}>
      <div className="tabs">
        <button type="button" className={cx('tab', tab === 'url' && 'on')} onClick={() => setTab('url')}>
          <Icon name="link" size={16} /> Lien M3U
        </button>
        <button type="button" className={cx('tab', tab === 'file' && 'on')} onClick={() => setTab('file')}>
          <Icon name="file" size={16} /> Fichier M3U
        </button>
        <button type="button" className={cx('tab', tab === 'xtream' && 'on')} onClick={() => setTab('xtream')}>
          <Icon name="server" size={16} /> Xtream Codes
        </button>
      </div>

      {tab === 'url' && (
        <label className="field">
          <span>Adresse de la playlist</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://exemple.com/playlist.m3u" autoFocus />
        </label>
      )}
      {tab === 'file' && (
        <label className="field">
          <span>Fichier</span>
          <input type="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/x-mpegurl" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      )}
      {tab === 'xtream' && (
        <>
          <label className="field">
            <span>Serveur</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://serveur.exemple:8080" autoFocus />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Identifiant</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              <span>Mot de passe</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </label>
          </div>
        </>
      )}

      <div className="field-row">
        <label className="field">
          <span>Nom (facultatif)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ma liste" />
        </label>
        <label className="field">
          <span>Guide XMLTV (facultatif)</span>
          <input value={epgUrl} onChange={(e) => setEpgUrl(e.target.value)} placeholder="Détecté automatiquement si possible" />
        </label>
      </div>

      {err && <div className="form-error">{err}</div>}

      <div className="row end">
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Annuler
          </button>
        )}
        <button className="btn" disabled={busy}>
          {busy ? <span className="spinner small" /> : <Icon name="plus" size={16} />}
          {tab === 'xtream' ? 'Se connecter' : 'Ajouter'}
        </button>
      </div>
    </form>
  );
}

function SourceCard({ s }: { s: Source }) {
  const { active, setActiveId, refresh, refreshEpg, removeSource, updateSource, catalog } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.name);
  const [epgUrl, setEpgUrl] = useState(s.epgUrl ?? '');
  const isActive = active?.id === s.id;
  const acc = isActive ? catalog?.account : undefined;

  const where =
    s.kind === 'xtream' ? `${s.server} · ${s.username}` : s.isFile ? 'Fichier importé' : (s.url ?? '').replace(/\?.*$/, '');

  return (
    <div className={cx('source-card', isActive && 'on')}>
      <div className="source-top">
        <div className="source-icon">
          <Icon name={s.kind === 'xtream' ? 'server' : s.isFile ? 'file' : 'link'} />
        </div>
        <div className="source-text">
          <div className="source-name">
            {s.name} {isActive && <span className="badge">Active</span>}
          </div>
          <div className="muted small ellipsis">{where}</div>
          {isActive && catalog && (
            <div className="muted small">
              {fmtCount(catalog.live.length)} chaînes · {fmtCount(catalog.movies.length)} films · {fmtCount(catalog.series.length)} séries
              {acc?.expires && ` · expire le ${fmtDate(acc.expires)}`}
              {acc?.maxConnections && ` · ${acc.activeConnections ?? 0}/${acc.maxConnections} connexions`}
            </div>
          )}
        </div>
        <div className="source-actions">
          {!isActive && (
            <button className="btn ghost" onClick={() => setActiveId(s.id)}>
              Utiliser
            </button>
          )}
          {isActive && (
            <button className="icon-btn" onClick={refresh} title="Actualiser la playlist">
              <Icon name="refresh" size={18} />
            </button>
          )}
          <button className="btn ghost" onClick={() => setEditing((v) => !v)}>
            Modifier
          </button>
          {confirm ? (
            <button className="btn danger" onClick={() => removeSource(s.id)}>
              Confirmer la suppression
            </button>
          ) : (
            <button className="icon-btn" onClick={() => setConfirm(true)} title="Supprimer">
              <Icon name="trash" size={18} />
            </button>
          )}
        </div>
      </div>
      {editing && (
        <form
          className="source-edit"
          onSubmit={(e) => {
            e.preventDefault();
            const changedEpg = (s.epgUrl ?? '') !== epgUrl.trim();
            updateSource({ ...s, name: name.trim() || s.name, epgUrl: epgUrl.trim() || undefined });
            setEditing(false);
            if (changedEpg && isActive) window.setTimeout(refreshEpg, 0);
          }}
        >
          <div className="field-row">
            <label className="field">
              <span>Nom</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Guide XMLTV</span>
              <input value={epgUrl} onChange={(e) => setEpgUrl(e.target.value)} placeholder="Automatique" />
            </label>
          </div>
          <div className="row end">
            <button className="btn">Enregistrer</button>
          </div>
        </form>
      )}
    </div>
  );
}

export function SettingsView() {
  const { sources, settings, setSettings, clearCaches, epg, epgStatus, refreshEpg } = useApp();
  const [adding, setAdding] = useState(false);
  const [cleared, setCleared] = useState(false);

  return (
    <div className="settings">
      <section>
        <div className="section-head">
          <h2>Sources</h2>
          {!adding && (
            <button className="btn" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> Ajouter une source
            </button>
          )}
        </div>
        {adding && (
          <div className="card">
            <AddSourceForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
          </div>
        )}
        {sources.map((s) => (
          <SourceCard key={s.id} s={s} />
        ))}
      </section>

      <section>
        <h2>Lecture</h2>
        <div className="card">
          <div className="setting">
            <div>
              <div className="setting-title">Format des chaînes Xtream</div>
              <div className="muted small">Si une chaîne ne démarre pas, essayez l’autre format. Ondes bascule aussi automatiquement en cas d’échec.</div>
            </div>
            <div className="segmented">
              <button className={cx(settings.liveFormat === 'ts' && 'on')} onClick={() => setSettings({ liveFormat: 'ts' })}>
                MPEG-TS
              </button>
              <button className={cx(settings.liveFormat === 'm3u8' && 'on')} onClick={() => setSettings({ liveFormat: 'm3u8' })}>
                HLS
              </button>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2>Guide des programmes</h2>
        <div className="card">
          <div className="setting">
            <div>
              <div className="setting-title">État</div>
              <div className="muted small">
                {epgStatus.state === 'loading' && 'Chargement en cours…'}
                {epgStatus.state === 'ready' && epg && `${fmtCount(Object.keys(epg.byId).length)} chaînes avec programme`}
                {epgStatus.state === 'none' && 'Aucun guide pour la source active'}
                {epgStatus.state === 'error' && `Erreur : ${epgStatus.error}`}
              </div>
            </div>
            <button className="btn ghost" onClick={refreshEpg} disabled={epgStatus.state === 'loading' || epgStatus.state === 'none'}>
              <Icon name="refresh" size={16} /> Recharger
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2>Données</h2>
        <div className="card">
          <div className="setting">
            <div>
              <div className="setting-title">Vider le cache</div>
              <div className="muted small">Supprime les playlists et guides enregistrés. Vos sources et favoris sont conservés.</div>
            </div>
            <button
              className="btn ghost"
              onClick={async () => {
                await clearCaches();
                setCleared(true);
              }}
            >
              {cleared ? <Icon name="check" size={16} /> : <Icon name="trash" size={16} />} {cleared ? 'Cache vidé' : 'Vider'}
            </button>
          </div>
        </div>
        <p className="muted small about">
          Ondes 0.1.0 — lecteur IPTV. Ondes ne fournit aucune chaîne : utilisez uniquement des sources auxquelles vous avez légalement accès.
        </p>
      </section>
    </div>
  );
}
