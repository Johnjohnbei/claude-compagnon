# compagnon

Mod Claude Code : un panneau latéral qui s'ouvre avec chaque session et surveille le travail en cours.
Une card bordée par sujet : le titre et la valeur clé dans la bordure du haut, une ou deux lignes dedans (jauge courte, chiffre, détail). La bordure reste discrète quand tout va bien et passe en orange ou en rouge quand une card demande un coup d'œil. Les touches tiennent sur une ligne de légende sous les cards.

| Card | Ce qu'elle montre |
| --- | --- |
| Modèle | le modèle du fil principal, la décision du routage, le compte à rebours du cache et la taille à relire s'il refroidit, le maintien au chaud |
| Contexte | le remplissage de la fenêtre de contexte ; au-delà de 70 %, la card propose le handoff |
| Objectif | l'avancement du `/goal` sur la liste de tâches native, la tâche en cours, le temps restant estimé ; cachée sans objectif ni tâche |
| Forfait | la fenêtre 7 jours (pourcentage officiel) et une courbe des 7 derniers jours |
| Process | outil long, tâche de fond ou agent bloqué, attente de permission ; boutons « arrêter » et « voir » |
| Parallélisme | lectures faites l'une après l'autre au dernier tour, à grouper ou déléguer |
| Projets | branche, fichiers modifiés, commits à pousser ou en retard des dépôts touchés pendant la session, fichiers modifiés aussi par une autre session ouverte ; les autres dépôts suivis restent repliés |

Le panneau s'ouvre sur un schéma de la chaîne de modèles, puis les cards de suivi (contexte, forfait, objectif, process, parallélisme, projets). À partir de 84 colonnes, l'advisor est à côté du fil principal et les trois agents sont côte à côte ; en dessous, tout s'empile dans le même ordre.

| Bloc | Ce qu'il montre | D'où ça vient |
| --- | --- | --- |
| Advisor | nombre d'appels, âge du dernier, part du coût des tours où il a été consulté (le « ~ » marque une estimation : la variation du coût de session inclut aussi les sous-agents) | `session.append`, coût de session |
| Modèle | version lue dans l'identifiant renvoyé, cache, effort, versions vues par palier (alerte de 24 h quand un alias change), charge chargée avant la première parole (outils, mémoire, skills) et conversation | `turn.step`, `usage({ breakdown: 'summary' })` |
| Décisions | palier de la dernière demande, couche qui a décidé (mots-clés, classifieur, défaut), action (garder, basculer, déléguer), décomptes par couche | journal des décisions |
| Agents | `search`, `grep`, `audit` : en cours (durée), terminé (durée), échec ou inactif ; les autres agents sont comptés | `$.agent.list()` |
| Journal, ligne d'état | les dernières décisions ; agents actifs, appels advisor, décisions, coût | état du mod |
| Bandeau | une ligne au-dessus de la saisie : modèle, advisor, coût, contexte, agents | mêmes états |

Le conseil de l'advisor est chiffré par l'API : seul le nombre d'appels est visible, jamais son texte ni les jetons qu'il lit. Il n'y a pas de pourcentage de progression pour les agents : l'API n'en donne pas, la durée écoulée la remplace.

`/compagnon charge` imprime ce que la session charge avant la première parole, source par source : fichiers de mémoire avec leur chemin et leurs jetons, skills par plugin, agents, commandes et outils MCP par serveur. C'est la mesure à lancer avant d'alléger quoi que ce soit.

`/compagnon` rouvre le panneau, `/compagnon keepwarm [heures|off]` règle le maintien au chaud, `/compagnon handoff` demande un handoff.
Touches dans le panneau : `a` coupe ou réactive la bascule automatique, `k` garde le cache au chaud 2 h (ou l'arrête), `h` demande un handoff, `c` efface la session et repart du handoff prêt, `r` relit les dépôts, `p` déplie ou replie les dépôts non touchés.

## Classement des demandes

Trois couches, dans cet ordre :

1. **Mots-clés** : gratuits et instantanés.
2. **Classifieur** : une demande qu'aucun mot-clé ne reconnaît est classée par un appel Haiku (`$.model.classify`, une étiquette par palier). Environ 1 s et quelques centaines de jetons, seulement pour ces demandes. L'option `classify` le coupe.
3. **Repli sur Opus** : si le classifieur dépasse 3 s, échoue ou ne nomme aucune étiquette.

Mesure faite sur 30 demandes en français écrites pour l'occasion (donc biaisée) : 22/30 pour les mots-clés seuls, 29/30 avec le classifieur ; sur les 10 demandes sans mot-clé, 3/10 contre 10/10. Un échantillon de vos vraies demandes reste à constituer.

`/compagnon decisions` affiche le nombre de décisions par couche et les 20 dernières. Le mod garde les 200 dernières décisions dans son stockage local (`~/.claude/plugins/store/`), avec les 80 premiers caractères de chaque demande et jamais le texte entier.

## Bascule de modèle sans perte de cache

Un cache de prompt appartient à un modèle et ne se copie pas : changer de modèle fait relire toute la conversation sans cache.
Le mod reconnaît le besoin de chaque demande par mots-clés (aucun token dépensé), puis :

- il bascule le fil principal seulement quand c'est gratuit : cache déjà froid, durée de vie passée pendant la pause, compaction récente, ou contexte de moins de 40 k tokens ;
- sinon il garde le modèle principal et ajoute à la demande une consigne pour confier l'exécution à un sous-agent du bon modèle (un sous-agent part d'un contexte neuf, le cache principal reste intact) ;
- les relances courtes, les commandes et les sous-agents ne sont jamais routés.

