// Pure logic of the companion pane: no `$`, so the tests run it directly.
import type { Advice, CacheInfo, CacheVerdict, Collision, CtxPart, Decision, Effort, Ledger, Level, LogEntry, ParallelSummary, RepoState, RouteRecord, SeenModels, Source, TaskRow, Tier, ToolSpan, TurnCost } from '../types'

const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

// The pin sends the tier name itself through `turn.step` (`model: 'opus'`): the engine resolves the alias, and
// ANTHROPIC_DEFAULT_*_MODEL repoints it. No model id and no version is written in this mod, so a release changes nothing here.

/** Tier names as shown. A version is never written here: it is read from the id the engine reports (`modelLabel`). */
export const TIER_NAME: Record<Tier, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }

/** "5.5" out of "claude-opus-5-5" or "claude-sonnet-4-5-20250929"; null for an alias or an id with no version. */
export const versionOf = (model: string): string | null =>
  model.match(/-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/)?.slice(1).filter(Boolean).join('.') || null

/** "Opus 5.5" for a resolved id, "Opus" for an alias. */
export const modelLabel = (model: string): string => {
  const version = versionOf(model)
  return version ? `${TIER_NAME[tierOf(model)]} ${version}` : TIER_NAME[tierOf(model)]
}

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
// ponytail: keyword rules, zero token (user choice 2026-11-05); a Haiku classifier if the hit rate disappoints.
const RULES: Array<{ tier: Tier; effort: Effort; need: string; re: RegExp }> = [
  { tier: 'fable', effort: 'xhigh', need: 'Architecture ou cause racine', re: /architectur|cause racine|root cause|ambigu|stratégi|audit 360|refonte globale|arbitrage/i },
  { tier: 'opus', effort: 'high', need: 'Débogage', re: /\bbugs?\b|débog|debug|crash|régression|cassé|ne marche|plante|erreur/i },
  // A question that opens with a lookup word is a lookup, whatever it names (« liste les fichiers de tests »): above the edit and feature rules,
  // below the debugging and architecture ones (« où est le bug » stays a bug). JS \b is ASCII-only: it never matches after « où ».
  { tier: 'haiku', effort: 'low', need: 'Question simple', re: /^(où|ou est|liste|montre|combien|quel|quelle|git status|cherche|c'est quoi)(?=[\s,?:-]|$)/i },
  { tier: 'opus', effort: 'medium', need: 'Fonctionnalité ou refonte', re: /refactor|refonte|fonctionnalit|feature|implément|\bmod\b|composant|migration|\bplan\b|maquette/i },
  { tier: 'sonnet', effort: 'medium', need: 'Édition courante', re: /corrige|ajoute|modifie|texte|copie|tradui|\bdoc|tests?\b|lint|renomme|commit|push/i },
]

/** The cache is per model: below this, dropping to a cheaper model still pays. */
export const CACHE_KEEP_TOKENS = 40_000

export const tierOf = (model: string): Tier =>
  (['fable', 'opus', 'sonnet', 'haiku'] as const).find(t => model.toLowerCase().includes(t)) ?? 'opus'

/** The model a request needs; null for a follow-up ("ok", "continue") or a slash command, which keep the model. */
export function advise(text: string): Advice | null {
  const ask = text.trim()
  if (ask.length < 20 || ask.startsWith('/')) return null
  const rule = RULES.find(r => r.re.test(ask))
  const found = rule ?? { tier: 'opus' as Tier, effort: 'medium' as Effort, need: 'Demande générale' }
  return { tier: found.tier, effort: found.effort, need: found.need, reason: `${found.need} : ${TIER_NAME[found.tier]}, effort ${found.effort}`, source: rule ? 'keywords' : 'default' }
}

/**
 * Whether switching the main model now forfeits nothing. A prompt cache belongs to one model and cannot be copied
 * (Anthropic prompt-caching doc: exact prefix match, no transfer), so a switch is free only when the cache is
 * already cold (its TTL passed), was just rebuilt by a compaction, or is too small to matter.
 * Figures come from the status line's `prompt_cache` (code.claude.com/docs/en/statusline), relayed by
 * ~/.claude/hooks/statusline.js; without them we assume warm until a 1 h TTL has passed since the last turn.
 */
export function cacheState(cache: CacheInfo | null, now: number, lastTurnEnd: number, contextTokens: number, warmUntil = 0): CacheVerdict {
  const recache = cache?.recacheTokensIfCold ?? contextTokens
  const small = recache < CACHE_KEEP_TOKENS
  // A keep-warm ping read the cache after the status line last spoke: its figures are stale, the ping wins.
  if (warmUntil > now) return small ? { isFree: true, isCold: false, why: `petit contexte (${Math.round(recache / 1000)} k)`, recache } : { isFree: false, isCold: false, why: `cache gardé au chaud, ${Math.round(recache / 1000)} k`, recache }
  if (cache && cache.recacheTokensIfCold === null && cache.caching) return { isFree: true, isCold: false, why: 'compaction récente : le cache se reconstruit de toute façon', recache: 0 }
  const expires = cache?.expiresAt ? cache.expiresAt * 1000 : lastTurnEnd > 0 ? lastTurnEnd + ttlMs(cache) : 0
  if (cache && !cache.warm) return { isFree: true, isCold: true, why: 'cache déjà froid', recache }
  if (expires > 0 && now >= expires) return { isFree: true, isCold: true, why: 'cache expiré pendant la pause', recache }
  if (small) return { isFree: true, isCold: false, why: `petit contexte (${Math.round(recache / 1000)} k), relecture négligeable`, recache }
  return { isFree: false, isCold: false, why: `cache chaud de ${Math.round(recache / 1000)} k`, recache }
}

/** The cache's lifetime from the status line's `ttl` ("5m", "1h"); 1 h when unknown (the CLI's default on a plan). */
export function ttlMs(cache: CacheInfo | null): number {
  const m = String(cache?.ttl ?? '').match(/^(\d+)\s*(m|h)/i)
  return m ? Number(m[1]) * (m[2]?.toLowerCase() === 'h' ? 3_600_000 : 60_000) : 3_600_000
}

/** Cold-send guard (from Cache Keeper, inematds/5-mods): ask before a cold cache rewrites a big context. */
export const needsColdGuard = (verdict: CacheVerdict, threshold: number): boolean =>
  threshold > 0 && verdict.isCold && verdict.recache >= threshold

/**
 * Keep-warm: when to ping. The ping goes out a margin before the TTL ends (8 min on a 1 h cache, 90 s on 5 min),
 * never during a turn, and the run stops at its time limit.
 */
export function keepWarmDue(now: number, lastActivity: number, ttl: number, until: number, isWorking: boolean): 'stop' | 'ping' | 'wait' {
  if (now >= until) return 'stop'
  if (isWorking || lastActivity === 0) return 'wait'
  const margin = ttl >= 3_600_000 ? 480_000 : 90_000
  return now - lastActivity >= ttl - margin ? 'ping' : 'wait'
}

/**
 * A ping that wrote much of the context instead of reading it missed the cache: paying for more pings is waste.
 * The ping's own few tokens are always written, so a write under 2 k never counts as a miss.
 */
export const pingMissed = (u: { cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): boolean => {
  const written = u.cache_creation_input_tokens ?? 0
  return written > 2_000 && written > 0.1 * Math.max(1, u.cache_read_input_tokens ?? 0)
}

/** Edits another open session made, in the window, to files this session edited (Collision Guard, inematds/5-mods). */
export function collisionsWith(mine: Ledger['files'], others: Ledger[], now: number, windowMs: number): Collision[] {
  return others.flatMap(o =>
    Object.entries(o.files)
      .filter(([key, f]) => mine[key] && now - f.at <= windowMs)
      .map(([, f]) => ({ file: f.path.split(/[\\/]/).pop() ?? f.path, who: o.title || o.id.slice(0, 8), at: f.at })),
  )
}

/** The latest edit of `key` by another live session in the window, unless already allowed. */
export function collisionFor(key: string, others: Ledger[], now: number, windowMs: number, allowed: Map<string, number>): { other: Ledger; at: number } | null {
  let best: { other: Ledger; at: number } | null = null
  for (const o of others) {
    const f = o.files[key]
    if (!f || now - f.at > windowMs || (allowed.get(`${key}|${o.id}`) ?? 0) >= f.at) continue
    if (!best || f.at > best.at) best = { other: o, at: f.at }
  }
  return best
}

/** Goal progress on the native task list; the ETA (pace so far) only after two tasks are done. */
export function goalProgress(tasks: TaskRow[], startedAt: number, now: number): { done: number; total: number; pct: number; etaMs: number | null } {
  const live = tasks.filter(t => t.status !== 'deleted')
  const done = live.filter(t => t.status === 'completed').length
  const total = live.length
  const etaMs = done >= 2 && done < total ? ((now - startedAt) / done) * (total - done) : null
  return { done, total, pct: total ? (done / total) * 100 : 0, etaMs }
}

/** What Claude is asked to write for a handoff: a file a fresh session can resume from. */
export const handoffPrompt = (path: string): string =>
  `Écris un handoff de cette session dans le fichier ${path} (outil Write), pour qu'une session neuve reprenne sans rien perdre : objectif, état actuel, décisions prises et pourquoi, fichiers touchés, ce qui reste à faire dans l'ordre, pièges connus, commandes de vérification. Commence par le titre « # Handoff ». Ne fais rien d'autre.`

/** The first prompt of the fresh session: read the handoff, then carry on (and the message the cold guard held, if any). */
export const continuationPrompt = (path: string, pending: string): string =>
  `Reprise après handoff : lis ${path} en entier, puis continue le travail là où il s'est arrêté.${pending ? `\n\nMessage en attente : ${pending}` : ''}`

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

/** Usage thresholds used by ccusage and most status lines: green under 70 %, red from 90 %. */
export const levelOf = (pct: number): Level => (pct >= 90 ? 'alert' : pct >= 70 ? 'warn' : 'ok')

export const bar = (pct: number, width: number): string => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(full) + '░'.repeat(width - full)
}

const TICKS = '▁▂▃▄▅▆▇█'
export const sparkline = (values: number[]): string =>
  values.map(v => TICKS[Math.max(0, Math.min(7, Math.floor((v / 100) * 7.99)))]).join('')

export const ageLabel = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

export const resetLabel = (iso: string | undefined, now: number): string =>
  iso ? `reset dans ${ageLabel(Date.parse(iso) - now)}` : 'reset inconnu'

/** Local calendar day (Europe/Paris on this machine), the key of a daily sample. */
export const dayKey = (now: number): string => new Date(now).toLocaleDateString('sv-SE')

/** Peak of the 7-day window per local day. The 5-hour window is gone from the plan: not tracked. */
export type DailySamples = Record<string, number>

/** Keeps the day's peak, last 7 days only. */
export function recordSample(samples: DailySamples, day: string, week: number): DailySamples {
  const next = { ...samples, [day]: Math.max(samples[day] ?? 0, week) }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)).slice(-7))
}

