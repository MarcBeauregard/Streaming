# FeedSwitch

Colle le lien d'une page de streaming : l'app ouvre la page en arrière-plan, repère les flux vidéo qui s'y cachent (avec leurs qualités) et les joue dans un lecteur propre, sans pub ni pop-up. Tu peux ajouter plusieurs pages et passer d'un flux à l'autre en un clic.

## Installation

FeedSwitch est une application de bureau pour Windows, macOS et Linux. Elle a besoin de Google Chrome ou de Microsoft Edge sur l'ordinateur : c'est lui qui ouvre les pages en arrière-plan pendant l'analyse.

### Avec un installateur

Les installateurs sont construits par GitHub : onglet **Actions** du dépôt, recette **Installateurs**, bouton **Run workflow**. Une fois la construction terminée, le fichier se télécharge en bas de la page du résultat.

| Système | Fichier | Premier lancement |
| --- | --- | --- |
| Windows | `FeedSwitch-…-win-x64.exe` | Windows affiche « Windows a protégé votre ordinateur » : **Informations complémentaires**, puis **Exécuter quand même** |
| macOS | `FeedSwitch-…-mac-arm64.dmg` (puce Apple) ou `…-mac-x64.dmg` (Intel) | macOS refuse d'ouvrir l'app la première fois : voir ci-dessous |
| Linux | `FeedSwitch-…-linux-x86_64.AppImage` | Rendre le fichier exécutable, puis double-clic |

Ces avertissements viennent du fait que l'app n'est pas signée par un éditeur enregistré.

**Sur Mac**, pour savoir quel fichier prendre : menu Pomme, **À propos de ce Mac**. « Puce Apple M… » veut dire `arm64`, « Processeur Intel » veut dire `x64`. Ensuite :

1. Ouvre le `.dmg` et glisse FeedSwitch dans **Applications**.
2. Lance l'app. macOS affiche qu'il ne peut pas la vérifier : clique **Terminé**.
3. Ouvre **Réglages Système**, **Confidentialité et sécurité**, descends jusqu'à la mention de FeedSwitch et clique **Ouvrir quand même**.

C'est à faire une seule fois. Si le bouton n'apparaît pas, cette commande dans le Terminal lève le blocage :

```bash
xattr -dr com.apple.quarantine /Applications/FeedSwitch.app
```

### À partir du code

Il faut [Node.js](https://nodejs.org) 20 ou plus récent.

```bash
npm install
```

Pour lancer l'app directement :

```bash
npm start
```

Pour construire l'installateur de ton système (il arrive dans `dist/`) :

```bash
npm run dist
```

### Dans un navigateur, sans la fenêtre

```bash
npm run web
```

Puis ouvre <http://localhost:4173>.

## Utilisation

1. Colle le lien de la page dans la barre du haut, puis **Trouver les flux**.
2. L'analyse prend de 5 à 30 secondes. Le premier flux trouvé démarre tout seul.
3. Ajoute d'autres pages pour avoir des flux de secours. Clique sur un flux pour y passer, ou utilise les touches **1** à **9**.

| Action | Comment |
| --- | --- |
| Changer de flux | Clic sur le flux, ou touches 1 à 9 |
| Changer de qualité | Menu **Qualité** (Auto suit ta connexion) |
| Image dans l'image | Bouton, ou touche **P** |
| Recharger le flux | Bouton, ou touche **R** |
| Flux expiré ou figé | Flèche ↻ de la page : elle est analysée à nouveau et la lecture reprend sur le nouveau flux |
| Page qui liste plusieurs liens | Ouvre **Autres liens sur cette page** et clique **Analyser** sur ceux qui t'intéressent |

Tu peux aussi coller directement une adresse `.m3u8` (HLS) ou `.mpd` (DASH).

La liste des pages est gardée d'une session à l'autre. Les flux, eux, sont retrouvés à chaque analyse, car leurs adresses expirent.

## Comment ça marche

- **Détection** (`src/scanner.js`) : la page est ouverte dans un Chrome sans fenêtre. L'app ferme les pop-ups, bloque les redirections publicitaires, clique sur le lecteur jusqu'à ce qu'il démarre, et note chaque flux demandé par la page (HLS, DASH, fichiers vidéo), y compris dans les iframes. Elle fouille aussi le code de la page pour les adresses de playlist qui n'ont pas encore été chargées.
- **Vérification** (`src/store.js`) : chaque flux est testé depuis l'app. Les qualités sont lues dans la playlist, les doublons sont retirés.
- **Lecture** (`src/server.js`) : les flux HLS sont joués avec hls.js, les flux DASH avec dash.js, les fichiers vidéo directement. Dans tous les cas, le lecteur passe par un relais local qui renvoie à l'hébergeur les mêmes en-têtes que la page d'origine (Referer, Origin, cookies). Sans ça, la plupart des hébergeurs refusent la connexion.
- **Fenêtre** (`desktop/main.js`) : l'app de bureau démarre ce même serveur sur un port privé et l'affiche dans sa propre fenêtre.

## Limites connues

- **Flux protégés par DRM** (Widevine, PlayReady, FairPlay) : ils sont listés comme « trouvé, mais illisible : flux protégé par DRM », et l'app n'essaie pas de les contourner.
- **Pages derrière un captcha ou une vérification anti-robot** : l'analyse peut ne rien trouver. Lance l'app depuis un terminal avec `HEADLESS=0` pour voir la fenêtre de Chrome et passer la vérification à la main.
- **Flux liés à une adresse IP ou à une session** : ils apparaissent comme « trouvé, mais illisible ».

## Réglages

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `CHROME_PATH` | Chemin de l'exécutable Chrome, s'il n'est pas trouvé tout seul | détection automatique |
| `HEADLESS` | `0` pour afficher la fenêtre de Chrome pendant l'analyse | `1` |
| `PORT` | Port de l'interface (mode navigateur seulement) | `4173` |
| `HOST` | Adresse d'écoute (mode navigateur seulement). `0.0.0.0` rend l'app accessible aux autres appareils du réseau | `127.0.0.1` |

## Tests

```bash
./test/fixture/make-media.sh
```

```bash
npm test
```

Le premier script fabrique deux petits flux de test (HLS et DASH) avec `ffmpeg`. Les tests lancent ensuite un faux site de streaming (pub en surimpression, pop-up, lecteur en iframe, hébergeur qui exige le bon Referer) et vérifient que l'app y retrouve le flux.

N'utilise l'app qu'avec des flux que tu as le droit de regarder.
