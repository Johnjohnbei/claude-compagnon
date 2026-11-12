// Companion pane: opens with every session, watches the model, the context, the plan, stalled work
// and the state of the followed repositories. See README.md.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ErrorEntry, RouteRecord, SeenModels } from '../types'
import { askHandoff, guardEdit, initGuards, nameSession, renewSession, setKeepWarm, writeLedger } from './guards'
import { TIER_NAME } from './tiers'
import { routeReport, spawnModel } from './request-routing'
import { chargeReport } from './load-report'
import { errorReport, isOptionOn, normPath, tokensOption, touchedRepos } from './logic'
import { renderBand, renderPane, restorePaneMode } from './pane-view'
import { coldSendGuard, isAliasSupported, routePrompt } from './prompt-routing'
import { forgetEndedAgents, note, pollForever, quietly, recordError, refreshUsage, trackModel, trackTasks } from './session-tracking'
import { followedDirs, refreshRepos, setProjects } from './repo-tracking'
import { registerTurnHooks } from './turn-hooks'

const PANE = 'compagnon'
const pin = atom({ plugin: 'compagnon', key: 'pin' } as const, null, { shape: 'v1' })
const decision = atom({ plugin: 'compagnon', key: 'decision' } as const, null, { shape: 'v1' })
const lastTurnEnd = atom({ plugin: 'compagnon', key: 'lastTurnEnd' } as const, 0, { shape: 'v1' })
const running = atom({ plugin: 'compagnon', key: 'running' } as const, [], { shape: 'v1' })
const waiting = atom({ plugin: 'compagnon', key: 'waiting' } as const, null, { shape: 'v2' })
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
const collisionAsk = atom({ plugin: 'compagnon', key: 'collisionAsk' } as const, {}, { shape: 'v2' })
const agents = atom({ plugin: 'compagnon', key: 'agents' } as const, [], { shape: 'v2' })
const lastTurnReason = atom({ plugin: 'compagnon', key: 'lastTurnReason' } as const, null, { shape: 'v1' })
const isWorking = atom({ plugin: 'compagnon', key: 'isWorking' } as const, false, { shape: 'v1' })
/** When the main turn in flight began, 0 when none: the activity indicator's clock. */
const turnStartedAt = atom({ plugin: 'compagnon', key: 'turnStartedAt' } as const, 0, { shape: 'v1' })

const labelOf = (tool: string, input: Record<string, unknown>): string => {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const raw = s('command') || s('description') || s('pattern') || s('file_path').split(/[\\/]/).pop() || s('url') || ''
  return raw.replace(/\s+/g, ' ').slice(0, 48)
}

/** Context size over which a send on a cold cache asks first (`coldGuardTokens` option; 0 = never). */
let coldGuardTokens = 150_000
/** The band above the prompt: on unless the `showBand` option is switched off. */
let isBandShown = true
/** The companion drawing beside the pane's head: on unless the `showCompanion` option is switched off. */
let isCompanionShown = true
/** `NO_COLOR` set and not empty (no-color.org): the companion is drawn in colour alone, so it is left out. Read at session start. */
let isNoColor = false
/** The classifier layer: on unless the `classify` option is switched off. */
let isClassifierOn = true
const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])

