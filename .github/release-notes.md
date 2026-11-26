**Ondes**, stream player for macOS (Apple Silicon) and Windows.

## Features

- **English and French interface** (follows the system language, switch in Settings → Language)

- **M3U** (link or file) and **Xtream Codes** sources, several sources supported
- **Live**: groups, search, favorites, keyboard zapping (↑ ↓), current and upcoming programme
- XMLTV **programme guide** (detected automatically or entered manually, `.xml.gz` supported)
- **Movies and series**: detail pages, seasons, resume playback, automatic next episode
- **Recently added** category for movies and series: provider dates (Xtream), or titles that appeared since the previous refresh (M3U)
- **Smart reconnection** when a stream drops or freezes
- **Favorites** for channels, movies and series (star on posters), gathered in a Favorites tab
- Personal **channel lists** ("Sport", "News"…), in Live and Guide
- **Global search** across all sources
- **Organize**: hide, rename, reorder and merge groups, with a filter to show or hide many at once; right-click to rename or hide an item
- **Per source**: choose the tabs shown (Live, Guide, Movies, Series) or hide the source
- **Downloads** of movies, episodes and seasons to watch offline — resume automatically after network cuts and after restarting the app, and keep the Mac awake while running
- **macOS: mpv playback engine** — plays interlaced broadcast TV (1080i), AC-3, HEVC; audio and subtitle track selection (DVB included), automatic deinterlacing. Windows still uses the web player for now.

Ondes does not provide any channel: only use sources you are legally entitled to access.

## Installation

**Windows**: the `…_x64-setup.exe` installer (or the `.msi`). The installer is not signed: at the SmartScreen warning,
choose "More info", then "Run anyway".

**macOS 11 or later, Apple Silicon Macs (M1 and later)**: open the `.dmg` and drag Ondes to Applications.
The app is not notarized by Apple: on first launch, right-click → Open. If macOS says the app
"is damaged", run in Terminal:

```
xattr -cr /Applications/Ondes.app
```
