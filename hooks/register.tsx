// Companion pane: opens with every session, watches the model, the context, the plan, stalled work,
// parallelism and the state of the followed repositories. See README.md.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, BackgroundTask, CacheInfo, Usage } from '../types'
import { ContextCard, ModelCard, ParallelCard, PlanCard, ProcessCard, ProjectsCard } from './cards'
import { MODEL_OF, advise, cacheState, dayKey, delegationHint, normPath, parseStatus, recordSample, route, summarizeParallel, tierOf, touchedRepos, type DailySamples } from './logic'

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

const TICK_MS = 15_000
const REPOS_MS = 60_000

type $ = EngineInterface

const labelOf = (tool: string, input: Record<string, unknown>): string => {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const raw = s('command') || s('description') || s('pattern') || s('file_path').split(/[\\/]/).pop() || s('url') || ''
  return raw.replace(/\s+/g, ' ').slice(0, 48)
}

let reposAt = 0

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
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'compagnon', description: 'Rouvrir le panneau compagnon' })
    void $.ui.open({ id: PANE, title: 'Compagnon' })
    void refreshRepos($)
    void refreshUsage($)
    // ponytail: one 15 s poll for ages, agents and usage (all free calls); a reload drops it and starts another.
    void (async () => {
      for (;;) {
        await $.clock.sleep(TICK_MS)
        await update($, tick, (n: number) => n + 1)
        await Promise.all([refreshAgents($), refreshUsage($), refreshCache($)])
      }
    })()
    return next(e)
  })

  on('command.run', { command: 'compagnon' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Compagnon' })
    return { text: 'Panneau compagnon ouvert.' }
  })

  // Automatic routing (user directive 2026-11-05): switch the main loop only when no warm cache is lost,
  // otherwise keep it and steer the work to a subagent on the right model.
  on('prompt.submit', async ($, e, next) => {
    let hint = ''
    await quietly(async () => {
      await update($, waiting, () => null)
      await update($, spans, () => [])
      const need = advise(e.text ?? '')
      if (!need || (await $.store.get('auto')) === false) return
      await refreshCache($)
      const [u, p, c, last, now] = await Promise.all([read($, usage), read($, pin), read($, cache), read($, lastTurnEnd), $.clock.now()])
      const current = p?.tier ?? tierOf(u?.model ?? (await $.session.model()))
      const d = route(need, current, cacheState(c, now, last, u?.contextTokens ?? 0))
      await update($, decision, () => d)
      if (d.action === 'switch') await update($, pin, () => ({ tier: d.tier, effort: d.effort }))
      if (d.action === 'delegate') hint = delegationHint(d, need.need)
    })
    return next(hint ? { ...e, text: (e.text ?? '') + hint } : e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: pass the work on, never run it twice

  // The pin applies to the main loop only: subagents keep the model their definition names.
  on('turn.step', async function* ($, e, next) {
    const p = await read($, pin)
    return yield* next(p && !e.agentId ? { ...e, model: MODEL_OF[p.tier], effort: p.effort } : e)
  })

  on('tool.call', async ($, e, next) => {
    let start = 0
    const id = e.tool_use_id ?? `${e.tool}-${Math.random()}`
    await quietly(async () => {
      start = await $.clock.now()
      await update($, waiting, () => null)
      await update($, running, list => [...list, { id, tool: e.tool, label: labelOf(e.tool, e as unknown as Record<string, unknown>), start }])
      const hit = touchedRepos(e as unknown as Record<string, unknown>, followed).map(normPath)
      if (hit.length > 0) await update($, usedRepos, list => (hit.every(h => list.includes(h)) ? list : [...new Set([...list, ...hit])]))
    })
    try {
      return await next(e)
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

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
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
    const [used, isOpen] = await Promise.all([read($, usedRepos), read($, isProjectsOpen)])
    const { Box } = E
    return (
      <Box flexDirection="column">
        {ModelCard(E, u, d, p, c, now, isAuto, async () => {
          await $.store.set('auto', !isAuto)
          if (isAuto) await update($, pin, () => null) // off = back to the session's own model
          await update($, tick, n => n + 1)
        })}
        {ContextCard(E, u)}
        {PlanCard(E, u, samples, now)}
        {ProcessCard(E, now, run, bg, ag, w,
          async id => {
            await $.tool.call({ tool: 'TaskStop', task_id: id })
            await update($, background, list => list.filter(t => t.id !== id))
          },
          id => $.ui.view({ agentId: id }))}
        {ParallelCard(E, par)}
        {ProjectsCard(E, rp, used, isOpen, () => update($, isProjectsOpen, v => !v), () => refreshRepos($))}
      </Box>
    )
  })
}
