// Companion pane: opens with every session, watches the model, the context, the plan, stalled work,
// parallelism and the state of the followed repositories. See README.md.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, BackgroundTask, CacheInfo, CacheVerdict, LogKind, RouteRecord, SeenModels, TaskRow, Tier, Usage } from '../types'
import { Band, ContextCard, GoalCard, KeysLine, ParallelCard, PlanCard, ProcessCard, ProjectsCard, Schema } from './cards'
import { askHandoff, checkHandoff, continueFromHandoff, guardEdit, initGuards, keepWarmTick, nameSession, noteTurnStart, refreshCollisions, renewSession, setKeepWarm, writeLedger } from './guards'
import { CLASSIFY_LABELS, CLASSIFY_TIMEOUT_MS, SOURCE_NAME, TIER_NAME, advise, cacheFromRelay, cacheState, chargeReport, contextParts, costDelta, dayKey, delegationHint, isOptionOn, modelLabel, needsColdGuard, needsClassifier, normPath, parseStatus, pushLog, pushRoute, recordSample, releaseOf, route, routeRecord, routeReport, settle, spawnModel, summarizeParallel, supportsAlias, tierOf, tierOfLabel, touchedRepos, ttlMs, versionOf, withoutPin, type DailySamples } from './logic'

const PANE = 'compagnon'
const pin = atom({ plugin: 'compagnon', key: 'pin' } as const, null, { shape: 'v1' })
const decision = atom({ plugin: 'compagnon', key: 'decision' } as const, null, { shape: 'v1' })
const cache = atom({ plugin: 'compagnon', key: 'cache' } as const, null, { shape: 'v1' })
const lastTurnEnd = atom({ plugin: 'compagnon', key: 'lastTurnEnd' } as const, 0, { shape: 'v1' })
const running = atom({ plugin: 'compagnon', key: 'running' } as const, [], { shape: 'v1' })
const spans = atom({ plugin: 'compagnon', key: 'spans' } as const, [], { shape: 'v1' })
const parallel = atom({ plugin: 'compagnon', key: 'parallel' } as const, null, { shape: 'v1' })
const background = atom({ plugin: 'compagnon', key: 'background' } as const, [], { shape: 'v1' })
const agents = atom({ plugin: 'compagnon', key: 'agents' } as const, [], { shape: 'v1' })
const waiting = atom({ plugin: 'compagnon', key: 'waiting' } as const, null, { shape: 'v1' })
const usage = atom({ plugin: 'compagnon', key: 'usage' } as const, null, { shape: 'v1' })
const repos = atom({ plugin: 'compagnon', key: 'repos' } as const, [], { shape: 'v1' })
const usedRepos = atom({ plugin: 'compagnon', key: 'usedRepos' } as const, [], { shape: 'v1' })
const isProjectsOpen = atom({ plugin: 'compagnon', key: 'isProjectsOpen' } as const, false, { shape: 'v1' })
const tick = atom({ plugin: 'compagnon', key: 'tick' } as const, 0, { shape: 'v1' })
const journal = atom({ plugin: 'compagnon', key: 'journal' } as const, [], { shape: 'v1' })
const costs = atom({ plugin: 'compagnon', key: 'costs' } as const, [], { shape: 'v1' })
const costMark = atom({ plugin: 'compagnon', key: 'costMark' } as const, 0, { shape: 'v1' })
const advisor = atom({ plugin: 'compagnon', key: 'advisor' } as const, { calls: 0, lastAt: 0, pending: 0 }, { shape: 'v1' })
const ctxParts = atom({ plugin: 'compagnon', key: 'ctxParts' } as const, [], { shape: 'v1' })
const seen = atom({ plugin: 'compagnon', key: 'seen' } as const, {}, { shape: 'v1' })
// The guards' state, owned by guards.ts: declared again here because the state scan reads each module alone.
const keepWarm = atom({ plugin: 'compagnon', key: 'keepWarm' } as const, null, { shape: 'v1' })
const collisions = atom({ plugin: 'compagnon', key: 'collisions' } as const, [], { shape: 'v1' })
const handoff = atom({ plugin: 'compagnon', key: 'handoff' } as const, null, { shape: 'v1' })
const tasks = atom({ plugin: 'compagnon', key: 'tasks' } as const, [], { shape: 'v1' })
const goal = atom({ plugin: 'compagnon', key: 'goal' } as const, null, { shape: 'v1' })
const isWorking = atom({ plugin: 'compagnon', key: 'isWorking' } as const, false, { shape: 'v1' })