/** The 7 days ending today, oldest first, 0 where nothing was sampled. */
export const lastSevenDays = (samples: DailySamples, now: number): number[] =>
  Array.from({ length: 7 }, (_, i) => samples[dayKey(now - (6 - i) * 86_400_000)] ?? 0)

/** One spelling for a path: forward slashes, no trailing slash, lower case, `/c/x` read as `c:/x` (Git Bash). */
export const normPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/(^|[\s"'=])\/([a-z])\//gi, '$1$2:/').replace(/\/+$/, '').toLowerCase()

/** The followed repositories a tool call touches: a path argument inside one, or a command naming one. */
export function touchedRepos(input: Record<string, unknown>, dirs: string[]): string[] {
  const values = Object.values(input).filter((v): v is string => typeof v === 'string').map(normPath)
  return dirs.filter(d => {
    const n = normPath(d)
    // A hit is the path followed by nothing that would continue a folder name (`projet-a-old` is not `projet-a`).
    const edge = new RegExp(`${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`)
    return values.some(v => edge.test(v))
  })
}

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS'])

/**
 * How parallel the last turn was. A run of read-only calls that each waited for the previous one is work a
 * single batched step (or independent subagents) would have done at once.
 * ponytail: heuristic of our own, no tool measures this (web research 2026-11-05).
 */
export function summarizeParallel(spans: ToolSpan[]): ParallelSummary {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const overlapped = sorted.filter(s => sorted.some(o => o !== s && o.start < s.end && s.start < o.end)).length
  let run = 0
  let longest = 0
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1]
    const isSequentialRead = READ_ONLY.has(s.tool) && (!prev || !READ_ONLY.has(prev.tool) || s.start >= prev.end)
    run = READ_ONLY.has(s.tool) ? (isSequentialRead ? run + 1 : 1) : 0
    longest = Math.max(longest, run)
  })
  return { total: sorted.length, overlapped, sequentialReads: longest, agents: sorted.filter(s => s.tool === 'Agent').length }
}

