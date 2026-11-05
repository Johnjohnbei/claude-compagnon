# compagnon

Mod Claude Code : un panneau latéral qui s'ouvre avec chaque session et surveille le travail en cours.
Six lignes, une par sujet, avec une pastille verte, orange ou rouge ; le détail n'apparaît que si un sujet demande un coup d'œil.

| Card | Ce qu'elle montre |
| --- | --- |
| Modèle | le modèle du fil principal, la décision du routage, l'état du cache de prompt |
| Contexte | le remplissage de la fenêtre de contexte |
| Forfait | la fenêtre 7 jours (pourcentage officiel) et une courbe des 7 derniers jours |
| Process | outil long, tâche de fond ou agent bloqué, attente de permission ; boutons « arrêter » et « voir » |
| Parallélisme | lectures faites l'une après l'autre au dernier tour, à grouper ou déléguer |
| Projets | branche, fichiers modifiés, commits à pousser ou en retard des dépôts touchés pendant la session ; les autres dépôts suivis restent repliés |

`/compagnon` rouvre le panneau. Touches dans le panneau : `a` coupe ou réactive la bascule automatique, `r` relit les dépôts, `p` déplie ou replie les dépôts non touchés.

## Bascule de modèle sans perte de cache

Un cache de prompt appartient à un modèle et ne se copie pas : changer de modèle fait relire toute la conversation sans cache.
Le mod reconnaît le besoin de chaque demande par mots-clés (aucun token dépensé), puis :

- il bascule le fil principal seulement quand c'est gratuit : cache déjà froid, durée de vie passée pendant la pause, compaction récente, ou contexte de moins de 40 k tokens ;
- sinon il garde le modèle principal et ajoute à la demande une consigne pour confier l'exécution à un sous-agent du bon modèle (un sous-agent part d'un contexte neuf, le cache principal reste intact) ;
- les relances courtes, les commandes et les sous-agents ne sont jamais routés.

## Installation

Dans une session Claude Code, au terminal :

```
/plugin install compagnon --marketplace Johnjohnbei/claude-compagnon
```

Répondre `y` pour ajouter le marketplace, puis choisir la portée (utilisateur = toutes les sessions).

Depuis un shell :

```
claude plugin install compagnon --marketplace Johnjohnbei/claude-compagnon
```

Dans l'application de bureau, où `/plugin` ne s'exécute pas : cliquer sur + à côté de la zone de saisie, puis Plugins, Add marketplace avec `Johnjohnbei/claude-compagnon`, puis Add plugin.

Le dépôt est privé : l'installation ne marche que pour un compte GitHub qui peut le lire, sur une machine qui a déjà un accès git à github.com (clé SSH, ou `gh auth login` puis `gh auth setup-git`).

## Réglages

Option `projects` (réglable dans `/config`, rangée du plugin) : chemins absolus des dépôts à suivre, séparés par `;`. Vide : le projet de la session seulement.

## Chiffres du cache

L'API des mods ne donne pas l'état du cache ; seule la ligne de statut le reçoit (`prompt_cache`). Pour que le mod le lise, le script de ligne de statut doit écrire ce champ dans `claude-ctx-<session_id>.json` du dossier temporaire :

```js
// dans votre script de ligne de statut (Node), input = le JSON reçu sur stdin
require('node:fs').writeFileSync(
  require('node:path').join(require('node:os').tmpdir(), `claude-ctx-${input.session_id}.json`),
  JSON.stringify({ prompt_cache: input.prompt_cache ?? null }),
)
```

Sans ce relais, le mod suppose le cache chaud pendant 1 h après le dernier tour.

## Limites

- Le classement par mots-clés est approximatif : une demande non reconnue reste sur Opus.
- Le forfait n'est publié qu'en pourcentages ; la courbe 7 jours ne compte que les jours où une session a tourné.
- L'heuristique de parallélisme est propre à ce mod.

## Développement

```
claude plugin validate .
claude plugin test .
```
