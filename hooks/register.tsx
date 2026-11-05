// Companion pane: opens with every session, watches the model, the context, the plan, stalled work,
// parallelism and the state of the followed repositories. See README.md.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, BackgroundTask, CacheInfo, CacheVerdict, TaskRow, Usage } from '../types'
import { ContextCard, GoalCard, KeysLine, ModelCard, ParallelCard, PlanCard, ProcessCard, ProjectsCard } from './cards'
import { askHandoff, checkHandoff, continueFromHandoff, guardEdit, initGuards, keepWarmTick, nameSession, noteTurnStart, refreshCollisions, renewSession, setKeepWarm, writeLedger } from './guards'
import { MODEL_OF, advise, cacheState, dayKey, delegationHint, needsColdGuard, normPath, parseStatus, recordSample, route, summarizeParallel, tierOf, touchedRepos, ttlMs, type DailySamples } from './logic'

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

const labelOf = (tool: string, input: Record<string, unknown>): string => {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const raw = s('command') || s('description') || s('pattern') || s('file_path').split(/[\\/]/).pop() || s('url') || ''
  return raw.replace(/\s+/g, ' ').slice(0, 48)
}

let reposAt = 0
/** Context size over which a send on a cold cache asks first (`coldGuardTokens` option; 0 = never). */
let coldGuardTokens = 150_000
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
    const raw = JSON.parse(await $.fs.read(`${dir}/claude-ctx-${await $.session.id()}.json`)).prompt_cache
    const info: CacheInfo | null = raw
      ? { warm: raw.warm === true, caching: raw.caching_observed === true, ttl: raw.ttl, expiresAt: raw.expires_at ?? null, recacheTokensIfCold: raw.recache_tokens_if_cold ?? null, hitRatio: raw.hit_ratio ?? null }
      : null
    await update($, cache, () => info)
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

export const register: Register = (on, options) => {
  projects = String(options.projects ?? '').split(';').map(p => p.trim()).filter(Boolean)
  const guardOption = String(options.coldGuardTokens ?? '').trim()
  if (guardOption !== '' && Number.isFinite(Number(guardOption.replace(/k$/i, '000')))) coldGuardTokens = Number(guardOption.replace(/k$/i, '000'))
  on('session.start', async ($, e, next) => {
    await initGuards($)
    await $.command.register({ name: 'compagnon', description: 'Panneau compagnon (args : keepwarm [heures|off], handoff)', argumentHint: '[keepwarm [h|off] | handoff]' })
    void $.ui.open({ id: PANE, title: 'Compagnon' })
    void refreshRepos($)
    void refreshUsage($)
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
      const need = advise(text)
      if (!need || (await $.store.get('auto')) === false) return
      await refreshCache($)
      const [u, p] = await Promise.all([read($, usage), read($, pin)])
      const current = p?.tier ?? tierOf(u?.model ?? (await $.session.model()))
      const d = route(need, current, await verdictNow($))
      await update($, decision, () => d)
      if (d.action === 'switch') await update($, pin, () => ({ tier: d.tier, effort: d.effort }))
      if (d.action === 'delegate') hint = delegationHint(d, need.need)
    })
    return next(hint ? { ...e, text: text + hint } : e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  // The pin applies to the main loop only: subagents keep the model their definition names.
  on('turn.step', async function* ($, e, next) {
    const p = await read($, pin)
    return yield* next(p && !e.agentId ? { ...e, model: MODEL_OF[p.tier], effort: p.effort } : e)
  })

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
    if ((await $.clock.now()) - reposAt > REPOS_MS) await refreshRepos($)
    return done
  })

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
    const width = Math.min(64, e.props.bodyColumns)
    const ttl = ttlMs(c)
    // The countdown counts a keep-warm ping too: the status line's expiry is stale after one.
    const expiry = Math.max(c?.expiresAt ? c.expiresAt * 1000 : 0, warmUntilOf(kw, c))
    const warmLeft = expiry > 0 ? expiry - now : null
    const isKeepWarm = Boolean(kw && !kw.stopped)
    const { Box } = E
    return (
      <Box flexDirection="column">
        {ModelCard(E, width, u, d, p, c, verdict, kw, warmLeft, ttl, isAuto)}
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
