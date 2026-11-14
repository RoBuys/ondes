import { useState } from 'react';
import { useApp } from '../context';
import { downloadsAvailable, fmtBytes, localSrc, type Download } from '../lib/downloads';
import { cx } from '../lib/util';
import { Empty, Icon, Img } from './ui';
import { t, tErr } from '../lib/i18n';

const STATUS: Record<Download['status'], string> = {
  queued: t("En attente"),
  downloading: t("Téléchargement"),
  paused: t("En pause"),
  done: t("Téléchargé"),
  error: t("Erreur"),
};

export function DownloadsView() {
  const { downloads, play } = useApp();
  const [confirm, setConfirm] = useState<string | null>(null);
  const list = Object.values(downloads.items).sort((a, b) => {
    const rank = (d: Download) => (d.status === 'downloading' ? 0 : d.status === 'queued' ? 1 : d.status === 'paused' || d.status === 'error' ? 2 : 3);
    return rank(a) - rank(b) || b.addedAt - a.addedAt;
  });

  if (!downloadsAvailable) {
    return (
      <Empty title={t("Téléchargements")} icon="download">
        {t("Le téléchargement est disponible dans l’application Ondes.")}
      </Empty>
    );
  }

  const playLocal = (d: Download) => {
    const src = localSrc(d);
    if (!src) return;
    play({ key: `dl:${d.id}`, title: d.title, subtitle: d.subtitle, urls: [src], live: false, resumeKey: d.id, poster: d.poster });
  };

  return (
    <div className="downloads">
      <div className="section-head">
        <div>
          <h2>{t("Téléchargements")}</h2>
          <div className="muted small">
            {t('{dir} · un téléchargement à la fois, pour respecter la limite de connexions de votre abonnement.', { dir: downloads.dir ?? t('Dossier Vidéos/Ondes') })}
          </div>
        </div>
        <button className="btn ghost" onClick={() => downloads.reveal()}>
          <Icon name="folder" size={16} /> {t("Ouvrir le dossier")}
        </button>
      </div>

      {list.length === 0 ? (
        <Empty title={t("Aucun téléchargement")} icon="download">
          {t("Depuis la fiche d’un film ou d’une série, utilisez « Télécharger » pour regarder hors connexion.")}
        </Empty>
      ) : (
        <div className="dl-list">
          {list.map((d) => {
            const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : 0;
            return (
              <div key={d.id} className={cx('dl-row', d.status)}>
                <Img className="dl-poster" src={d.poster} alt={d.title} />
                <div className="dl-text">
                  <div className="dl-title ellipsis">{d.title}</div>
                  {d.subtitle && <div className="muted small ellipsis">{d.subtitle}</div>}
                  {d.status !== 'done' && (
                    <div className="bar dl-bar">
                      <i style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  <div className={cx('small', d.status === 'error' ? 'dl-error' : 'muted')}>
                    {STATUS[d.status]}
                    {d.status === 'done' && ` · ${fmtBytes(d.received || d.total)}`}
                    {(d.status === 'downloading' || d.status === 'paused') &&
                      ` · ${d.total ? t('{done} sur {total} ({pct} %)', { done: fmtBytes(d.received), total: fmtBytes(d.total), pct: Math.floor(pct) }) : fmtBytes(d.received)}`}
                    {d.status === 'error' && d.error && ` : ${tErr(d.error)}`}
                  </div>
                </div>
                <div className="dl-actions">
                  {d.status === 'done' && (
                    <>
                      <button className="btn" onClick={() => playLocal(d)}>
                        <Icon name="play" size={16} filled /> {t("Lire")}
                      </button>
                      <button className="icon-btn" onClick={() => downloads.reveal(d.path)} title={t("Afficher dans le dossier")}>
                        <Icon name="folder" size={18} />
                      </button>
                    </>
                  )}
                  {(d.status === 'downloading' || d.status === 'queued') && (
                    <button className="btn ghost" onClick={() => downloads.pause(d.id)}>
                      <Icon name="pause" size={16} /> {t("Pause")}
                    </button>
                  )}
                  {(d.status === 'paused' || d.status === 'error') && (
                    <button className="btn ghost" onClick={() => downloads.resume(d.id)}>
                      <Icon name="refresh" size={16} /> {d.status === 'error' ? t("Réessayer") : t("Reprendre")}
                    </button>
                  )}
                  {confirm === d.id ? (
                    <button
                      className="btn danger"
                      onClick={() => {
                        downloads.remove(d.id);
                        setConfirm(null);
                      }}
                    >
                      {t("Supprimer le fichier")}
                    </button>
                  ) : (
                    <button className="icon-btn" onClick={() => setConfirm(d.id)} title={t("Supprimer")}>
                      <Icon name="trash" size={18} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "Download" button reflecting the download state (movie and episode pages). */
export function DownloadButton({
  id,
  compact,
  onStart,
}: {
  id: string;
  compact?: boolean;
  onStart: () => void;
}) {
  const { downloads, setView } = useApp();
  if (!downloadsAvailable) return null;
  const d = downloads.items[id];
  const pct = d?.total ? Math.floor((d.received / d.total) * 100) : 0;

  let label = t("Télécharger");
  let icon = 'download';
  let action = onStart;
  if (d?.status === 'done') {
    label = t("Téléchargé");
    icon = 'check';
    action = () => setView('downloads');
  } else if (d?.status === 'downloading') {
    label = d.total ? `${pct} %` : t("En cours…");
    icon = 'pause';
    action = () => downloads.pause(id);
  } else if (d?.status === 'queued') {
    label = t("En attente");
    icon = 'pause';
    action = () => downloads.pause(id);
  } else if (d?.status === 'paused' || d?.status === 'error') {
    label = d.status === 'error' ? t("Réessayer") : t("Reprendre");
    icon = 'refresh';
    action = () => downloads.resume(id);
  }

  if (compact) {
    return (
      <button
        className={cx('icon-btn dl-mini', d?.status)}
        onClick={(e) => {
          e.stopPropagation();
          action();
        }}
        title={label}
      >
        <Icon name={icon} size={17} />
        {d?.status === 'downloading' && d.total ? <span className="dl-mini-pct">{pct}</span> : null}
      </button>
    );
  }
  return (
    <button className={cx('btn ghost', d?.status === 'done' && 'active')} onClick={action}>
      <Icon name={icon} size={16} /> {label}
    </button>
  );
}
