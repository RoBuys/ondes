# Ondes — lecteur de streams pour macOS (Apple Silicon) et Windows

Application de bureau (Tauri 2 + React) pour regarder vos sources de streams :

- **Sources** : lien M3U, fichier M3U importé, compte **Xtream Codes** (plusieurs sources possibles).
- **Direct** : chaînes par groupe, recherche, favoris, zapping au clavier (↑ ↓), programme en cours et à suivre.
- **Guide** : grille XMLTV sur 12 h (navigation par tranches de 3 h), détectée depuis la playlist (`x-tvg-url`) ou Xtream, ou saisie à la main. Les `.xml.gz` sont gérés.
- **Films & séries** : catalogues Xtream (fiches détaillées, saisons, épisodes) ou VOD des M3U, reprise de lecture, épisode suivant automatique.
- **Lecture (macOS)** : moteur **mpv** embarqué — TNT entrelacée désentrelacée, AC-3, HEVC, pistes audio et sous-titres
  (DVB compris), plein écran. Réglages → Moteur de lecture permet de revenir au lecteur web.
- **Lecture (Windows, et repli)** : HLS (hls.js), MPEG-TS (mpegts.js) et MP4 natif, avec bascule automatique d'un format
  à l'autre en cas d'échec.
- **Reconnexion intelligente** : en cas de coupure ou d'image figée, le flux est relancé automatiquement (jusqu'à 8 essais,
  délai croissant, reprise immédiate au retour du réseau) ; les films reprennent à la même position.
- **Recherche globale** : la barre du haut cherche chaînes, films et séries dans toutes les sources à la fois.
- **Favoris et listes** : étoile sur les chaînes, films et séries (onglet « Favoris ») ; listes de chaînes personnelles
  (clic droit ou bouton « Listes » sous le lecteur), gérées dans Organiser → Mes listes.
- **Par source** (Réglages → Modifier) : onglets affichés et masquage de la source.
- **Organiser** : masquer, renommer, réordonner (glisser-déposer) les groupes ; deux groupes renommés pareil fusionnent.
  Clic droit sur une chaîne, un film ou une série pour la renommer ou la masquer.
- **Téléchargements** (app Windows) : films, épisodes ou saison entière dans `Vidéos\Ondes`, un à la fois pour respecter
  la limite de connexions de l'abonnement, avec pause, reprise (même après redémarrage) et lecture hors connexion.

Ondes ne fournit aucune chaîne : utilisez uniquement des sources auxquelles vous avez légalement accès.

## Installer

Les installateurs sont publiés dans les **Releases** du dépôt GitHub (Windows `.exe`/`.msi`, macOS `.dmg` universel).
Voir `.github/release-notes.md` pour les avertissements Windows SmartScreen et macOS Gatekeeper (app non signée).

## Compiler et publier

GitHub Actions (`.github/workflows/build.yml`) compile Windows et macOS à chaque push sur `main`.
Pour publier une version : mettre à jour la version dans `package.json`, `src-tauri/tauri.conf.json` et
`src-tauri/Cargo.toml`, puis pousser un tag `vX.Y.Z` : la release est créée automatiquement avec les installateurs.

## Développer sur le Mac

```bash
npm install
npm run dev      # http://localhost:1420
```

Dans un navigateur classique, les serveurs de streams bloquent les requêtes (CORS) : le serveur de dev Vite fournit un
proxy `/__proxy` utilisé automatiquement. Dans l'app Windows, WebView2 est lancé avec `--disable-web-security`
(voir `src-tauri/tauri.conf.json`), donc aucun proxy n'est nécessaire.

Pour lancer l'app Tauri sur le Mac : installez Rust puis `npm run tauri dev`. Sous macOS, WKWebView applique le CORS :
la partie Rust démarre un relais local (`src-tauri/src/proxy.rs`, 127.0.0.1 + jeton) par lequel passent flux et images.
Sous Windows, WebView2 est lancé sans CORS et n'en a pas besoin.

## Moteur mpv (macOS)

- `src-tauri/src/mpv.rs` charge libmpv à l'exécution ; `src-tauri/src/mac_render.rs` dessine l'image dans une vue OpenGL
  placée sous la vue web (API de rendu de mpv). L'interface place l'image sous le lecteur avec `video-margin-ratio-*`.
- `scripts/bundle-libmpv-macos.sh` copie libmpv de Homebrew et ses dépendances dans `src-tauri/lib/macos`
  (non versionné), embarquées dans `Ondes.app/Contents/Resources/lib`. Prérequis : `brew install mpv dylibbundler`.
- `src-tauri/Entitlements.plist` autorise le chargement de ces bibliothèques et le JIT de LuaJIT (runtime renforcé).
- Diagnostic : journal `~/Library/Logs/com.robertbuys.ondes/ondes.log` ; autotest des versions de développement via
  la variable `ONDES_SELFTEST` (liste JSON de flux à lire).

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
