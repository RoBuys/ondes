# Ondes — stream player for macOS (Apple Silicon) and Windows

Desktop app (Tauri 2 + React) to watch your stream sources. The interface is available in **English and French**
(follows the system language; *Settings → Language* to switch). Menu names are given below in English.

- **Sources**: M3U link, imported M3U file, **Xtream Codes** account (several sources supported).
- **Live**: channels by group, search, favorites, keyboard zapping (↑ ↓), current and upcoming programme.
- **Guide**: 12-hour XMLTV grid (3-hour steps), detected from the playlist (`x-tvg-url`) or Xtream, or entered
  manually. `.xml.gz` files are supported.
- **Movies & series**: Xtream catalogs (detail pages, seasons, episodes) or M3U VOD, resume
  playback, automatic next episode.
- **Playback (macOS)**: bundled **mpv** engine — deinterlaced broadcast TV (1080i), AC-3, HEVC, audio and subtitle
  tracks (DVB included), full screen. *Settings → Playback engine* switches back to
  the web player.
- **Playback (Windows, and fallback)**: HLS (hls.js), MPEG-TS (mpegts.js) and native MP4, switching automatically from
  one format to another on failure.
- **Smart reconnection**: when a stream drops or freezes, it is reloaded automatically (up to 8 attempts, increasing
  delay, immediate retry when the network comes back); movies resume at the same position.
- **Global search**: the top bar searches channels, movies and series across all sources at once.
- **Favorites and lists**: star channels, movies and series (*Favorites* tab); personal channel lists (right-click,
  or the *Lists* button under the player), managed in *Organize → My lists*.
- **Per source** (*Settings → Edit*): tabs shown for the source, or hide the source.
- **Organize**: hide, rename and reorder (drag and drop) groups, with a filter to show or hide many at
  once; two groups renamed alike are merged. Right-click a channel, movie or series to rename or hide it.
- **Downloads**: movies, episodes or whole seasons, saved to `Movies/Ondes` (macOS) or
  `Videos\Ondes` (Windows), one at a time to stay within the subscription's connection limit, with pause, resume
  (even after a restart) and offline playback.

Ondes does not provide any channel: only use sources you are legally entitled to access.

## Install

Installers are published in the repository's **Releases** (Windows `.exe`/`.msi`, macOS `.dmg` for Apple Silicon).
See `.github/release-notes.md` for the Windows SmartScreen and macOS Gatekeeper warnings (the app is not signed).

## Build and release

GitHub Actions (`.github/workflows/build.yml`) builds Windows and macOS on every push to `main`.
To release a version: update the version in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`, then push a `vX.Y.Z` tag: the release is created automatically with the installers.

## Develop on the Mac

```bash
npm install
npm run dev      # http://localhost:1420
```

In a regular browser, stream servers block requests (CORS): the Vite dev server provides a `/__proxy` endpoint that
is used automatically. In the Windows app, WebView2 runs with `--disable-web-security`
(see `src-tauri/tauri.windows.conf.json`), so no proxy is needed.

To run the Tauri app on the Mac: install Rust, then `npm run tauri dev`. On macOS, WKWebView enforces CORS: the Rust
side starts a local relay (`src-tauri/src/proxy.rs`, 127.0.0.1 + token) that streams and images go through.
On Windows, WebView2 runs without CORS and does not need it.

## mpv engine (macOS)

- `src-tauri/src/mpv.rs` loads libmpv at runtime; `src-tauri/src/mac_render.rs` draws the picture into an OpenGL view
  placed below the web view (mpv render API), on a dedicated render thread so the main thread stays free. The UI
  positions the picture under the player with `video-margin-ratio-*`.
- `scripts/bundle-libmpv-macos.sh` copies Homebrew's libmpv and its dependencies into `src-tauri/lib/macos`
  (not versioned), bundled into `Ondes.app/Contents/Resources/lib`. Requirements: `brew install mpv dylibbundler`.
- `src-tauri/Entitlements.plist` allows loading these libraries and LuaJIT's JIT (hardened runtime).
- Diagnostics: log at `~/Library/Logs/com.robertbuys.ondes/ondes.log`; development builds have a self-test driven by
  the `ONDES_SELFTEST` variable (JSON list of streams to play).

## Translations

French strings are the translation keys: `t('Réessayer')` returns "Réessayer" or "Retry" (`src/lib/i18n.ts`).
English translations live in `src/lib/i18n-en.ts`; a missing entry falls back to French. Placeholders use
`{name}` and must match in both languages.

## Layout

```
src/lib/        m3u.ts, xtream.ts, xmltv.ts (parsers), catalog.ts, store.ts (localStorage + IndexedDB), net.ts,
                mpv.ts, lists.ts, content.ts (per-source customization), downloads.ts, diag.ts
src/components/ Live, Guide, Vod (movies/series), Favorites, Player (web), MpvPlayer, Organize, Settings, ui
src-tauri/      Tauri 2 Rust shell: downloads, relay (proxy.rs), mpv (mpv.rs, mac_render.rs), icons
scripts/        bundle-libmpv-macos.sh
```

## Known limitations

- Windows still uses the web player: codecs depend on WebView2 (H.264/AAC everywhere, HEVC only with the Windows
  hardware extension, some AC-3/MKV or interlaced streams may not play). The *Copy address*
  button lets you open them in VLC.
- No catch-up (replay) or recording yet.
