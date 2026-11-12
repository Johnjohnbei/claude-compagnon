// The pane's bookkeeping, extracted from register.tsx (over its size): what keeps the state the cards read current,
// from the engine's figures and events, and the 15 s poll that refreshes it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AgentRow, CacheInfo, CacheVerdict, ErrorEntry, LogKind, SeenModels, TaskRow, Usage } from '../types'
import { keepWarmTick, refreshCollisions, writeLedger } from './guards'
import { TIER_NAME, releaseOf, tierOf, versionOf } from './tiers'
import { contextParts } from './load-report'
import { cacheFromRelay, cacheState, costDelta, dayKey, errorText, pushError, pushLog, sessionErrors, recordSample, ttlMs, type DailySamples } from './logic'
import { activityOf, hasFreshFailure, isBusy, isFinished, isInFlight, isMoving, moodOf, type Activity, type Mood, type TurnReason } from './mood'

// Declared again in each module that touches them: the state scan reads each module alone.
const pin = atom({ plugin: 'compagnon', key: 'pin' } as const, null, { shape: 'v1' })
const cache = atom({ plugin: 'compagnon', key: 'cache' } as const, null, { shape: 'v1' })
const lastTurnEnd = atom({ plugin: 'compagnon', key: 'lastTurnEnd' } as const, 0, { shape: 'v1' })
const background = atom({ plugin: 'compagnon', key: 'background' } as const, [], { shape: 'v1' })
const agents = atom({ plugin: 'compagnon', key: 'agents' } as const, [], { shape: 'v2' })
const usage = atom({ plugin: 'compagnon', key: 'usage' } as const, null, { shape: 'v1' })
const tick = atom({ plugin: 'compagnon', key: 'tick' } as const, 0, { shape: 'v1' })
const journal = atom({ plugin: 'compagnon', key: 'journal' } as const, [], { shape: 'v1' })
const costs = atom({ plugin: 'compagnon', key: 'costs' } as const, [], { shape: 'v1' })
const costMark = atom({ plugin: 'compagnon', key: 'costMark' } as const, 0, { shape: 'v1' })
const advisor = atom({ plugin: 'compagnon', key: 'advisor' } as const, { calls: 0, lastAt: 0, pending: 0 }, { shape: 'v1' })
const ctxParts = atom({ plugin: 'compagnon', key: 'ctxParts' } as const, [], { shape: 'v1' })
const seen = atom({ plugin: 'compagnon', key: 'seen' } as const, {}, { shape: 'v1' })
const keepWarm = atom({ plugin: 'compagnon', key: 'keepWarm' } as const, null, { shape: 'v1' })
const tasks = atom({ plugin: 'compagnon', key: 'tasks' } as const, [], { shape: 'v1' })
const goal = atom({ plugin: 'compagnon', key: 'goal' } as const, null, { shape: 'v1' })
const waiting = atom({ plugin: 'compagnon', key: 'waiting' } as const, null, { shape: 'v2' })
const collisionAsk = atom({ plugin: 'compagnon', key: 'collisionAsk' } as const, {}, { shape: 'v2' })
const lastTurnReason = atom({ plugin: 'compagnon', key: 'lastTurnReason' } as const, null, { shape: 'v1' })
const turnStartedAt = atom({ plugin: 'compagnon', key: 'turnStartedAt' } as const, 0, { shape: 'v1' })

const TICK_MS = 15_000
/** The companion's frame period while it moves: about two redraws a second (the engine allows ten). */
export const FRAME_MS = 450

type $ = EngineInterface

/** One write at a time: two failures at once would each read the log before the other wrote it, and one would be lost. */
let errorWrite: Promise<void> = Promise.resolve()

/**
 * Keeps a failure in $.store (`errorLog`, the last twenty): the status line and the band show the count, `/compagnon errors`
 * the list. Only the message is kept (errorText), with `where` naming the hook when known. Never throws.
 */