/** Parses `git status --porcelain=v2 --branch`. */
export function parseStatus(name: string, out: string): Omit<RepoState, 'dir' | 'lastCommit'> {
  const line = (key: string) => out.split('\n').find(l => l.startsWith(`# branch.${key} `))?.slice(`# branch.${key} `.length)
  const ab = line('ab')?.match(/\+(\d+) -(\d+)/)
  return {
    name,
    branch: line('head') ?? '?',
    ahead: ab ? Number(ab[1]) : 0,
    behind: ab ? Number(ab[2]) : 0,
    dirty: out.split('\n').filter(l => /^[12u?] /.test(l)).length,
    hasUpstream: line('upstream') !== undefined,
  }
}

/** The journal keeps the last dozen lines: it answers "what just happened", not "what happened today". */
export const LOG_MAX = 12
export const pushLog = (list: LogEntry[], entry: LogEntry): LogEntry[] => [...list, { ...entry, text: entry.text.replace(/\s+/g, ' ').slice(0, 100) }].slice(-LOG_MAX)

/** What the session cost moved by between two readings; never negative (a reload reads a lower figure). */
export const costDelta = (mark: number, now: number): number => Math.max(0, now - mark)

/** Turns and what they cost; `advisor*` count the turns where the advisor was consulted (an estimate: the figure also holds subagents). */
export function costSummary(turns: TurnCost[]): { turns: number; totalUsd: number; avgUsd: number; advisorTurns: number; advisorUsd: number; advisorShare: number } {
  const totalUsd = turns.reduce((s, t) => s + t.usd, 0)
  const withAdvisor = turns.filter(t => t.advisorCalls > 0)
  const advisorUsd = withAdvisor.reduce((s, t) => s + t.usd, 0)
  return { turns: turns.length, totalUsd, avgUsd: turns.length ? totalUsd / turns.length : 0, advisorTurns: withAdvisor.length, advisorUsd, advisorShare: totalUsd > 0 ? advisorUsd / totalUsd : 0 }
}

