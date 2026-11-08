Première version d'**Ondes**, lecteur IPTV pour Windows et macOS.

## Fonctions

- Sources **M3U** (lien ou fichier) et **Xtream Codes**, plusieurs sources possibles
- **Direct** : groupes, recherche, favoris, zapping au clavier (↑ ↓), programme en cours et à suivre
- **Guide des programmes** XMLTV (détecté automatiquement ou saisi à la main, `.xml.gz` accepté)
- **Films et séries** : fiches détaillées, saisons, reprise de lecture, épisode suivant automatique
- **Reconnexion intelligente** en cas de coupure ou d'image figée
- **Recherche globale** dans toutes les sources
- **Organiser** : masquer, renommer, réordonner et fusionner les groupes ; clic droit pour renommer ou masquer un élément
- **Téléchargements** de films, épisodes et saisons pour regarder hors connexion

Ondes ne fournit aucune chaîne : utilisez uniquement des sources auxquelles vous avez légalement accès.

## Installation

**Windows** : `Ondes_0.1.0_x64-setup.exe` (ou le `.msi`). L'installateur n'est pas signé : à l'avertissement SmartScreen,
choisissez « Informations complémentaires » puis « Exécuter quand même ».

**macOS 11 ou plus récent** (Apple Silicon et Intel) : ouvrez `Ondes_0.1.0_universal.dmg` et glissez Ondes dans Applications.
L'app n'est pas notarisée par Apple : au premier lancement, faites clic droit → Ouvrir. Si macOS indique que l'app
« est endommagée », exécutez dans le Terminal :

```
xattr -cr /Applications/Ondes.app
```