export function recordError($: $, err: unknown, where = ''): Promise<void> {
  const message = errorText(err, where)
  errorWrite = errorWrite
    .then(async () => {
      const [at, session] = await Promise.all([$.clock.now(), $.session.id()])
      const list = ((await $.store.get('errorLog')) ?? []) as ErrorEntry[]
      await $.store.set('errorLog', pushError(list, { at, session, message }))
    })
    .catch(() => undefined) // ponytail: the log itself failing has nowhere left to report to
  return errorWrite
}

/** This session's recorded errors, oldest first: what the status line and the band count. */
export async function errorsNow($: $): Promise<ErrorEntry[]> {
  const [list, session] = await Promise.all([$.store.get('errorLog'), $.session.id()])
  return sessionErrors((list ?? []) as ErrorEntry[], session)
}

/**
 * What the pane and the animation read: the activity, the mood, and whether anything moves. A wait is a permission prompt or an
 * open collision question (an `idle_prompt` is rest, and an allowed collision waits for no one). A failure is fresh for the turn
 * in flight, or two minutes; a failed agent stays listed past that, the mood follows the rest.
 */
export async function readMood($: $): Promise<{ mood: Mood; isMoving: boolean; activity: Activity; waitAt: number | null }> {
  const [now, ag, w, ask, started, ended, reason, errors] = await Promise.all([$.clock.now(), read($, agents), read($, waiting), read($, collisionAsk), read($, turnStartedAt), read($, lastTurnEnd), read($, lastTurnReason), errorsNow($)])
  const failures = [...ag.filter((a: { status: string }) => a.status === 'failed').map((a: { endedAt?: number; firstSeen: number }) => a.endedAt ?? a.firstSeen), ...errors.map(e => e.at)]
  const activity = activityOf(started, ended, ag, now, (reason ?? 'answer') as TurnReason)
  const asks = Object.values(ask ?? {})
  const isWaiting = Boolean(w) || asks.length > 0
  const state = { isFailed: hasFreshFailure(failures, started, now), isWaiting, activity }
  // The wait counts from the oldest open question or the permission, whichever came first.
  const waitAt = [...(w ? [w.at] : []), ...asks].reduce<number | null>((m, t) => (m === null || t < m ? t : m), null)
  return { mood: moodOf(state), isMoving: isMoving({ isWaiting, isBusy: isBusy(started, ag, now) }), activity, waitAt }
}

let isAnimating = false
/**
 * Redraws the pane every FRAME_MS while something is in flight or a permission waits, whatever the mood (a failed agent beside a running one still moves), and stops the moment nothing does: nothing runs at rest.
 * A frame is `$.ui.invalidate`, never a store or atom write: the pane derives its frame from the clock. One loop at a time;
 * called whenever motion may have begun (a turn, a prompt, an agent, the poll).
 */
export async function animateWhileMoving($: $): Promise<void> {
  if (isAnimating) return
  isAnimating = true
  try {
    while ((await readMood($)).isMoving) {
      // A wait that rejects is the environment going away (a reload): the loop ends with it.
      if (!(await $.clock.sleep(FRAME_MS).then(() => true, () => false))) return
      $.ui.invalidate('ui.render')
    }
  } finally {
    isAnimating = false
  }
}

/**
 * The pane's bookkeeping never fails a prompt or a tool call: a broken update is dropped and the work goes on, but the failure
 * is recorded, so a stale card says why instead of hiding a breakdown.
 */
export async function quietly($: $, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (err) {
    await recordError($, err)
  }
}

