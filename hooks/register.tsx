// Companion pane: opens with every session, watches the model, the context, the plan, stalled work,
// parallelism and the state of the followed repositories. See README.md.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BackgroundTask, RouteRecord, SeenModels } from '../types'
import { askHandoff, checkHandoff, guardEdit, initGuards, nameSession, noteTurnStart, renewSession, setKeepWarm, writeLedger } from './guards'
import { TIER_NAME } from './tiers'
import { routeReport, spawnModel } from './request-routing'
import { chargeReport } from './load-report'
import { isOptionOn, normPath, parseStatus, summarizeParallel, tokensOption, touchedRepos } from './logic'
import { renderBand, renderPane } from './pane-view'
import { coldSendGuard, isAliasSupported, routePrompt } from './prompt-routing'
import { note, pollForever, quietly, recordTurn, refreshAgents, refreshCache, refreshUsage, trackModel, trackTasks } from './session-tracking'

const PANE = 'compagnon'
const pin = atom({ plugin: 'compagnon', key: 'pin' } as const, null, { shape: 'v1' })
const decision = atom({ plugin: 'compagnon', key: 'decision' } as const, null, { shape: 'v1' })
const lastTurnEnd = atom({ plugin: 'compagnon', key: 'lastTurnEnd' } as const, 0, { shape: 'v1' })
const running = atom({ plugin: 'compagnon', key: 'running' } as const, [], { shape: 'v1' })
const spans = atom({ plugin: 'compagnon', key: 'spans' } as const, [], { shape: 'v1' })
const parallel = atom({ plugin: 'compagnon', key: 'parallel' } as const, null, { shape: 'v1' })
const background = atom({ plugin: 'compagnon', key: 'background' } as const, [], { shape: 'v1' })
const waiting = atom({ plugin: 'compagnon', key: 'waiting' } as const, null, { shape: 'v1' })
const repos = atom({ plugin: 'compagnon', key: 'repos' } as const, [], { shape: 'v1' })
const usedRepos = atom({ plugin: 'compagnon', key: 'usedRepos' } as const, [], { shape: 'v1' })
const advisor = atom({ plugin: 'compagnon', key: 'advisor' } as const, { calls: 0, lastAt: 0, pending: 0 }, { shape: 'v1' })
const seen = atom({ plugin: 'compagnon', key: 'seen' } as const, {}, { shape: 'v1' })
const tasks = atom({ plugin: 'compagnon', key: 'tasks' } as const, [], { shape: 'v1' })
const goal = atom({ plugin: 'compagnon', key: 'goal' } as const, null, { shape: 'v1' })
// The guards' state, owned by guards.ts: declared again here because the state scan reads each module alone (as in
// session-tracking.ts, prompt-routing.ts and pane-view.tsx).
const keepWarm = atom({ plugin: 'compagnon', key: 'keepWarm' } as const, null, { shape: 'v1' })
const collisions = atom({ plugin: 'compagnon', key: 'collisions' } as const, [], { shape: 'v1' })
const handoff = atom({ plugin: 'compagnon', key: 'handoff' } as const, null, { shape: 'v1' })
const isWorking = atom({ plugin: 'compagnon', key: 'isWorking' } as const, false, { shape: 'v1' })

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
/** The band above the prompt: on unless the `showBand` option is switched off. */
let isBandShown = true
/** The classifier layer: on unless the `classify` option is switched off. */
let isClassifierOn = true
const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])

/** Repositories the Projects card follows: the `projects` option, or the session's own project. */
let projects: string[] = []
/** The directories the card follows, once read: what a tool call is matched against. */
let followed: string[] = []

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
  isBandShown = isOptionOn(options.showBand)
  isClassifierOn = isOptionOn(options.classify)
  coldGuardTokens = tokensOption(options.coldGuardTokens) ?? 150_000
  on('session.start', async ($, e, next) => {
    await initGuards($)
    await $.command.register({ name: 'compagnon', description: 'Compagnon pane (args: keepwarm [hours|off], handoff, decisions, load)', argumentHint: '[keepwarm [h|off] | handoff | decisions | load]' })
    void $.ui.open({ id: PANE, title: 'Compagnon' })
    void quietly(() => refreshRepos($))
    void quietly(() => refreshUsage($))
    void quietly(async () => {
      const known = ((await $.store.get('seenModels')) ?? {}) as SeenModels
      await update($, seen, () => known)
    })
    void pollForever($)
    return next(e)
  })

  on('command.run', { command: 'compagnon' }, async ($, e) => {
    const [verb, arg] = String(e.args ?? '').trim().toLowerCase().split(/\s+/)
    if (verb === 'keepwarm') {
      const hours = arg === 'off' ? null : Number(arg) > 0 ? Number(arg) : 2
      await setKeepWarm($, hours)
      return { text: hours ? `Cache kept warm for ${hours} h: one ping before each expiry, stopped if a ping rewrites the cache instead of reading it.` : 'Cache keep-warm off.' }
    }
    // `charge`: the verb's former (French) name, still read so a habit keeps working.
    if (verb === 'load' || verb === 'charge') {
      const full = (await $.session.usage({ breakdown: 'full' })) as { context?: { breakdown?: unknown } }
      return { text: chargeReport(full.context?.breakdown) }
    }
    if (verb === 'decisions') return { text: routeReport(((await $.store.get('routeLog')) ?? []) as RouteRecord[]) }
    if (verb === 'handoff') {
      $.clock.after(300, () => void quietly(() => askHandoff($)))
      return { text: 'Handoff requested: the pane then offers to restart from a fresh session (key c).' }
    }
    await $.ui.open({ id: PANE, title: 'Compagnon' })
    return { text: 'Compagnon pane open.' }
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
      const drop = await coldSendGuard($, text, coldGuardTokens)
      if (drop) return { drop }
    }
    await quietly(async () => {
      await update($, waiting, () => null)
      await update($, spans, () => [])
      hint = await routePrompt($, text, isClassifierOn)
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
        await note($, 'advisor', 'consulted')
      })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // own failure: the row is stored as it is

  // The delegation the router asked for (see delegationHint) holds even when Claude leaves the model out of the call.
  on('agent.spawn', async ($, e, next) => {
    const model = spawnModel(await read($, decision), e)
    await quietly(() => note($, 'spawn', `${e.subagentType}${model ? ` set to ${TIER_NAME[model]}` : e.model ? ` ${e.model}` : ''}`))
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
    // After `next`: a failure here must not lose the turn's result (it used to throw past it).
    await quietly(async () => {
      const ended = await $.clock.now()
      await update($, lastTurnEnd, () => ended)
      const list = await read($, spans)
      await update($, parallel, () => summarizeParallel(list))
      await Promise.allSettled([refreshUsage($), refreshAgents($), refreshCache($)])
    })
    await quietly(() => recordTurn($))
    await quietly(async () => {
      if ((await $.clock.now()) - reposAt > REPOS_MS) await refreshRepos($)
    })
    return done
  })

  // The band above the prompt: one line, the figures that say whether to open the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isBandShown) return next(e) // nothing to show: the band is the plugins' beneath, never a null the engine refuses
    return renderBand($, $.ui.resolve(e))
  }).catch(() => undefined) // own failure: no band, never a broken prompt area

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, $.ui.resolve(e), e.props.bodyColumns, () => void refreshRepos($)))
}