/** The categories the context really holds (what is loaded, not free space, the compaction buffer or deferred tools), largest first. */
export const contextParts = (categories: Array<{ name: string; tokens: number; kind?: string }>): CtxPart[] =>
  categories.filter(c => c.kind === 'used' && c.tokens > 0).map(c => ({ name: c.name, tokens: c.tokens })).sort((a, b) => b.tokens - a.tokens)

/**
 * Learns the id behind a tier from a model id the engine reported. `changed` is set when that tier already had another id:
 * an alias now resolves to a new release. An id that names no tier teaches nothing; an unseen tier is learned silently.
 */
export function releaseOf(seen: SeenModels, model: string): { seen: SeenModels; changed: { tier: Tier; from: string; to: string } | null } {
  const tier = (['fable', 'opus', 'sonnet', 'haiku'] as const).find(t => model.toLowerCase().includes(t))
  if (!tier || seen[tier] === model) return { seen, changed: null }
  const from = seen[tier]
  return { seen: { ...seen, [tier]: model }, changed: from ? { tier, from, to: model } : null }
}

/** A boolean option, whichever way the engine hands it (a boolean or the text "true"/"false"): on unless it says off. */
export const isOptionOn = (value: unknown): boolean => value !== false && String(value ?? '').trim().toLowerCase() !== 'false'

/**
 * The classifier layer: what the keyword rules did not recognise goes to `$.model.classify` with one label per tier.
 * The label carries the criteria, so the model reads what each tier is for. Measured on 30 synthetic French requests:
 * 29/30 against 22/30 for the keywords alone, 10/10 against 3/10 on the ones without a keyword.
 */
export const CLASSIFY_LABELS: Record<Tier, string> = {
  haiku: 'question simple de recherche ou de lecture (où, liste, montre, combien)',
  sonnet: 'modification courante et précise (corriger, ajouter, renommer, texte, test, commit)',
  opus: 'débogage, nouvelle fonctionnalité, refonte ou plan de travail',
  fable: "décision d'architecture, cause racine ou arbitrage entre approches",
}
export const CLASSIFY_TIMEOUT_MS = 3000
const CLASSIFIED_EFFORT: Record<Tier, Effort> = { haiku: 'low', sonnet: 'medium', opus: 'medium', fable: 'xhigh' }

export const tierOfLabel = (label: string): Tier | undefined => (Object.keys(CLASSIFY_LABELS) as Tier[]).find(t => CLASSIFY_LABELS[t] === label)

/** The advice a classifier answer makes. */
export const adviseClassified = (tier: Tier): Advice => ({
  tier,
  effort: CLASSIFIED_EFFORT[tier],
  need: 'Classé par le modèle',
  reason: `Classé par le modèle : ${TIER_NAME[tier]}, effort ${CLASSIFIED_EFFORT[tier]}`,
  source: 'classifier',
})

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