Quand la bascule est refusée par le cache, la délégation est imposée : un sous-agent généraliste lancé sans modèle reçoit le palier choisi (un modèle donné par l'appel, un agent nommé, un fork ou un coéquipier ne sont pas touchés).

Aucun identifiant de modèle ni numéro de version n'est écrit dans le mod. La bascule envoie le nom du palier (`fable`, `opus`, `sonnet`, `haiku`) : le moteur le résout vers la version recommandée du moment, et `ANTHROPIC_DEFAULT_OPUS_MODEL` (et ses équivalents) le redirige ou le fige. La version affichée dans la card Modèle est lue dans l'identifiant que le moteur renvoie, pas dans le mod. Une nouvelle release de modèle ne demande donc aucun changement ici. Non vérifié : si `ANTHROPIC_DEFAULT_*_MODEL` s'applique à un alias envoyé par un mod (la doc ne le dit pas).

Version minimale : Claude Code 2.1.309 (avant, un alias envoyé par un mod fait échouer la requête). Si la version est plus ancienne, ou ne peut pas être lue, la bascule est coupée : le mod délègue alors à un sous-agent du bon modèle, comme sur un cache chaud.

## Gardes reprises de 5-mods

Trois mods de [inematds/5-mods](https://github.com/inematds/5-mods) (MIT) ont inspiré ces gardes, réécrites sur l'état du compagnon :

- **Cache froid** (Cache Keeper) : quand le cache est froid et que le contexte dépasse le seuil (150 k par défaut, option `coldGuardTokens`, 0 pour couper), l'envoi demande d'abord : envoyer, compacter puis envoyer, handoff puis session neuve (le message est renvoyé après), ou annuler. Sans personne pour répondre (`claude -p`), le message part tel quel.
- **Maintien au chaud** (Cache Keeper) : un ping `$.model.fork` sans outil part un peu avant la fin de vie du cache (8 min avant sur 1 h, 90 s sur 5 min), jamais pendant un tour. Il s'arrête à la durée choisie, ou dès qu'un ping réécrit le cache au lieu de le lire. Chaque ping consomme un peu de forfait.
- **Collision** (Collision Guard) : chaque session tient la liste des fichiers qu'elle a modifiés dans `~/.claude/mods-data/compagnon/edits/<session>.json`. Avant une modification, si une autre session ouverte a touché le même fichier depuis moins de 30 min, le mod demande : continuer, passer en worktree (fichier suivi par git seulement) ou annuler. Le refus est expliqué à Claude.
- **Handoff** (Cache Keeper) : Claude écrit l'état de la session dans `~/.claude/mods-data/compagnon/handoffs/`, puis `c` lance `/clear` et donne ce fichier comme premier message de la session neuve.
- **Objectif** (Goal Meter) : la card lit les outils de tâches natifs (TaskCreate, TaskUpdate, TodoWrite) et la condition de `/goal` ; aucun outil ni token en plus.

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

Options (réglables dans `/config`, rangée du plugin) :

- `projects` : chemins absolus des dépôts à suivre, séparés par `;`. Vide : le projet de la session seulement.
- `showBand` : le bandeau d'une ligne au-dessus de la saisie (coché par défaut) ; décocher pour ne garder que le panneau.
- `coldGuardTokens` : taille de contexte au-delà de laquelle un envoi sur cache froid demande d'abord (`150000` ou `150k`) ; `0` coupe la garde.

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

- Le classement par mots-clés est approximatif. Une demande qu'ils ne reconnaissent pas passe au classifieur (voir « Classement des demandes ») ; sans lui (option coupée, délai de 3 s dépassé ou échec), elle reste sur Opus.
- Le forfait n'est publié qu'en pourcentages ; la courbe 7 jours ne compte que les jours où une session a tourné.
- L'heuristique de parallélisme est propre à ce mod.
- La garde de collision ne voit que les sessions où le compagnon tourne.
- Après un ping de maintien, les chiffres de la ligne de statut sont en retard : le mod se fie au ping jusqu'à la fin de vie suivante.

## Développement

```
claude plugin validate .
claude plugin test .
```
