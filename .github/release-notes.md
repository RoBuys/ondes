**Ondes**, lecteur de streams pour macOS (Apple Silicon) et Windows.

## Fonctions

- Sources **M3U** (lien ou fichier) et **Xtream Codes**, plusieurs sources possibles
- **Direct** : groupes, recherche, favoris, zapping au clavier (↑ ↓), programme en cours et à suivre
- **Guide des programmes** XMLTV (détecté automatiquement ou saisi à la main, `.xml.gz` accepté)
- **Films et séries** : fiches détaillées, saisons, reprise de lecture, épisode suivant automatique
- **Reconnexion intelligente** en cas de coupure ou d'image figée
- **Favoris** pour les chaînes, films et séries (étoile sur les affiches), réunis dans un onglet « Favoris »
- **Listes de chaînes** personnelles (« Sport », « Infos »…), dans le Direct et le Guide
- **Recherche globale** dans toutes les sources
- **Organiser** : masquer, renommer, réordonner et fusionner les groupes, filtre pour en afficher ou masquer plusieurs d'un coup ; clic droit pour renommer ou masquer un élément
- **Par source** : choisir les onglets affichés (Direct, Guide, Films, Séries) ou masquer la source
- **Téléchargements** de films, épisodes et saisons pour regarder hors connexion
- **macOS : moteur de lecture mpv** — lit la TNT entrelacée (1080i), l'AC-3, le HEVC ; choix de la piste audio et des sous-titres (DVB compris), désentrelacement automatique. Windows utilise pour l'instant le lecteur web.

Ondes ne fournit aucune chaîne : utilisez uniquement des sources auxquelles vous avez légalement accès.

## Installation

**Windows** : l'installateur `…_x64-setup.exe` (ou le `.msi`). L'installateur n'est pas signé : à l'avertissement SmartScreen,
choisissez « Informations complémentaires » puis « Exécuter quand même ».

**macOS 11 ou plus récent, Mac Apple Silicon (M1 et suivants)** : ouvrez le `.dmg` et glissez Ondes dans Applications.
L'app n'est pas notarisée par Apple : au premier lancement, faites clic droit → Ouvrir. Si macOS indique que l'app
« est endommagée », exécutez dans le Terminal :

```
xattr -cr /Applications/Ondes.app
```