const TICK_MS = 15_000
const REPOS_MS = 60_000

type $ = EngineInterface

let aliasSupport: Promise<boolean> | null = null
/** Asked once: the engine version does not change during a session. A failed read counts as no support, said once. */
const isAliasSupported = ($: $) =>
  (aliasSupport ??= $.session.version().then(supportsAlias, () => false).then(async ok => {
    if (!ok) await quietly(() => $.ui.toast('compagnon : bascule de modèle coupée (Claude Code 2.1.309 minimum, ou version illisible).'))
    return ok
  }))

const labelOf = (tool: string, input: Record<string, unknown>): string => {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const raw = s('command') || s('description') || s('pattern') || s('file_path').split(/[\\/]/).pop() || s('url') || ''
  return raw.replace(/\s+/g, ' ').slice(0, 48)
}

let reposAt = 0
/** Context size over which a send on a cold cache asks first (`coldGuardTokens` option; 0 = never). */
let coldGuardTokens = 150_000
/** The band above the prompt: on unless the `showBand` option is switched off. */
let isBandShown = true
/** The classifier layer: on unless the `classify` option is switched off. */
let isClassifierOn = true
const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])

/** The panel's bookkeeping never fails a prompt or a tool call: a broken update is dropped, the work goes on. */
const quietly = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
  } catch {
    // ponytail: silent on purpose; a stale card beats a blocked session
  }
}
/** Repositories the Projets card follows: the `projects` option, or the session's own project. */
let projects: string[] = []
/** The directories the card follows, once read: what a tool call is matched against. */
let followed: string[] = []

