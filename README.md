# compagnon

<p align="left"><img src="assets/coeurdar-logo.png" alt="Logo Coeurdar" height="48"></p>

Créé par [Coeurdar](https://coeurdar.com), projet de formation et de conseil en IA. Code open source sous licence MIT.

Mod Claude Code : un panneau latéral qui s'ouvre avec chaque session et surveille le travail en cours.
Une card bordée par sujet : le titre et la valeur clé dans la bordure du haut, une ou deux lignes dedans (jauge courte, chiffre, détail). La bordure reste discrète quand tout va bien et passe en orange ou en rouge quand une card demande un coup d'œil, et ▲ précède alors sa valeur, pour que l'état se lise aussi sans la couleur (le bandeau fait de même devant le contexte). Sur un panneau trop étroit pour le titre et la valeur, le titre est raccourci, jamais la valeur. Les touches tiennent sur une ligne de légende sous les cards.

| Card | Ce qu'elle montre |
| --- | --- |
| Modèle | le modèle du fil principal, la décision du routage, le compte à rebours du cache et la taille à relire s'il refroidit, le maintien au chaud |
| Contexte | le remplissage de la fenêtre de contexte ; au-delà de 70 %, la card propose le handoff |
| Objectif | l'avancement du `/goal` sur la liste de tâches native, la tâche en cours, le temps restant estimé ; cachée sans objectif ni tâche |
| Forfait | la fenêtre 7 jours (pourcentage officiel) et une courbe des 7 derniers jours |
| Process | outil long, tâche de fond ou agent bloqué, attente de permission ; boutons « arrêter » et « voir » |
| Parallélisme | lectures faites l'une après l'autre au dernier tour, à grouper ou déléguer |
| Projets | branche, fichiers modifiés, commits à pousser ou en retard des dépôts touchés pendant la session, fichiers modifiés aussi par une autre session ouverte ; les autres dépôts suivis restent repliés |

Le panneau s'ouvre sur un schéma de la chaîne de modèles, puis les cards de suivi (contexte, forfait, objectif, process, parallélisme, projets). Un panneau à côté de la conversation ne dépasse pas 45 % de la largeur du terminal (Ctrl+X puis flèche gauche lui donne de la place). En dessous de 84 colonnes, les blocs se suivent en colonne, reliés par des flèches (▽ conseil, ▼ décide, ▼ délègue, ▲ résultats), et les trois agents restent côte à côte tant que le panneau a au moins 41 colonnes, l'un sous l'autre en dessous ; à partir de 84 colonnes, l'advisor passe à côté du fil principal. Chaque rôle a sa couleur : jaune le fil principal, magenta l'advisor, vert les décisions, bleu les agents. Une alerte ajoute ▲ devant la valeur du bloc, sans changer sa couleur.

| Bloc | Ce qu'il montre | D'où ça vient |
| --- | --- | --- |
| Advisor | nombre d'appels, âge du dernier, part du coût des tours où il a été consulté (le « ~ » marque une estimation : la variation du coût de session inclut aussi les sous-agents) | `session.append`, coût de session |
| Modèle | version lue dans l'identifiant renvoyé, cache, effort, versions vues par palier (alerte de 24 h quand un alias change), charge chargée avant la première parole (outils, mémoire, skills) et conversation | `turn.step`, `usage({ breakdown: 'full' })` |
| Décisions | palier de la dernière demande, couche qui a décidé (mots-clés, classifieur, défaut), action (garder, basculer, déléguer), décomptes par couche | journal des décisions |
| Agents | `search`, `grep`, `audit` en trois petites cards : ● en cours (durée), ✓ terminé (durée), ✕ échec, · inactif ; les autres agents sont comptés | `$.agent.list()` |
| Journal, ligne d'état | les dernières décisions ; agents actifs, appels advisor, décisions, coût | état du mod |
| Bandeau | une ligne au-dessus de la saisie : modèle, advisor, coût, contexte, agents | mêmes états |

Le conseil de l'advisor est chiffré par l'API : seul le nombre d'appels est visible, jamais son texte ni les jetons qu'il lit. Il n'y a pas de pourcentage de progression pour les agents : l'API n'en donne pas, la durée écoulée la remplace.

`/compagnon charge` imprime ce que la session charge avant la première parole, source par source : fichiers de mémoire avec leur chemin et leurs jetons, skills par plugin, agents, commandes et outils MCP par serveur. Elle termine par des pistes pour les sources lourdes (un fichier de mémoire d'au moins 8 k jetons, un plugin ou un serveur MCP d'au moins 1,5 k). C'est la mesure à lancer avant d'alléger quoi que ce soit. La ligne « charge » du bloc Modèle et cette commande lisent le même détail (`breakdown: 'full'`, qui compte chaque fichier à part ; le mode `summary` sous-estimait la mémoire de 25 % environ).

`/compagnon` rouvre le panneau, `/compagnon keepwarm [heures|off]` règle le maintien au chaud, `/compagnon handoff` demande un handoff.
Touches dans le panneau : `a` coupe ou réactive la bascule automatique, `k` garde le cache au chaud 2 h (ou l'arrête), `h` demande un handoff, `c` efface la session et repart du handoff prêt, `r` relit les dépôts, `p` déplie ou replie les dépôts non touchés.

## Classement des demandes

Trois couches, dans cet ordre :

1. **Mots-clés** : gratuits et instantanés. Une demande qui s'ouvre par un verbe de recherche (où est, qui appelle, liste, cartographie, trouve, recense) part sur Haiku ; le débogage et l'architecture gardent la priorité.
2. **Classifieur** : une demande qu'aucun mot-clé ne reconnaît, ou que seule la règle d'édition courante reconnaît (« ajoute », « texte », « commit » : signal faible), est classée par un appel Haiku (`$.model.classify`, une étiquette par palier). Pour la règle d'édition courante, il peut seulement **relever** le palier, jamais le baisser. Environ 1 s et quelques centaines de jetons. L'option `classify` le coupe.
3. **Repli sur Opus** : si le classifieur dépasse 3 s, échoue ou ne nomme aucune étiquette.

Mesure faite sur 37 demandes en français écrites pour l'occasion (donc biaisée) : 28/37 pour les mots-clés seuls, 33/37 avec le classifieur pour ce qu'ils ne reconnaissent pas, 35/37 quand il peut aussi relever la règle d'édition courante. Sur une vraie cartographie de dépôt, le routage vers Haiku a coûté 0,022 $ contre 0,693 $ sur Opus (un seul essai). Un échantillon de vos vraies demandes reste à constituer.

`/compagnon decisions` affiche le nombre de décisions par couche et les 20 dernières. Le mod garde les 200 dernières décisions dans son stockage local (`~/.claude/plugins/store/`), avec les 80 premiers caractères de chaque demande et jamais le texte entier.

## Bascule de modèle sans perte de cache

Un cache de prompt appartient à un modèle et ne se copie pas : changer de modèle fait relire toute la conversation sans cache.
Le mod reconnaît le besoin de chaque demande par mots-clés (aucun token dépensé), puis :

- il bascule le fil principal seulement quand c'est gratuit : cache déjà froid, durée de vie passée pendant la pause, compaction récente, ou contexte de moins de 40 k tokens ;
- sinon il garde le modèle principal et ajoute à la demande une consigne pour confier l'exécution à un sous-agent du bon modèle (un sous-agent part d'un contexte neuf, le cache principal reste intact) ;
- les relances courtes, les commandes et les sous-agents ne sont jamais routés.

Quand la bascule est refusée par le cache, la délégation est imposée : un sous-agent généraliste lancé sans modèle reçoit le palier choisi (un modèle donné par l'appel, un agent nommé, un fork ou un coéquipier ne sont pas touchés).

Aucun identifiant de modèle ni numéro de version n'est écrit dans le mod. La bascule envoie le nom du palier (`fable`, `opus`, `sonnet`, `haiku`) : le moteur le résout vers la version recommandée du moment, et `ANTHROPIC_DEFAULT_OPUS_MODEL` (et ses équivalents) le redirige ou le fige. La version affichée dans la card Modèle est lue dans l'identifiant que le moteur renvoie, pas dans le mod. Une nouvelle release de modèle ne demande donc aucun changement ici. La ligne « nouvelle version » de la card n'apparaît que si l'identifiant renvoyé pour un palier est plus récent que celui mémorisé : un identifiant plus ancien (repli du moteur sur un pas, autre fenêtre dont l'alias résout encore vers la release précédente, constaté le 2026-11-07 avec `opus` donnant deux releases successives dans deux sessions ouvertes en parallèle) est ignoré. Non vérifié : si `ANTHROPIC_DEFAULT_*_MODEL` s'applique à un alias envoyé par un mod (la doc ne le dit pas).

Les paliers vivent dans une seule table, `TIERS` (`hooks/tiers.ts`) : identifiant, rang, nom affiché, effort par défaut et libellé du classifieur. Le type `Tier`, les rangs, les noms, la détection dans l'identifiant renvoyé par le moteur et les libellés du classifieur en dérivent : un nouveau palier ou une nouvelle famille de modèles demande une ligne dans cette table et son identifiant dans le type `Tier` de `types/index.d.ts` (ce fichier de contrat ne peut rien importer : la vérification de types refuse un palier présent d'un côté seulement), plus ses mots-clés dans les règles (`hooks/request-routing.ts`) s'il en a. Un test vérifie que chaque palier cité par les règles et le classifieur existe dans la table, et qu'un identifiant inconnu retombe sur Opus.

Version minimale : Claude Code 2.1.309 (avant, un alias envoyé par un mod fait échouer la requête). Si la version est plus ancienne, ou ne peut pas être lue, la bascule est coupée : le mod délègue alors à un sous-agent du bon modèle, comme sur un cache chaud.

## Gardes reprises de 5-mods

Trois mods de [inematds/5-mods](https://github.com/inematds/5-mods) (MIT) ont inspiré ces gardes, réécrites sur l'état du compagnon :

- **Cache froid** (Cache Keeper) : quand le cache est froid et que le contexte dépasse le seuil (150 k par défaut, option `coldGuardTokens`, 0 pour couper), l'envoi demande d'abord : envoyer, compacter puis envoyer, handoff puis session neuve (le message est renvoyé après), ou annuler. Sans personne pour répondre (`claude -p`), le message part tel quel.
- **Maintien au chaud** (Cache Keeper) : un ping `$.model.fork` sans outil part un peu avant la fin de vie du cache (8 min avant sur 1 h, 90 s sur 5 min), jamais pendant un tour. Il s'arrête à la durée choisie, ou dès qu'un ping réécrit le cache au lieu de le lire. Chaque ping consomme un peu de forfait.
- **Collision** (Collision Guard) : chaque session tient la liste des fichiers qu'elle a modifiés dans `~/.claude/mods-data/compagnon/edits/<session>.json`. Avant une modification, si une autre session ouverte a touché le même fichier depuis moins de 30 min, le mod demande : continuer, passer en worktree (fichier suivi par git seulement) ou annuler. Le refus est expliqué à Claude.
- **Handoff** (Cache Keeper) : Claude écrit l'état de la session dans `~/.claude/mods-data/compagnon/handoffs/`, puis `c` lance `/clear` et donne ce fichier comme premier message de la session neuve.
- **Objectif** (Goal Meter) : la card lit les outils de tâches natifs (TaskCreate, TaskUpdate, TodoWrite) et la condition de `/goal` ; aucun outil ni token en plus.

## Éléments construits

Construits par Coeurdar, dans ce dépôt :

- Panneau de supervision : cards Modèle, Contexte, Objectif, Forfait, Process, Parallélisme, Projets, bandeau d'une ligne.
- Bascule de modèle sans perte de cache, avec classement des demandes (mots-clés, classifieur Haiku, repli sur Opus).
- Gardes : cache froid, maintien au chaud, collision entre sessions, handoff.
- Commandes `/compagnon` (panneau, `charge`, `decisions`, `keepwarm`, `handoff`).

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

Le dépôt est public : aucun compte ni accès GitHub particulier n'est demandé, il suffit que `git` soit installé.

## Réglages

Options (réglables dans `/config`, rangée du plugin) :

- `projects` : chemins absolus des dépôts à suivre, séparés par `;`. Vide : le projet de la session seulement.
- `showBand` : le bandeau d'une ligne au-dessus de la saisie (coché par défaut) ; décocher pour ne garder que le panneau.
- `classify` : le classifieur des demandes que les mots-clés ne reconnaissent pas (coché par défaut, voir « Classement des demandes ») ; décocher pour garder les mots-clés seuls.
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

Aucune dépendance npm : `validate` et `test` sont fournis par la CLI. Pour la vérification de types, le moteur écrit les types de l'API (`claude-code`) et le `tsconfig.json` que celui du dépôt étend dans `.claude-plugin/types/`, quand il charge le mod depuis ce dossier en session interactive (`claude --plugin-dir .`) ; ensuite `npx -p typescript tsc -p .` (TypeScript 5.4 ou plus récent). Ce dossier est généré : git l'ignore. En `claude -p`, il n'est pas écrit.

## Contrat avec claude-config

Les deux dépôts restent séparés (le mod s'installe par marketplace et peut être partagé ; `claude-config` porte des mémoires privées et des chemins de machine). Ils ne se touchent qu'en trois points :

- **Le relais du cache** : `hooks/statusline.js` de claude-config écrit `claude-ctx-<session>.json` avec la clé `prompt_cache` ; le mod le lit avec `cacheFromRelay` (testé). Sans lui, le mod suppose le cache chaud 1 h.
- **Les noms des agents** `search`, `grep`, `audit` : la ligne d'état du panneau les suit. Un autre nom reste « inactif ».
- **Le plancher de modèle** : claude-config fixe `model` et `advisorModel` ; le mod relève le palier par demande. Le fil principal ne peut pas être imposé par les deux à la fois.
