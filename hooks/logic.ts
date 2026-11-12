// Pure logic of the companion pane: no `$`, so the tests run it directly. The tiers, the request routing and the
// load report live in tiers.ts, request-routing.ts and load-report.ts.
import type { CacheInfo, CacheVerdict, Collision, ErrorEntry, Ledger, Level, LogEntry, RepoState, TaskRow, TurnCost } from '../types'

/** The cache is per model: below this, dropping to a cheaper model still pays. */
export const CACHE_KEEP_TOKENS = 40_000

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
  if (warmUntil > now) return small ? { isFree: true, isCold: false, why: `small context (${Math.round(recache / 1000)}k)`, recache } : { isFree: false, isCold: false, why: `cache kept warm, ${Math.round(recache / 1000)}k`, recache }
  if (cache && cache.recacheTokensIfCold === null && cache.caching) return { isFree: true, isCold: false, why: 'recent compaction: the cache is rebuilt anyway', recache: 0 }
  const expires = cache?.expiresAt ? cache.expiresAt * 1000 : lastTurnEnd > 0 ? lastTurnEnd + ttlMs(cache) : 0
  if (cache && !cache.warm) return { isFree: true, isCold: true, why: 'cache already cold', recache }
  if (expires > 0 && now >= expires) return { isFree: true, isCold: true, why: 'cache expired during the pause', recache }
  if (small) return { isFree: true, isCold: false, why: `small context (${Math.round(recache / 1000)}k), negligible reread`, recache }
  return { isFree: false, isCold: false, why: `warm cache of ${Math.round(recache / 1000)}k`, recache }
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

/**
 * Another session's ledger file, read back; null when it is not one. The file is written by another process and may be
 * cut short, from an older version or edited by hand: valid JSON is not enough, a ledger without `files` used to throw in
 * every later collision check. A file entry without its path or time is dropped, the rest of the ledger kept.
 */
export function asLedger(raw: unknown): Ledger | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.updatedAt !== 'number' || typeof r.files !== 'object' || r.files === null) return null
  const files = Object.fromEntries(
    Object.entries(r.files as Record<string, unknown>).filter(
      (entry): entry is [string, { path: string; at: number }] => typeof (entry[1] as { path?: unknown })?.path === 'string' && typeof (entry[1] as { at?: unknown })?.at === 'number',
    ),
  )
  return { id: r.id, title: typeof r.title === 'string' ? r.title : '', updatedAt: r.updatedAt, ended: r.ended === true, files }
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
  `Write a handoff of this session to the file ${path} (Write tool), so that a fresh session resumes without losing anything: goal, current state, decisions made and why, files touched, what remains to do in order, known pitfalls, verification commands. Start with the title "# Handoff". Do nothing else.`

/** The first prompt of the fresh session: read the handoff, then carry on (and the message the cold guard held, if any). */
export const continuationPrompt = (path: string, pending: string): string =>
  `Resuming after a handoff: read ${path} in full, then carry on with the work where it stopped.${pending ? `\n\nPending message: ${pending}` : ''}`

/** An agent loop that ended (AgentStatus: completed, failed or killed). Anything else (pending, running, waiting, idle) is active. */
const FINISHED_AGENT = new Set(['completed', 'failed', 'killed'])
export const isFinished = (status: string): boolean => FINISHED_AGENT.has(status)
/** The agents the band and the status line count as active: one rule for both. */
export const activeAgents = <A extends { status: string }>(list: A[]): A[] => list.filter(a => !isFinished(a.status))

/** How long `✓ done` stays once the last turn or agent ended: drawn at the end, gone by the next 15 s refresh or the one after. */
export const DONE_MS = 20_000
export type Activity = { state: 'working'; since: number } | { state: 'done'; at: number } | null
/**
 * Whether Claude is busy: a main turn in flight (`turnStartedAt`, 0 when none) or an agent still active; `since` is the
 * earliest of their starts. Nothing in flight: `done` for DONE_MS after the last end, then nothing.
 */
export function activityOf(turnStartedAt: number, lastTurnEnd: number, agents: Array<{ status: string; firstSeen: number; endedAt?: number }>, now: number): Activity {
  const starts = [...(turnStartedAt > 0 ? [turnStartedAt] : []), ...activeAgents(agents).map(a => a.firstSeen)]
  if (starts.length > 0) return { state: 'working', since: Math.min(...starts) }
  const ended = Math.max(lastTurnEnd, ...agents.map(a => a.endedAt ?? 0))
  return ended > 0 && now - ended < DONE_MS ? { state: 'done', at: ended } : null
}

/** What the companion shows: the one state that sums the session up, by priority (see `moodOf`). */
export type Mood = 'work' | 'wait' | 'done' | 'error' | 'idle'
/** A failed turn is read for a minute after the mod recorded an error, when no turn is in flight. */
export const FRESH_ERROR_MS = 60_000
/** Whether the mod recorded an error during the turn in flight, or in the last minute when none runs. */
export const hasFreshError = (errors: Array<{ at: number }>, turnStartedAt: number, now: number): boolean =>
  errors.some(e => e.at >= (turnStartedAt > 0 ? turnStartedAt : now - FRESH_ERROR_MS))
/**
 * The mood: an error first (a failed agent, or the mod's own error this turn), then a session that waits for the person
 * (a permission prompt, a collision), then work in flight, then a turn just done, else idle.
 */
export function moodOf(s: { isFailed: boolean; isWaiting: boolean; activity: Activity }): Mood {
  if (s.isFailed) return 'error'
  if (s.isWaiting) return 'wait'
  return s.activity?.state === 'working' ? 'work' : s.activity?.state === 'done' ? 'done' : 'idle'
}
/** Only these two moods move: the pane is redrawn every frame while one holds, never otherwise. */
export const isAnimated = (mood: Mood): boolean => mood === 'work' || mood === 'wait'

