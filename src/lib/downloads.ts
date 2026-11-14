import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from './net';
import { prefs } from './store';
import { locale, t } from './i18n';

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'done' | 'error';

export interface Download {
  id: string;
  sourceId: string;
  kind: 'movie' | 'episode';
  title: string;
  subtitle?: string;
  poster?: string;
  url: string;
  fileName: string;
  path?: string;
  status: DownloadStatus;
  received: number;
  total?: number;
  error?: string;
  addedAt: number;
}

export type NewDownload = Omit<Download, 'status' | 'received' | 'addedAt' | 'fileName'> & { baseName: string };

interface ProgressEvent {
  id: string;
  status: 'downloading' | 'done' | 'error' | 'paused';
  received: number;
  total?: number | null;
  path: string;
  error?: string | null;
}

function extOf(url: string) {
  const m = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url.split('/').pop() ?? '');
  return m ? m[1].toLowerCase() : 'mp4';
}

export const downloadsAvailable = isTauri;

export function localSrc(d: Download): string | undefined {
  return d.status === 'done' && d.path && isTauri ? convertFileSrc(d.path) : undefined;
}

export function fmtBytes(n?: number) {
  if (!n) return t('{n} Mo', { n: 0 });
  if (n >= 1e9) return t('{n} Go', { n: (n / 1e9).toLocaleString(locale, { maximumFractionDigits: 2 }) });
  return t('{n} Mo', { n: Math.round(n / 1e6).toLocaleString(locale) });
}

export function useDownloads() {
  const [items, setItems] = useState<Record<string, Download>>(() => {
    const saved = prefs.get<Record<string, Download>>('downloads', {});
    // On restart, an interrupted download is paused (it will resume where it stopped).
    for (const d of Object.values(saved)) if (d.status === 'downloading') d.status = 'paused';
    return saved;
  });
  const [dir, setDir] = useState<string | null>(null);
  const pendingRemoval = useRef(new Set<string>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => prefs.set('downloads', items), [items]);

  /* Progress events sent by the Rust side */
  useEffect(() => {
    if (!isTauri) return;
    invoke<string>('downloads_dir').then(setDir).catch(() => {});
    let off: (() => void) | undefined;
    let cancelled = false;
    listen<ProgressEvent>('download-progress', ({ payload: p }) => {
      if (pendingRemoval.current.has(p.id) && p.status !== 'downloading') {
        pendingRemoval.current.delete(p.id);
        invoke('download_delete', { path: p.path }).catch(() => {});
        return;
      }
      setItems((prev) => {
        const d = prev[p.id];
        if (!d) return prev;
        return {
          ...prev,
          [p.id]: { ...d, status: p.status, received: p.received, total: p.total ?? d.total, path: p.path, error: p.error ?? undefined },
        };
      });
    }).then((fn) => (cancelled ? fn() : (off = fn)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  /* Checks that completed files still exist */
  useEffect(() => {
    if (!isTauri) return;
    for (const d of Object.values(itemsRef.current)) {
      if (d.status !== 'done' || !d.path) continue;
      invoke<boolean>('file_exists', { path: d.path }).then((ok) => {
        if (!ok) setItems((prev) => (prev[d.id] ? { ...prev, [d.id]: { ...prev[d.id], status: 'error', error: t("Fichier introuvable sur le disque") } } : prev));
      });
    }
  }, []);

  /* Queue: one download at a time (streaming subscriptions often limit simultaneous connections) */
  useEffect(() => {
    if (!isTauri) return;
    const list = Object.values(items);
    if (list.some((d) => d.status === 'downloading')) return;
    const next = list.filter((d) => d.status === 'queued').sort((a, b) => a.addedAt - b.addedAt)[0];
    if (!next) return;
    setItems((prev) => ({ ...prev, [next.id]: { ...next, status: 'downloading', error: undefined } }));
    invoke<string>('download_start', { id: next.id, url: next.url, fileName: next.fileName })
      .then((path) => setItems((prev) => (prev[next.id] ? { ...prev, [next.id]: { ...prev[next.id], path } } : prev)))
      .catch((e) =>
        setItems((prev) => (prev[next.id] ? { ...prev, [next.id]: { ...prev[next.id], status: 'error', error: String(e) } } : prev)),
      );
  }, [items]);

  const add = useCallback((n: NewDownload) => {
    setItems((prev) => {
      const cur = prev[n.id];
      if (cur && cur.status !== 'error') return prev;
      const { baseName, ...rest } = n;
      return {
        ...prev,
        [n.id]: { ...rest, fileName: `${baseName}.${extOf(n.url)}`, status: 'queued', received: cur?.received ?? 0, addedAt: Date.now() },
      };
    });
  }, []);

  const pause = useCallback((id: string) => {
    const d = itemsRef.current[id];
    if (!d) return;
    if (d.status === 'downloading') invoke('download_cancel', { id }).catch(() => {});
    else if (d.status === 'queued') setItems((prev) => ({ ...prev, [id]: { ...prev[id], status: 'paused' } }));
  }, []);

  const resume = useCallback((id: string) => {
    setItems((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], status: 'queued', addedAt: Date.now(), error: undefined } } : prev));
  }, []);

  const remove = useCallback((id: string) => {
    const d = itemsRef.current[id];
    if (!d) return;
    if (d.status === 'downloading') {
      pendingRemoval.current.add(id);
      invoke('download_cancel', { id }).catch(() => {});
    } else if (d.path) {
      invoke('download_delete', { path: d.path }).catch(() => {});
    }
    setItems((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const reveal = useCallback((path?: string) => {
    if (isTauri) invoke('reveal', { path: path ?? null }).catch(() => {});
  }, []);

  return { items, dir, add, pause, resume, remove, reveal };
}

export type DownloadsApi = ReturnType<typeof useDownloads>;
