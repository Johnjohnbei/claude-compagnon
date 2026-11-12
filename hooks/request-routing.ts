// Which model a request gets: keyword rules, the classifier layer, the route against the cache, and the decisions log. No `$`.
import type { Advice, CacheVerdict, Decision, Effort, RouteRecord, Source, Tier } from '../types'
import { DEFAULT_TIER, TIER_NAME, TIERS, byTier, rankOf } from './tiers'

/** Engine version from which `turn.step` accepts an alias; before it the alias reaches the API as is and the request fails. */
const ALIAS_MIN_VERSION = [2, 1, 309]

/**
 * Whether the engine accepts an alias in `turn.step`. `version` is what `$.session.version()` returns (a string or an
 * object, `{ version, base, builtAt }` on 2.1.318): the first x.y.z found in it is read. When no version can be read the
 * answer is false, so a doubt switches the automatic pin off and never breaks a turn.
 */
export function supportsAlias(version: unknown): boolean {
  const found = (typeof version === 'string' ? version : JSON.stringify(version) ?? '').match(/(\d+)\.(\d+)\.(\d+)/)
  if (!found) return false
  const have = found.slice(1).map(Number)
  const diff = ALIAS_MIN_VERSION.findIndex((min, i) => have[i] !== min)
  return diff === -1 || (have[diff] ?? 0) > (ALIAS_MIN_VERSION[diff] ?? 0)
}