/** `41:08`: a countdown or a duration in minutes and seconds. */
export const clockLabel = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
/** `2m14`: an elapsed time to the second, minutes not rolled into hours. */
export const elapsedLabel = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`
}

/** Usage thresholds used by ccusage and most status lines: green under 70 %, red from 90 %. */
export const levelOf = (pct: number): Level => (pct >= 90 ? 'alert' : pct >= 70 ? 'warn' : 'ok')

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
  iso ? `resets in ${ageLabel(Date.parse(iso) - now)}` : 'reset unknown'

/** "12/11/2026, 14:03": the date and time a report line carries (local time, 24 h). */
export const shortStamp = (at: number): string => new Date(at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })

/** Local calendar day (the machine's time zone), the key of a daily sample. */
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

/** The error log keeps the last twenty failures, each message cut to 120 characters. */
export const ERROR_LOG_MAX = 20
const ERROR_TEXT_MAX = 120

/**
 * The message of whatever was thrown (an Error, a hook failure, a string), on one line. Only the message is kept: never the
 * input of the call that failed, so a request's text does not reach the log through it.
 */
export function errorText(err: unknown, where = ''): string {
  const m = (err as { message?: unknown } | null | undefined)?.message
  const raw = typeof m === 'string' && m.trim() ? m : typeof err === 'string' && err.trim() ? err : (err as { kind?: unknown } | null | undefined)?.kind === 'timeout' ? 'timed out' : 'unknown error'
  return `${where ? `${where}: ` : ''}${raw}`.replace(/\s+/g, ' ').trim().slice(0, ERROR_TEXT_MAX)
}

export const pushError = (list: ErrorEntry[], entry: ErrorEntry): ErrorEntry[] =>
  [...list, { ...entry, message: entry.message.replace(/\s+/g, ' ').trim().slice(0, ERROR_TEXT_MAX) }].slice(-ERROR_LOG_MAX)

/** The log is kept across sessions (for `/compagnon errors`); the pane and the band count the errors of this session only. */
export const sessionErrors = (list: ErrorEntry[], session: string): ErrorEntry[] => list.filter(e => e.session === session)

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** The status line's one item: `✕ 2 errors, last: <message cut short>`; null when there is none. */
export const errorSummary = (list: ErrorEntry[]): string | null => {
  const last = list[list.length - 1]
  return last ? `✕ ${list.length} error${list.length > 1 ? 's' : ''}, last: ${cut(last.message, 48)}` : null
}

/** What `/compagnon errors` prints: the last twenty, each with its date and time, newest last. */
export function errorReport(list: ErrorEntry[]): string {
  if (list.length === 0) return 'No error recorded.'
  return [`${list.length} error${list.length > 1 ? 's' : ''} (last ${ERROR_LOG_MAX} kept, newest last):`, ...list.map(e => `${shortStamp(e.at)}  ${e.message}`)].join('\n')
}

/** What the session cost moved by between two readings; never negative (a reload reads a lower figure). */
export const costDelta = (mark: number, now: number): number => Math.max(0, now - mark)

/** Turns and what they cost; `advisor*` count the turns where the advisor was consulted (an estimate: the figure also holds subagents). */
export function costSummary(turns: TurnCost[]): { turns: number; totalUsd: number; avgUsd: number; advisorTurns: number; advisorUsd: number; advisorShare: number } {
  const totalUsd = turns.reduce((s, t) => s + t.usd, 0)
  const withAdvisor = turns.filter(t => t.advisorCalls > 0)
  const advisorUsd = withAdvisor.reduce((s, t) => s + t.usd, 0)
  return { turns: turns.length, totalUsd, avgUsd: turns.length ? totalUsd / turns.length : 0, advisorTurns: withAdvisor.length, advisorUsd, advisorShare: totalUsd > 0 ? advisorUsd / totalUsd : 0 }
}

/**
 * A token count option ("150000", "150k", "1,5 k", "150 000"); null when it reads as no count, so the caller keeps its
 * default. `Number('1.5k'.replace(/k$/, '000'))` used to read "1.5k" as 1.5 tokens, a guard that asked before every send.
 */
export function tokensOption(value: unknown): number | null {
  // A comma followed by exactly three digits is a thousands separator ("150,000"), not a decimal point.
  const m = String(value ?? '').replace(/\s+/g, '').replace(/,(?=\d{3}(?!\d))/g, '').replace(',', '.').match(/^(\d+(?:\.\d+)?)(k?)$/i)
  return m ? Math.round(Number(m[1]) * (m[2] ? 1000 : 1)) : null
}

/** A boolean option, whichever way the engine hands it (a boolean or the text "true"/"false"): on unless it says off. */
export const isOptionOn = (value: unknown): boolean => value !== false && String(value ?? '').trim().toLowerCase() !== 'false'

/**
 * The `prompt_cache` object the status line receives, as `~/.claude/hooks/statusline.js` (repo claude-config) writes it into
 * `claude-ctx-<session_id>.json`, read into a CacheInfo; null when there is none. This is the contract between the two repos:
 * keys warm, caching_observed, ttl, expires_at, recache_tokens_if_cold, hit_ratio. A key of another type reads as absent.
 */
export function cacheFromRelay(raw: unknown): CacheInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    warm: r.warm === true,
    caching: r.caching_observed === true,
    ttl: typeof r.ttl === 'string' ? r.ttl : undefined,
    expiresAt: num(r.expires_at),
    recacheTokensIfCold: num(r.recache_tokens_if_cold),
    hitRatio: num(r.hit_ratio),
  }
}