export async function refreshUsage($: $) {
  const u = await $.session.usage()
  const model = await $.session.model()
  const snap: Usage = {
    model,
    contextPct: u.context.percent ?? 0,
    contextTokens: u.context.tokens ?? 0,
    contextWindow: u.context.window,
    limits: u.rateLimits.map((l: Usage['limits'][number]) => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: u.cost?.usd ?? 0,
  }
  await update($, usage, () => snap)
  const week = snap.limits.find(l => l.kind === 'seven_day')?.percentUsed
  if (week !== undefined) {
    const was = ((await $.store.get('weekPeaks')) ?? {}) as DailySamples
    await $.store.set('weekPeaks', recordSample(was, dayKey(await $.clock.now()), week))
  }
}

// The status line is the only place the engine hands out cache figures; statusline.js relays them to a file.
export async function refreshCache($: $) {
  try {
    const dir = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
    const relayed = JSON.parse(await $.fs.read(`${dir}/claude-ctx-${await $.session.id()}.json`)).prompt_cache
    await update($, cache, () => cacheFromRelay(relayed))
  } catch {
    await update($, cache, () => null) // no relay yet: cacheState falls back to the 1 h TTL rule
  }
}

/** Until when a keep-warm ping holds the cache warm: 0 without a successful ping (the status line goes stale after one). */
export const warmUntilOf = (kw: { lastPingAt: number } | null, c: CacheInfo | null) => (kw?.lastPingAt ? kw.lastPingAt + ttlMs(c) : 0)

/** The cache verdict now, keep-warm pings included. */
export async function verdictNow($: $): Promise<CacheVerdict> {
  const [u, c, last, kw, now] = await Promise.all([read($, usage), read($, cache), read($, lastTurnEnd), read($, keepWarm), $.clock.now()])
  return cacheState(c, now, last, u?.contextTokens ?? 0, warmUntilOf(kw, c))
}

/** The session's task list, kept from the main loop's and subagents' task tools (they write the same list). */
export async function trackTasks($: $, tool: string, input: Record<string, unknown>, result: unknown) {
  const res = result as { task?: { id: string; subject: string } } | undefined
  const created = res?.task
  if (tool === 'TaskCreate' && created) await update($, tasks, list => [...list, { id: created.id, subject: created.subject, status: 'pending' as const }])
  if (tool === 'TaskUpdate' && typeof input.taskId === 'string')
    await update($, tasks, list => list.map(t => (t.id === input.taskId ? { ...t, status: (input.status as TaskRow['status']) ?? t.status, subject: (input.subject as string) ?? t.subject } : t)))
  if (tool === 'TodoWrite' && Array.isArray(input.todos))
    await update($, tasks, () => (input.todos as Array<{ content: string; status: TaskRow['status'] }>).map((t, i) => ({ id: `todo-${i}`, subject: t.content, status: t.status })))
  if (tool === 'ProposeGoal' && typeof input.condition === 'string') {
    const startedAt = await $.clock.now()
    await update($, goal, () => ({ condition: input.condition as string, startedAt }))
  }
}

export async function stopTask($: $, id: string) {
  await $.tool.call({ tool: 'TaskStop', task_id: id })
  await update($, background, list => list.filter(t => t.id !== id))
}

/** Agents already over when the session was cleared: the engine may keep listing them, they belong to the session before. */
const endedBeforeClear = new Set<string>()
export async function forgetEndedAgents($: $) {
  endedBeforeClear.clear()
  for (const a of await $.agent.list()) if (isFinished(a.status)) endedBeforeClear.add(a.id)
}

export async function refreshAgents($: $) {
  const now = await $.clock.now()
  const list = (await $.agent.list()).filter((a: { id: string; status: string }) => !(isFinished(a.status) && endedBeforeClear.has(a.id)))
  await update($, agents, (was: AgentRow[]) =>
    list.map((a: { id: string; description: string; type: string; status: string; parentId?: string; teammateId?: string }) => ({
      id: a.id,
      label: a.description,
      type: a.type,
      status: a.status,
      parentId: a.parentId,
      isTeammate: a.teammateId !== undefined,
      firstSeen: was.find(w => w.id === a.id)?.firstSeen ?? now,
      // A run begins when the status enters running or waiting, carries on while it stays there, and is remembered once it ended (its duration).
      runStart: isInFlight(a.status) ? (isInFlight(was.find(w => w.id === a.id)?.status ?? '') ? (was.find(w => w.id === a.id)?.runStart ?? was.find(w => w.id === a.id)?.firstSeen) : now) : was.find(w => w.id === a.id)?.runStart,
      // The moment it was first seen finished: the card shows how long it ran.
      endedAt: isFinished(a.status) ? (was.find(w => w.id === a.id)?.endedAt ?? now) : undefined,
    })),
  )
}

/** One line of the session journal. */
export async function note($: $, kind: LogKind, text: string) {
  const at = await $.clock.now()
  await update($, journal, list => pushLog(list, { at, kind, text }))
}

/** The ids the engine reported, kept across sessions: a newer id for a tier is a release, said once; an older one is a fallback or another window's alias, ignored (`releaseOf`). */
let seenNow: SeenModels | null = null
export async function trackModel($: $, model: unknown) {
  if (typeof model !== 'string' || model === '') return
  seenNow ??= ((await $.store.get('seenModels')) ?? {}) as SeenModels
  const learned = releaseOf(seenNow, model)
  if (learned.seen === seenNow) return
  seenNow = learned.seen
  await $.store.set('seenModels', seenNow)
  await update($, seen, () => learned.seen)
  if (!learned.changed) return
  const { tier, from, to } = learned.changed
  const change = `${TIER_NAME[tier]} ${versionOf(from) ?? from} → ${versionOf(to) ?? to}`
  await note($, 'release', change)
  await $.ui.toast(`compagnon: new version, ${change}`)
}

/** At a main-loop turn's end: what the turn cost (the cost figure's move), and what the context holds. */
export async function recordTurn($: $) {
  const [u, mark, adv, p] = await Promise.all([read($, usage), read($, costMark), read($, advisor), read($, pin)])
  if (!u) return
  const at = await $.clock.now()
  const usdMoved = costDelta(mark, u.costUsd)
  await update($, costMark, () => u.costUsd)
  if (usdMoved > 0 || adv.pending > 0) await update($, costs, list => [...list, { at, usd: usdMoved, tier: p?.tier ?? tierOf(u.model), advisorCalls: adv.pending }].slice(-200))
  await update($, advisor, a => ({ ...a, pending: 0 }))
  // `full` counts each file on its own; `summary` spreads the remainder over "System tools" and understates the memory (measured: 27k against 36k).
  const full = (await $.session.usage({ breakdown: 'full' })) as { context?: { breakdown?: { categories?: Array<{ name: string; tokens: number; kind?: string }> } } }
  await update($, ctxParts, () => contextParts(full.context?.breakdown?.categories ?? []))
}

// ponytail: one 15 s poll for ages, agents and usage (all free calls); a reload drops it and starts another.
export async function pollForever($: $) {
  for (;;) {
    // A wait that rejects is the environment going away (a reload, the session's end): the loop ends with it, instead of
    // leaving a rejection nothing handles.
    const isAwake = await $.clock.sleep(TICK_MS).then(() => true, () => false)
    if (!isAwake) return
    // One failed refresh (an engine call that rejects, a git missing) used to end this loop for the whole session: the
    // cards froze and the ledger's heartbeat stopped. Each turn of the loop is now its own bookkeeping, and each refresh
    // records its own failure (an allSettled used to drop them all without a trace).
    await quietly($, async () => {
      await update($, tick, (n: number) => n + 1)
      const n = await read($, tick)
      await Promise.all([quietly($, () => refreshAgents($)), quietly($, () => refreshUsage($)), quietly($, () => refreshCache($)), quietly($, () => refreshCollisions($))])
      // Not awaited: a slow ping must not hold the refreshes and the ledger's heartbeat (keepWarmTick skips a second ping).
      void quietly($, async () => keepWarmTick($, await read($, lastTurnEnd), ttlMs(await read($, cache))))
      void quietly($, () => animateWhileMoving($)) // an agent or a collision may have begun a mood that moves
      if (n % 4 === 0) await writeLedger($) // the ledger's heartbeat: a ledger quiet for 15 min is a closed session
    })
  }
}
