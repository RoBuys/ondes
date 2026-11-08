# Ondes — lecteur IPTV pour Windows

Application de bureau (Tauri 2 + React) pour regarder vos sources IPTV :

- **Sources** : lien M3U, fichier M3U importé, compte **Xtream Codes** (plusieurs sources possibles).
- **Direct** : chaînes par groupe, recherche, favoris, zapping au clavier (↑ ↓), programme en cours et à suivre.
- **Guide** : grille XMLTV sur 12 h (navigation par tranches de 3 h), détectée depuis la playlist (`x-tvg-url`) ou Xtream, ou saisie à la main. Les `.xml.gz` sont gérés.
- **Films & séries** : catalogues Xtream (fiches détaillées, saisons, épisodes) ou VOD des M3U, reprise de lecture, épisode suivant automatique.
- **Lecture** : HLS (hls.js), MPEG-TS (mpegts.js) et MP4 natif, avec bascule automatique d'un format à l'autre en cas d'échec.

Ondes ne fournit aucune chaîne : utilisez uniquement des sources auxquelles vous avez légalement accès.

## Obtenir l'installateur Windows

Le Mac ne peut pas compiler l'exécutable Windows directement : c'est GitHub Actions qui s'en charge
(`.github/workflows/build-windows.yml`).

1. Créez un dépôt GitHub et poussez ce dossier sur la branche `main`.
2. Onglet **Actions** → « Build Windows » : à chaque push (ou via *Run workflow*), un artefact `Ondes-windows`
   contient l'installateur `.exe` (NSIS) et le `.msi`.
3. Sur le PC : lancez l'installateur. WebView2 est installé automatiquement s'il manque (Windows 10/11 l'ont déjà).

L'installateur n'est pas signé : Windows SmartScreen affichera « Informations complémentaires → Exécuter quand même ».

## Développer sur le Mac

```bash
npm install
npm run dev      # http://localhost:1420
```

Dans un navigateur classique, les serveurs IPTV bloquent les requêtes (CORS) : le serveur de dev Vite fournit un
proxy `/__proxy` utilisé automatiquement. Dans l'app Windows, WebView2 est lancé avec `--disable-web-security`
(voir `src-tauri/tauri.conf.json`), donc aucun proxy n'est nécessaire.

Pour lancer l'app Tauri elle-même sur le Mac (facultatif), installez Rust (`https://rustup.rs`) puis `npm run tauri dev`.
Sous macOS, WKWebView applique le CORS : seule la version Windows est visée.

## Structure

```
src/lib/        m3u.ts, xtream.ts, xmltv.ts (parseurs), catalog.ts, store.ts (localStorage + IndexedDB), net.ts
src/components/ Live, Guide, Vod (films/séries), Player, Settings, ui
src-tauri/      coquille Rust Tauri 2, configuration Windows, icônes
```

## Limites connues

- Les codecs dépendent de WebView2 : H.264/AAC partout ; HEVC seulement avec l'extension matérielle Windows ;
  certains flux AC-3/MKV peuvent ne pas se lire. Le bouton « Copier l'adresse » permet de les ouvrir dans VLC.
- Pas de replay (catch-up) ni d'enregistrement pour l'instant.