export const register: Register = (on, options) => {
  setProjects(String(options.projects ?? ''))
  isBandShown = isOptionOn(options.showBand)
  isCompanionShown = isOptionOn(options.showCompanion)
  isClassifierOn = isOptionOn(options.classify)
  coldGuardTokens = tokensOption(options.coldGuardTokens) ?? 150_000
  on('session.start', async ($, e, next) => {
    await initGuards($)
    isNoColor = Boolean(await $.env.get('NO_COLOR').catch(() => undefined))
    await $.command.register({ name: 'compagnon', description: 'Compagnon pane (args: keepwarm [hours|off], handoff, decisions, load, errors)', argumentHint: '[keepwarm [h|off] | handoff | decisions | load | errors]' })
    void quietly($, async () => {
      // Opened unasked, the engine seats a pane from 144 columns only (110 once opened by hand) and draws nothing below: say so, never stay invisible.
      const opened = await $.ui.open({ id: PANE, title: 'Compagnon' })
      if (!opened.isPlaced && !opened.reason.startsWith('no-surface')) $.ui.toast('Compagnon pane waiting for a wider terminal (144 columns). Type /compagnon to open it now.')
    })
    void quietly($, () => refreshRepos($))
    void quietly($, () => refreshUsage($))
    void quietly($, () => restorePaneMode($))
    void quietly($, async () => {
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
    if (verb === 'errors') return { text: errorReport(((await $.store.get('errorLog')) ?? []) as ErrorEntry[]) }
    if (verb === 'handoff') {
      $.clock.after(300, () => void quietly($, () => askHandoff($)))
      return { text: 'Handoff requested: the pane then offers to restart from a fresh session (key c).' }
    }
    await $.ui.open({ id: PANE, title: 'Compagnon' })
    return { text: 'Compagnon pane open.' }
  })

  // The goal is measured on the native task list; `/goal clear` (or stop) ends it.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const done = await next(e)
    await quietly($, async () => {
      const args = String(e.args ?? '').trim()
      const startedAt = await $.clock.now()
      if (/^(clear|stop|off|cancel)$/i.test(args)) await update($, goal, () => null)
      else if (args) await update($, goal, () => ({ condition: args, startedAt }))
    })
    return done
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'command.run')
    return next.called ? undefined : next(e)
  }) // own failure: pass the work on, never run it twice

  // /clear and /resume carry on under a new session id: a fresh ledger, task list and keep-warm.
  on('classic.SessionStart', { source: ['clear', 'resume'] }, async ($, e, next) => {
    await quietly($, async () => {
      await renewSession($)
      await forgetEndedAgents($) // the engine may keep listing agents that ended before: they are not this session's failures
      await Promise.all([
        update($, tasks, () => []), update($, goal, () => null), update($, keepWarm, () => null), update($, lastTurnEnd, () => 0),
        update($, handoff, () => null), update($, isWorking, () => false), update($, collisions, () => []), update($, turnStartedAt, () => 0), update($, lastTurnReason, () => null), update($, collisionAsk, () => ({})), update($, agents, () => []), update($, waiting, () => null),
      ])
    })
    return next(e)
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'classic.SessionStart')
    return next.called ? undefined : next(e)
  }) // own failure: pass the work on, never run it twice

  on('session.end', async ($, e, next) => {
    await quietly($, () => writeLedger($, true))
    return next(e)
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'session.end')
    return next.called ? undefined : next(e)
  }) // own failure: pass the work on, never run it twice

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
    await quietly($, async () => {
      await update($, waiting, () => null)
      hint = await routePrompt($, text, isClassifierOn)
    })
    return next(hint ? { ...e, text: text + hint } : e)
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'prompt.submit')
    return next.called ? undefined : next(e)
  }) // own failure: pass the work on, never run it twice

  // The pin applies to the main loop only: subagents keep the model their definition names.
  on('turn.step', async function* ($, e, next) {
    const p = await read($, pin)
    const result = yield* next(p && !e.agentId && (await isAliasSupported($)) ? { ...e, model: p.tier, effort: p.effort } : e)
    await quietly($, () => trackModel($, (result as { usage?: { model?: unknown } } | undefined)?.usage?.model))
    return result
  })

  // The advisor's calls show in the conversation as a server tool use; its advice is encrypted, so only the call is counted.
  on('session.append', async ($, e, next) => {
    const content = (e as unknown as { message?: { content?: unknown } }).message?.content
    if (Array.isArray(content) && content.some((b: { type?: string; name?: string }) => b.type === 'server_tool_use' && b.name === 'advisor'))
      await quietly($, async () => {
        const at = await $.clock.now()
        await update($, advisor, a => ({ calls: a.calls + 1, lastAt: at, pending: a.pending + 1 }))
        await note($, 'advisor', 'consulted')
      })
    return next(e)
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'session.append')
    return next.called ? undefined : next(e)
  }) // own failure: the row is stored as it is

  // The delegation the router asked for (see delegationHint) holds even when Claude leaves the model out of the call.
  on('agent.spawn', async ($, e, next) => {
    const model = spawnModel(await read($, decision), e)
    await quietly($, () => note($, 'spawn', `${e.subagentType}${model ? ` set to ${TIER_NAME[model]}` : e.model ? ` ${e.model}` : ''}`))
    return next(model ? { ...e, model } : e)
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'agent.spawn')
    return next.called ? undefined : next(e)
  }) // own failure: the subagent starts as asked

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? `${e.tool}-${Math.random()}`
    const input = e as unknown as Record<string, unknown>
    // Collision guard (from Collision Guard): another open session edited this file in the last 30 min?
    if (EDITORS.has(e.tool)) {
      let refusal: { deny: string } | null = null
      await quietly($, async () => {
        refusal = await guardEdit($, String(input.file_path ?? input.notebook_path ?? ''))
      })
      if (refusal) return refusal as { deny: string }
    }
    await quietly($, async () => {
      const start = await $.clock.now()
      await update($, waiting, w => (w && w.agentId !== e.agentId ? w : null)) // only this loop's own prompt is answered by its call
      await update($, running, list => [...list, { id, tool: e.tool, label: labelOf(e.tool, e as unknown as Record<string, unknown>), start }])
      const hit = touchedRepos(e as unknown as Record<string, unknown>, followedDirs()).map(normPath)
      if (hit.length > 0) await update($, usedRepos, list => (hit.every(h => list.includes(h)) ? list : [...new Set([...list, ...hit])]))
    })
    try {
      const done = await next(e)
      if (done.result !== undefined) await quietly($, () => trackTasks($, e.tool, input, done.result))
      return done
    } finally {
      await quietly($, () => update($, running, list => list.filter(t => t.id !== id)))
    }
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'tool.call')
    return next.called ? undefined : next(e)
  }) // own failure: pass the work on, never run it twice

  registerTurnHooks(on)

  // The band above the prompt: one line, the figures that say whether to open the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isBandShown) return next(e) // nothing to show: the band is the plugins' beneath, never a null the engine refuses
    return renderBand($, $.ui.resolve(e))
  }).catch(async ($, _e, next) => {
    await recordError($, next.error, 'band')
    return undefined // own failure: no band, never a broken prompt area
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, $.ui.resolve(e), e.props.bodyColumns, isCompanionShown && !isNoColor, () => void refreshRepos($)))
}