async function refreshUsage($: $) {
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
async function refreshCache($: $) {
  try {
    const dir = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
    const relayed = JSON.parse(await $.fs.read(`${dir}/claude-ctx-${await $.session.id()}.json`)).prompt_cache
    await update($, cache, () => cacheFromRelay(relayed))
  } catch {
    await update($, cache, () => null) // no relay yet: cacheState falls back to the 1 h TTL rule
  }
}

/** Until when a keep-warm ping holds the cache warm: 0 without a successful ping (the status line goes stale after one). */
const warmUntilOf = (kw: { lastPingAt: number } | null, c: CacheInfo | null) => (kw?.lastPingAt ? kw.lastPingAt + ttlMs(c) : 0)

/** The cache verdict now, keep-warm pings included. */
async function verdictNow($: $): Promise<CacheVerdict> {
  const [u, c, last, kw, now] = await Promise.all([read($, usage), read($, cache), read($, lastTurnEnd), read($, keepWarm), $.clock.now()])
  return cacheState(c, now, last, u?.contextTokens ?? 0, warmUntilOf(kw, c))
}

/** The session's task list, kept from the main loop's and subagents' task tools (they write the same list). */
async function trackTasks($: $, tool: string, input: Record<string, unknown>, result: unknown) {
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

async function stopTask($: $, id: string) {
  await $.tool.call({ tool: 'TaskStop', task_id: id })
  await update($, background, list => list.filter(t => t.id !== id))
}

async function refreshAgents($: $) {
  const now = await $.clock.now()
  const list = await $.agent.list()
  await update($, agents, (was: AgentRow[]) =>
    list.map((a: { id: string; description: string; type: string; status: string }) => ({
      id: a.id,
      label: a.description,
      type: a.type,
      status: a.status,
      firstSeen: was.find(w => w.id === a.id)?.firstSeen ?? now,
      // The moment it was first seen finished: the card shows how long it ran.
      endedAt: ['completed', 'failed', 'killed'].includes(a.status) ? (was.find(w => w.id === a.id)?.endedAt ?? now) : undefined,
    })),
  )
}

async function refreshRepos($: $) {
  reposAt = await $.clock.now()
  const root = await $.session.root()
  const dirs = projects.length > 0 ? projects : [root]
  followed = dirs
  // The session's own project counts as used from the start.
  await update($, usedRepos, list => [...new Set([...list, ...dirs.filter(d => normPath(d) === normPath(root)).map(normPath)])])
  const rows = await Promise.all(
    dirs.map(async dir => {
      const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir
      const status = await $.process.run(['git', '-C', dir, 'status', '--porcelain=v2', '--branch'])
      if (status.exitCode !== 0) return null
      const log = await $.process.run(['git', '-C', dir, 'log', '-1', '--format=%cr · %s'])
      return { ...parseStatus(name, status.stdout), dir: normPath(dir), lastCommit: log.stdout.trim() || undefined }
    }),
  )
  await update($, repos, () => rows.filter(r => r !== null))
}

/**
 * The classifier layer: one Haiku call that picks the tier a request needs. Gives up after CLASSIFY_TIMEOUT_MS (or on any
 * failure, or when no label is named) so a slow or failing call never holds the prompt: the caller keeps the default.
 */
async function classifyTier($: $, text: string): Promise<Tier | undefined> {
  const answer = await Promise.race([
    $.model.classify(text, Object.values(CLASSIFY_LABELS), { model: 'haiku' }),
    $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(() => undefined),
  ]).catch(() => undefined)
  return typeof answer === 'string' ? tierOfLabel(answer) : undefined
}

/** One line of the session journal. */
async function note($: $, kind: LogKind, text: string) {
  const at = await $.clock.now()
  await update($, journal, list => pushLog(list, { at, kind, text }))
}

/** The ids the engine reported, kept across sessions: an id that changes for a tier is a release, said once. */
let seenNow: SeenModels | null = null
async function trackModel($: $, model: unknown) {
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
  await $.ui.toast(`compagnon : nouvelle version, ${change}`)
}

/** At a main-loop turn's end: what the turn cost (the cost figure's move), and what the context holds. */
async function recordTurn($: $) {
  const [u, mark, adv, p] = await Promise.all([read($, usage), read($, costMark), read($, advisor), read($, pin)])
  if (!u) return
  const at = await $.clock.now()
  const usdMoved = costDelta(mark, u.costUsd)
  await update($, costMark, () => u.costUsd)
  if (usdMoved > 0 || adv.pending > 0) await update($, costs, list => [...list, { at, usd: usdMoved, tier: p?.tier ?? tierOf(u.model), advisorCalls: adv.pending }].slice(-200))
  await update($, advisor, a => ({ ...a, pending: 0 }))
  // `full` counts each file on its own; `summary` spreads the remainder over « System tools » and understates the memory (measured: 27 k against 36 k).
  const full = (await $.session.usage({ breakdown: 'full' })) as { context?: { breakdown?: { categories?: Array<{ name: string; tokens: number; kind?: string }> } } }
  await update($, ctxParts, () => contextParts(full.context?.breakdown?.categories ?? []))
}

export const register: Register = (on, options) => {
  projects = String(options.projects ?? '').split(';').map(p => p.trim()).filter(Boolean)
  isBandShown = isOptionOn(options.showBand)
  isClassifierOn = isOptionOn(options.classify)
  const guardOption = String(options.coldGuardTokens ?? '').trim()
  if (guardOption !== '' && Number.isFinite(Number(guardOption.replace(/k$/i, '000')))) coldGuardTokens = Number(guardOption.replace(/k$/i, '000'))
  on('session.start', async ($, e, next) => {
    await initGuards($)
    await $.command.register({ name: 'compagnon', description: 'Panneau compagnon (args : keepwarm [heures|off], handoff, decisions, charge)', argumentHint: '[keepwarm [h|off] | handoff | decisions | charge]' })
    void $.ui.open({ id: PANE, title: 'Compagnon' })
    void refreshRepos($)
    void refreshUsage($)
    void quietly(async () => {
      const known = ((await $.store.get('seenModels')) ?? {}) as SeenModels
      await update($, seen, () => known)
    })
    // ponytail: one 15 s poll for ages, agents and usage (all free calls); a reload drops it and starts another.
    void (async () => {
      for (;;) {
        await $.clock.sleep(TICK_MS)
        await update($, tick, (n: number) => n + 1)
        const n = await read($, tick)
        await Promise.all([refreshAgents($), refreshUsage($), refreshCache($), refreshCollisions($)])
        // Not awaited: a slow ping must not hold the refreshes and the ledger's heartbeat (keepWarmTick skips a second ping).
        void quietly(async () => keepWarmTick($, await read($, lastTurnEnd), ttlMs(await read($, cache))))
        if (n % 4 === 0) await writeLedger($) // the ledger's heartbeat: a ledger quiet for 15 min is a closed session
      }
    })()
    return next(e)
  })

  on('command.run', { command: 'compagnon' }, async ($, e) => {
    const [verb, arg] = String(e.args ?? '').trim().toLowerCase().split(/\s+/)
    if (verb === 'keepwarm') {
      const hours = arg === 'off' ? null : Number(arg) > 0 ? Number(arg) : 2
      await setKeepWarm($, hours)
      return { text: hours ? `Cache maintenu au chaud ${hours} h : un ping avant chaque expiration, arrêt s’il réécrit au lieu de lire.` : 'Maintien du cache coupé.' }
    }
    if (verb === 'charge') {
      const full = (await $.session.usage({ breakdown: 'full' })) as { context?: { breakdown?: unknown } }
      return { text: chargeReport(full.context?.breakdown) }
    }
    if (verb === 'decisions') return { text: routeReport(((await $.store.get('routeLog')) ?? []) as RouteRecord[]) }
    if (verb === 'handoff') {
      $.clock.after(300, () => void quietly(() => askHandoff($)))
      return { text: 'Handoff demandé : le panneau propose ensuite de repartir d’une session neuve (touche c).' }
    }
    await $.ui.open({ id: PANE, title: 'Compagnon' })
    return { text: 'Panneau compagnon ouvert.' }
  })

  // The goal is measured on the native task list; `/goal clear` (or stop) ends it.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const done = await next(e)
    await quietly(async () => {
      const args = String(e.args ?? '').trim()
      const startedAt = await $.clock.now()
      if (/^(clear|stop|off|cancel)$/i.test(args)) await update($, goal, () => null)
      else if (args) await update($, goal, () => ({ condition: args, startedAt }))
    })
    return done
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  // /clear and /resume carry on under a new session id: a fresh ledger, task list and keep-warm.
  on('classic.SessionStart', { source: ['clear', 'resume'] }, async ($, e, next) => {
    await quietly(async () => {
      await renewSession($)
      await Promise.all([
        update($, tasks, () => []), update($, goal, () => null), update($, keepWarm, () => null), update($, lastTurnEnd, () => 0),
        update($, handoff, () => null), update($, isWorking, () => false), update($, collisions, () => []),
      ])
    })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  on('session.end', async ($, e, next) => {
    await quietly(() => writeLedger($, true))
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  // Automatic routing (user directive 2026-11-05): switch the main loop only when no warm cache is lost,
  // otherwise keep it and steer the work to a subagent on the right model.
  on('prompt.submit', async ($, e, next) => {
    let hint = ''
    const text = e.text ?? ''
    const fromUser = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge'
    if (fromUser) nameSession(text)
    // Cold-send guard (from Cache Keeper): a cold cache over the threshold asks before rewriting it all.
    if (fromUser && !e.turnId && !text.trim().startsWith('/')) {
      let verdict: CacheVerdict | null = null
      await quietly(async () => {
        await refreshCache($)
        verdict = await verdictNow($)
      })
      const v = verdict as CacheVerdict | null
      if (v && needsColdGuard(v, coldGuardTokens)) {
        const answer = await $.ui
          .ask(`Cache froid : envoyer maintenant relit ${Math.round(v.recache / 1000)} k tokens de contexte. Que faire ?`, {
            header: 'Cache froid',
            options: ['Envoyer', 'Compacter puis envoyer', 'Handoff puis session neuve', 'Annuler'],
          })
          .catch(() => 'Envoyer') // nobody to ask (a -p run) or dismissed: send as typed
        if (answer === 'Compacter puis envoyer') {
          const isCompacted = await $.session.compact().then(() => true, () => false)
          if (!isCompacted) await $.ui.toast('Compaction refusée par le moteur : message envoyé tel quel.')
        }
        if (answer === 'Handoff puis session neuve') {
          $.clock.after(300, () => void quietly(() => askHandoff($, text)))
          return { drop: 'Retenu par compagnon : handoff puis session neuve, le message sera renvoyé après.' }
        }
        if (answer === 'Annuler') return { drop: 'Annulé par compagnon avant de relire un cache froid.' }
      }
    }
    await quietly(async () => {
      await update($, waiting, () => null)
      await update($, spans, () => [])
      const keyword = advise(text)
      if (!keyword || (await $.store.get('auto')) === false) return
      // What no keyword rule recognised, or only the weak edit rule did, goes to the model classifier (which may raise the weak
      // rule, never lower it); a timeout or a failure keeps the keyword answer.
      const tier = isClassifierOn && needsClassifier(keyword) ? await classifyTier($, text) : undefined
      const need = settle(keyword, tier)
      await refreshCache($)
      const [u, p] = await Promise.all([read($, usage), read($, pin)])
      const current = p?.tier ?? tierOf(u?.model ?? (await $.session.model()))
      const routed = route(need, current, await verdictNow($))
      const d = (await isAliasSupported($)) ? routed : withoutPin(routed, current)
      await update($, decision, () => d)
      await note($, 'route', `${SOURCE_NAME[need.source]} : ${d.why}`)
      const kept = ((await $.store.get('routeLog')) ?? []) as RouteRecord[]
      await $.store.set('routeLog', pushRoute(kept, routeRecord(await $.clock.now(), text, need, d.action)))
      if (d.action === 'switch') await update($, pin, () => ({ tier: d.tier, effort: d.effort }))
      if (d.action === 'delegate') hint = delegationHint(d, need.need)
    })
    return next(hint ? { ...e, text: text + hint } : e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  // The pin applies to the main loop only: subagents keep the model their definition names.
  on('turn.step', async function* ($, e, next) {
    const p = await read($, pin)
    const result = yield* next(p && !e.agentId && (await isAliasSupported($)) ? { ...e, model: p.tier, effort: p.effort } : e)
    await quietly(() => trackModel($, (result as { usage?: { model?: unknown } } | undefined)?.usage?.model))
    return result
  })

  // The advisor's calls show in the conversation as a server tool use; its advice is encrypted, so only the call is counted.
  on('session.append', async ($, e, next) => {
    const content = (e as unknown as { message?: { content?: unknown } }).message?.content
    if (Array.isArray(content) && content.some((b: { type?: string; name?: string }) => b.type === 'server_tool_use' && b.name === 'advisor'))
      await quietly(async () => {
        const at = await $.clock.now()
        await update($, advisor, a => ({ calls: a.calls + 1, lastAt: at, pending: a.pending + 1 }))
        await note($, 'advisor', 'consulté')
      })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: the row is stored as it is

  // The delegation the router asked for (see delegationHint) holds even when Claude leaves the model out of the call.
  on('agent.spawn', async ($, e, next) => {
    const model = spawnModel(await read($, decision), e)
    await quietly(() => note($, 'spawn', `${e.subagentType}${model ? ` imposé ${TIER_NAME[model]}` : e.model ? ` ${e.model}` : ''}`))
    return next(model ? { ...e, model } : e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: the subagent starts as asked

  on('tool.call', async ($, e, next) => {
    let start = 0
    const id = e.tool_use_id ?? `${e.tool}-${Math.random()}`
    const input = e as unknown as Record<string, unknown>
    // Collision guard (from Collision Guard): another open session edited this file in the last 30 min?
    if (EDITORS.has(e.tool)) {
      let refusal: { deny: string } | null = null
      await quietly(async () => {
        refusal = await guardEdit($, String(input.file_path ?? input.notebook_path ?? ''))
      })
      if (refusal) return refusal as { deny: string }
    }
    await quietly(async () => {
      start = await $.clock.now()
      await update($, waiting, () => null)
      await update($, running, list => [...list, { id, tool: e.tool, label: labelOf(e.tool, e as unknown as Record<string, unknown>), start }])
      const hit = touchedRepos(e as unknown as Record<string, unknown>, followed).map(normPath)
      if (hit.length > 0) await update($, usedRepos, list => (hit.every(h => list.includes(h)) ? list : [...new Set([...list, ...hit])]))
    })
    try {
      const done = await next(e)
      if (done.result !== undefined) await quietly(() => trackTasks($, e.tool, input, done.result))
      return done
    } finally {
      await quietly(async () => {
        const end = await $.clock.now()
        await update($, running, list => list.filter(t => t.id !== id))
        // Only the main loop's calls measure its parallelism: a subagent's own reads are its business.
        if (!e.agentId && start > 0) await update($, spans, list => [...list, { tool: e.tool, start, end }].slice(-300))
      })
    }
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'idle_prompt') {
      await quietly(async () => {
        const at = await $.clock.now()
        await update($, waiting, () => ({ kind: e.notification_type, message: e.message.slice(0, 80), at }))
      })
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  // Stop carries the background work still in flight: the only list of shells and monitors a mod can read.
  on('classic.Stop', async ($, e, next) => {
    await quietly(async () => {
      const now = await $.clock.now()
      const inFlight = e.background_tasks ?? []
      await update($, background, (was: BackgroundTask[]) =>
        inFlight.map(t => ({
          id: t.id,
          type: t.type,
          label: (t.command ?? t.description).replace(/\s+/g, ' ').slice(0, 60),
          firstSeen: was.find(w => w.id === t.id)?.firstSeen ?? now,
        })),
      )
    })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  on('turn.start', async ($, e, next) => {
    if (!e.agentId)
      await quietly(async () => {
        await update($, isWorking, () => true)
        await noteTurnStart($)
      })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A subagent's end changes the Process card only.
    if (e.agentId) {
      await quietly(() => refreshAgents($))
      return done
    }
    await quietly(async () => {
      await update($, isWorking, () => false)
      await checkHandoff($)
    })
    const ended = await $.clock.now()
    await update($, lastTurnEnd, () => ended)
    const list = await read($, spans)
    await update($, parallel, () => summarizeParallel(list))
    await Promise.all([refreshUsage($), refreshAgents($), refreshCache($)])
    await quietly(() => recordTurn($))
    if ((await $.clock.now()) - reposAt > REPOS_MS) await refreshRepos($)
    return done
  })

  // The band above the prompt: one line, the figures that say whether to open the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    if (!isBandShown) return null
    const E = $.ui.resolve(e)
    await read($, tick)
    const [u, p, adv, turnCosts, ag] = await Promise.all([read($, usage), read($, pin), read($, advisor), read($, costs), read($, agents)])
    const label = p ? TIER_NAME[p.tier] : u ? modelLabel(u.model) : 'compagnon'
    const total = turnCosts.reduce((s: number, t: { usd: number }) => s + t.usd, 0)
    const live = ag.filter((a: AgentRow) => a.status !== 'completed' && a.status !== 'killed').length
    return Band(E, label, adv, total, u ? u.contextPct : null, live)
  }).catch(() => undefined) // own failure: no band, never a broken prompt area

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e)
    await read($, tick)
    const now = await $.clock.now()
    const [u, d, p, c, run, bg, ag, w, par, rp] = await Promise.all([
      read($, usage), read($, decision), read($, pin), read($, cache), read($, running), read($, background),
      read($, agents), read($, waiting), read($, parallel), read($, repos),
    ])
    const isAuto = (await $.store.get('auto')) !== false
    const samples = ((await $.store.get('weekPeaks')) ?? {}) as DailySamples
    const [used, isOpen, kw, clash] = await Promise.all([read($, usedRepos), read($, isProjectsOpen), read($, keepWarm), read($, collisions)])
    const [ho, g, taskList, verdict] = await Promise.all([read($, handoff), read($, goal), read($, tasks), verdictNow($)])
    const [log, turnCosts, adv, parts, seenIds] = await Promise.all([read($, journal), read($, costs), read($, advisor), read($, ctxParts), read($, seen)])
    const routes = ((await $.store.get('routeLog')) ?? []) as RouteRecord[]
    const width = Math.min(64, e.props.bodyColumns)
    const ttl = ttlMs(c)
    // The countdown counts a keep-warm ping too: the status line's expiry is stale after one.
    const expiry = Math.max(c?.expiresAt ? c.expiresAt * 1000 : 0, warmUntilOf(kw, c))
    const warmLeft = expiry > 0 ? expiry - now : null
    const isKeepWarm = Boolean(kw && !kw.stopped)
    const { Box } = E
    return (
      <Box flexDirection="column">
        {Schema(E, { width: e.props.bodyColumns, usage: u, decision: d, pin: p, cache: c, verdict, keepWarm: kw, warmLeft, ttl, isAuto, advisor: adv, turns: turnCosts, seen: seenIds, parts, routes, agents: ag, journal: log, now })}
        {ContextCard(E, width, u, ho)}
        {PlanCard(E, width, u, samples, now)}
        {GoalCard(E, width, g, taskList, now)}
        {ProcessCard(E, width, now, run, bg, ag, w, id => void stopTask($, id), id => $.ui.view({ agentId: id }))}
        {ParallelCard(E, width, par)}
        {ProjectsCard(E, width, rp, used, clash, now, isOpen)}
        {KeysLine(E, { isAuto, isKeepWarm, ho, hasIdle: rp.some(r => !used.includes(r.dir)), isOpen }, {
          auto: async () => {
            await $.store.set('auto', !isAuto)
            if (isAuto) await update($, pin, () => null) // off = back to the session's own model
            await update($, tick, n => n + 1)
          },
          keepWarm: () => void setKeepWarm($, isKeepWarm ? null : 2),
          handoff: () => void quietly(() => askHandoff($)),
          resume: () => void quietly(() => continueFromHandoff($)),
          refresh: () => void refreshRepos($),
          fold: () => void update($, isProjectsOpen, v => !v),
        })}
      </Box>
    )
  })
}
