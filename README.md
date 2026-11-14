# FeedSwitch

Colle le lien d'une page de streaming : l'app ouvre la page en arrière-plan, repère les flux vidéo qui s'y cachent (avec leurs qualités) et les joue dans un lecteur propre, sans pub ni pop-up. Tu peux ajouter plusieurs pages et passer d'un flux à l'autre en un clic.

## Installation

Il faut [Node.js](https://nodejs.org) 20 ou plus récent, et Google Chrome (ou Edge) installé sur l'ordinateur.

```bash
npm install
```

```bash
npm start
```

Ouvre ensuite <http://localhost:4173> dans ton navigateur.

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

Tu peux aussi coller directement une adresse `.m3u8`.

La liste des pages est gardée d'une session à l'autre (`data/sources.json`). Les flux, eux, sont retrouvés à chaque analyse, car leurs adresses expirent.

## Comment ça marche

- **Détection** (`src/scanner.js`) : la page est ouverte dans un Chrome sans fenêtre. L'app ferme les pop-ups, bloque les redirections publicitaires, clique sur le lecteur jusqu'à ce qu'il démarre, et note chaque flux demandé par la page (HLS, DASH, fichiers vidéo), y compris dans les iframes. Elle fouille aussi le code de la page pour les adresses de playlist qui n'ont pas encore été chargées.
- **Vérification** (`src/store.js`) : chaque flux est testé depuis l'app. Les qualités sont lues dans la playlist, les doublons sont retirés.
- **Lecture** (`src/server.js`) : le lecteur passe par un relais local qui renvoie à l'hébergeur les mêmes en-têtes que la page d'origine (Referer, Origin, cookies). Sans ça, la plupart des hébergeurs refusent la connexion.

## Limites connues

- **Flux protégés par DRM** (Widevine, FairPlay) : illisibles, et l'app n'essaie pas de les contourner.
- **Flux DASH** (`.mpd`) : détectés et listés, mais pas encore lisibles dans le lecteur.
- **Pages derrière un captcha ou une vérification anti-robot** : l'analyse peut ne rien trouver. Lance l'app avec `HEADLESS=0` pour voir la fenêtre de Chrome et passer la vérification à la main.
- **Flux liés à une adresse IP ou à une session** : ils apparaissent comme « trouvé, mais illisible ».

## Réglages

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` | Port de l'interface | `4173` |
| `HOST` | Adresse d'écoute. `0.0.0.0` rend l'app accessible aux autres appareils du réseau | `127.0.0.1` |
| `CHROME_PATH` | Chemin de l'exécutable Chrome, s'il n'est pas trouvé tout seul | détection automatique |
| `HEADLESS` | `0` pour afficher la fenêtre de Chrome pendant l'analyse | `1` |

## Tests

```bash
./test/fixture/make-media.sh
```

```bash
npm test
```

Le premier script fabrique une petite vidéo de test avec `ffmpeg`. Les tests lancent ensuite un faux site de streaming (pub en surimpression, pop-up, lecteur en iframe, hébergeur qui exige le bon Referer) et vérifient que l'app y retrouve le flux.

N'utilise l'app qu'avec des flux que tu as le droit de regarder.