// First match wins, strongest need first. Sources: Anthropic model-config (Fable for ambiguous problems and
// architecture, Opus for complex reasoning, Sonnet for daily coding, Haiku for simple tasks) and the former
// rules of an earlier router kept here: upgrade freely, downgrade only on a small context, never route subagents.
// ponytail: keyword rules, zero token (user choice 2026-11-05); what they miss, or only the weak edit rule catches, goes to the Haiku classifier (CLASSIFY_LABELS).
// The debugging rule is strong (never second-guessed), so a substring hit there costs an Opus turn: « erreur de frappe » is a typo
// (its twin « faute de frappe » already went to the edit rule), and « plante » must start a word (« implante » is no crash).
export const RULES: Array<{ tier: Tier; effort: Effort; need: string; re: RegExp }> = [
  { tier: 'fable', effort: 'xhigh', need: 'Architecture ou cause racine', re: /architectur|cause racine|root cause|ambigu|stratégi|audit 360|refonte globale|arbitrage/i },
  { tier: 'opus', effort: 'high', need: 'Débogage', re: /\bbugs?\b|débog|debug|crash|régression|cassé|ne marche|\bplante|erreur(?!s? de frappe)/i },
  // A request that opens with a lookup word or verb is a lookup, whatever it names (« liste les fichiers de tests », « cartographie ce dépôt »): above the edit and feature rules,
  // below the debugging and architecture ones (« où est le bug » stays a bug). JS \b is ASCII-only: it never matches after « où ».
  { tier: 'haiku', effort: 'low', need: 'Question simple', re: /^(où|ou est|liste|montre|combien|quel|quelle|git status|cherche|c'est quoi|cartograph\w*|trouve|recense|repère|dresse la liste|(?:fais|donne)(?:-moi)? la liste|qui appelle)(?=[\s,?:-]|$)/i },
  { tier: 'opus', effort: 'medium', need: 'Fonctionnalité ou refonte', re: /refactor|refonte|fonctionnalit|feature|implément|\bmod\b|composant|migration|\bplan\b|maquette/i },
  { tier: 'sonnet', effort: 'medium', need: 'Édition courante', re: /corrige|ajoute|modifie|texte|copie|tradui|\bdoc|tests?\b|lint|renomme|commit|push/i },
]

/** The model a request needs; null for a follow-up ("ok", "continue") or a slash command, which keep the model. */
export function advise(text: string): Advice | null {
  const ask = text.trim()
  if (ask.length < 20 || ask.startsWith('/')) return null
  const rule = RULES.find(r => r.re.test(ask))
  const found = rule ?? { tier: DEFAULT_TIER, effort: CLASSIFIED_EFFORT[DEFAULT_TIER], need: 'Demande générale' }
  return { tier: found.tier, effort: found.effort, need: found.need, reason: `${found.need} : ${TIER_NAME[found.tier]}, effort ${found.effort}`, source: rule ? 'keywords' : 'default' }
}

/**
 * The automatic route of a request: switch the main loop when it is free, otherwise keep the warm cache and hand
 * the work to a subagent on the right model (a subagent starts from a fresh context, so the main cache is untouched).
 */
export function route(advice: Advice, current: Tier, verdict: CacheVerdict): Decision {
  if (advice.tier === current) return { action: 'keep', tier: current, effort: advice.effort, why: advice.reason }
  if (verdict.isFree) return { action: 'switch', tier: advice.tier, effort: advice.effort, why: `${verdict.why} : bascule vers ${TIER_NAME[advice.tier]}` }
  return { action: 'delegate', tier: advice.tier, effort: advice.effort, why: `${verdict.why} : ${TIER_NAME[current]} garde la main, travail confié à un sous-agent ${TIER_NAME[advice.tier]}` }
}

/** A switch the engine cannot take (no alias support) becomes a delegation: the work still reaches the right model. */
export const withoutPin = (d: Decision, current: Tier): Decision =>
  d.action === 'switch' ? { ...d, action: 'delegate', why: `${TIER_NAME[current]} garde la main (bascule indisponible sur ce moteur), travail confié à un sous-agent ${TIER_NAME[d.tier]}` } : d

/**
 * The tier a delegation imposes on a subagent. Only a general-purpose subagent whose call named no model gets it: a model
 * the call gave stays (Claude may have a reason), a named agent keeps the model its definition gives (the Haiku scouts),
 * and a fork, a teammate or a resumed run is left alone.
 */
export function spawnModel(d: Decision | null, e: { subagentType: string; model?: string; fork?: boolean; isTeammate?: boolean; resume?: unknown }): Tier | undefined {
  if (!d || d.action !== 'delegate' || e.model || e.fork || e.isTeammate || e.resume) return undefined
  return e.subagentType === 'general-purpose' ? d.tier : undefined
}

/** Appended to the user's message (never to the system prompt, which would break the cache it protects). */
export const delegationHint = (d: Decision, need: string): string =>
  `\n\n[compagnon] Besoin détecté : ${need.toLowerCase()}. Pour ne pas perdre le cache de ce contexte, garde le modèle actuel pour piloter et confie l'exécution à un sous-agent avec model: "${d.tier}", en lui donnant un brief complet (fichiers, objectif, critères). Si la tâche est trop courte pour valoir un sous-agent, fais-la directement.`

/**
 * The classifier layer: what the keyword rules did not recognise goes to `$.model.classify` with one label per tier.
 * The label carries the criteria, so the model reads what each tier is for. Measured on 30 synthetic French requests:
 * 29/30 against 22/30 for the keywords alone, 10/10 against 3/10 on the ones without a keyword.
 */
export const CLASSIFY_LABELS: Record<Tier, string> = byTier(t => t.label)
export const CLASSIFY_TIMEOUT_MS = 3000
const CLASSIFIED_EFFORT: Record<Tier, Effort> = byTier(t => t.effort)

export const tierOfLabel = (label: string): Tier | undefined => TIERS.find(t => t.label === label)?.id

/** The advice a classifier answer makes. */
export const adviseClassified = (tier: Tier): Advice => ({
  tier,
  effort: CLASSIFIED_EFFORT[tier],
  need: 'Classé par le modèle',
  reason: `Classé par le modèle : ${TIER_NAME[tier]}, effort ${CLASSIFIED_EFFORT[tier]}`,
  source: 'classifier',
})

/** The keyword rule whose hit is the weakest signal (« ajoute », « texte », « commit » appear in features and decisions too). */
const EDIT_NEED = 'Édition courante'

/** Whether the classifier is worth a call: nothing recognised the request, or only the weak edit rule did. */
export const needsClassifier = (advice: Advice): boolean => advice.source === 'default' || advice.need === EDIT_NEED

/**
 * The advice once the classifier has answered (or not). An unrecognised request takes the classifier's tier; a weak edit-rule hit
 * only goes UP (a classifier saying "feature" or "architecture" overrides « ajoute »), never down. Measured on 37 synthetic French
 * requests: 33/37 with the keywords then the classifier for what they miss, 35/37 when it may also raise the edit rule.
 */
export function settle(keyword: Advice, classified: Tier | undefined): Advice {
  if (!classified) return keyword
  if (keyword.source === 'default') return adviseClassified(classified)
  return rankOf(classified) > rankOf(keyword.tier) ? adviseClassified(classified) : keyword
}

export const SOURCE_NAME: Record<Source, string> = { keywords: 'mots-clés', classifier: 'classifieur', default: 'défaut' }

/** The routing decisions kept for review: the last two hundred. */
export const ROUTE_LOG_MAX = 200
export const routeRecord = (at: number, text: string, need: Advice, action: RouteRecord['action']): RouteRecord => ({
  at,
  source: need.source,
  tier: need.tier,
  effort: need.effort,
  action,
  head: text.replace(/\s+/g, ' ').trim().slice(0, 80),
})
export const pushRoute = (list: RouteRecord[], record: RouteRecord): RouteRecord[] => [...list, record].slice(-ROUTE_LOG_MAX)

/** The review the `/compagnon decisions` command prints: the layer counts, then the last lines. */
export function routeReport(list: RouteRecord[], last = 20): string {
  if (list.length === 0) return 'Aucune décision enregistrée pour l’instant.'
  const count = (s: Source) => list.filter(r => r.source === s).length
  const lines = list.slice(-last).map(r => `${new Date(r.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}  ${SOURCE_NAME[r.source].padEnd(10)} ${TIER_NAME[r.tier].padEnd(6)} ${r.action.padEnd(8)} ${r.head}`)
  return [`${list.length} décision${list.length > 1 ? 's' : ''} : mots-clés ${count('keywords')}, classifieur ${count('classifier')}, défaut ${count('default')}.`, ...lines].join('\n')
}
