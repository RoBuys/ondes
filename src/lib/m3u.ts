export interface M3UEntry {
  name: string;
  url: string;
  attrs: Record<string, string>;
  group: string;
}

export function parseM3U(text: string): { entries: M3UEntry[]; epgUrl?: string } {
  const entries: M3UEntry[] = [];
  let epgUrl: string | undefined;
  let pending: { name: string; attrs: Record<string, string> } | null = null;
  let grp: string | undefined;

  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      const m = /(?:x-tvg-url|url-tvg|tvg-url)\s*=\s*"([^"]+)"/i.exec(line);
      if (m) epgUrl = m[1].split(',')[0].trim();
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      pending = parseExtinf(line);
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      grp = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('#')) continue;

    const info = pending ?? { name: decodeURIComponentSafe(line.split('/').pop() || line), attrs: {} };
    entries.push({
      name: info.name || 'Sans nom',
      url: line,
      attrs: info.attrs,
      group: info.attrs['group-title'] || grp || 'Sans groupe',
    });
    pending = null;
    grp = undefined;
  }
  return { entries, epgUrl };
}

function parseExtinf(line: string) {
  const body = line.slice(line.indexOf(':') + 1);
  let inQuotes = false;
  let cut = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) {
      cut = i;
      break;
    }
  }
  const head = cut >= 0 ? body.slice(0, cut) : body;
  const name = cut >= 0 ? body.slice(cut + 1).trim() : '';
  const attrs: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) attrs[m[1].toLowerCase()] = m[2].trim();
  return { name: name || attrs['tvg-name'] || '', attrs };
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
