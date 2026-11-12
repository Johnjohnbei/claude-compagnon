// The pane and the band above the prompt, extracted from register.tsx (over its size): read the state, lay out the cards.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { RouteRecord } from '../types'
import type { El } from './card-frame'
import { Band, ContextCard, ErrorsCard, KeysLine, PlanCard, ProcessCard, ProjectsCard } from './cards'
import { Schema } from './chain-schema'
import { askHandoff, continueFromHandoff, setKeepWarm } from './guards'
import { TIER_NAME, modelLabel } from './tiers'
import { activeAgents, activityOf, ttlMs, type DailySamples } from './logic'
import { errorsNow, quietly, stopTask, verdictNow, warmUntilOf } from './session-tracking'

// Declared again in each module that touches them: the state scan reads each module alone.
const pin = atom({ plugin: 'compagnon', key: 'pin' } as const, null, { shape: 'v1' })
const decision = atom({ plugin: 'compagnon', key: 'decision' } as const, null, { shape: 'v1' })
const cache = atom({ plugin: 'compagnon', key: 'cache' } as const, null, { shape: 'v1' })
const running = atom({ plugin: 'compagnon', key: 'running' } as const, [], { shape: 'v1' })
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
const advisor = atom({ plugin: 'compagnon', key: 'advisor' } as const, { calls: 0, lastAt: 0, pending: 0 }, { shape: 'v1' })
const ctxParts = atom({ plugin: 'compagnon', key: 'ctxParts' } as const, [], { shape: 'v1' })
const seen = atom({ plugin: 'compagnon', key: 'seen' } as const, {}, { shape: 'v1' })
const keepWarm = atom({ plugin: 'compagnon', key: 'keepWarm' } as const, null, { shape: 'v1' })
const collisions = atom({ plugin: 'compagnon', key: 'collisions' } as const, [], { shape: 'v1' })
const handoff = atom({ plugin: 'compagnon', key: 'handoff' } as const, null, { shape: 'v1' })
const tasks = atom({ plugin: 'compagnon', key: 'tasks' } as const, [], { shape: 'v1' })
const goal = atom({ plugin: 'compagnon', key: 'goal' } as const, null, { shape: 'v1' })
const lastTurnEnd = atom({ plugin: 'compagnon', key: 'lastTurnEnd' } as const, 0, { shape: 'v1' })
const turnStartedAt = atom({ plugin: 'compagnon', key: 'turnStartedAt' } as const, 0, { shape: 'v1' })
/** Compact (one row per subject) unless `e` unfolded the pane; owned here, the only module that reads or flips it. */
const isExpanded = atom({ plugin: 'compagnon', key: 'isExpanded' } as const, false, { shape: 'v1' })

type $ = EngineInterface

/** The last choice survives sessions: `session.start` reads it back from the store (`paneExpanded`, default compact). */
export async function restorePaneMode($: $) {
  if ((await $.store.get('paneExpanded')) === true) await update($, isExpanded, () => true)
}

/** The band above the prompt: one line, the figures that say whether to open the pane. */
export async function renderBand($: $, E: El) {
  await read($, tick)
  const [u, p, adv, turnCosts, ag] = await Promise.all([read($, usage), read($, pin), read($, advisor), read($, costs), read($, agents)])
  const label = p ? TIER_NAME[p.tier] : u ? modelLabel(u.model) : 'compagnon'
  const total = turnCosts.reduce((s: number, t: { usd: number }) => s + t.usd, 0)
  return Band(E, label, adv, total, u ? u.contextPct : null, activeAgents(ag).length, (await errorsNow($)).length)
}

/** The pane, `columns` wide: the chain, the cards, the keys; compact until `e`. `refreshRepos` is the `r` key. */
export async function renderPane($: $, E: El, columns: number, refreshRepos: () => void) {
  await read($, tick)
  const now = await $.clock.now()
  const [u, d, p, c, run, bg, ag, w, rp] = await Promise.all([
    read($, usage), read($, decision), read($, pin), read($, cache), read($, running), read($, background),
    read($, agents), read($, waiting), read($, repos),
  ])
  const isAuto = (await $.store.get('auto')) !== false
  const samples = ((await $.store.get('weekPeaks')) ?? {}) as DailySamples
  const [used, isOpen, kw, clash] = await Promise.all([read($, usedRepos), read($, isProjectsOpen), read($, keepWarm), read($, collisions)])
  const [ho, g, taskList, verdict] = await Promise.all([read($, handoff), read($, goal), read($, tasks), verdictNow($)])
  const [log, turnCosts, adv, parts, seenIds] = await Promise.all([read($, journal), read($, costs), read($, advisor), read($, ctxParts), read($, seen)])
  const routes = ((await $.store.get('routeLog')) ?? []) as RouteRecord[]
  const errors = await errorsNow($)
  const [started, ended, isOpenAll] = await Promise.all([read($, turnStartedAt), read($, lastTurnEnd), read($, isExpanded)])
  const activity = activityOf(started, ended, ag, now)
  const mode = { isCompact: !isOpenAll }
  const width = Math.min(64, columns)
  const ttl = ttlMs(c)
  // The countdown counts a keep-warm ping too: the status line's expiry is stale after one.
  const expiry = Math.max(c?.expiresAt ? c.expiresAt * 1000 : 0, warmUntilOf(kw, c))
  const warmLeft = expiry > 0 ? expiry - now : null
  const isKeepWarm = Boolean(kw && !kw.stopped)
  const { Box } = E
  return (
    <Box flexDirection="column">
      {Schema(E, { width: columns, usage: u, decision: d, pin: p, cache: c, verdict, keepWarm: kw, warmLeft, ttl, isAuto, advisor: adv, turns: turnCosts, seen: seenIds, parts, routes, agents: ag, journal: log, activity, isExpanded: Boolean(isOpenAll), now })}
      {ContextCard(E, width, u, ho, mode)}
      {PlanCard(E, width, u, samples, now, mode)}
      {ProcessCard(E, width, now, { running: run, tasks: bg, agents: ag, waiting: w, goal: g, taskList, activity }, id => void stopTask($, id), id => $.ui.view({ agentId: id }), mode)}
      {ErrorsCard(E, width, errors, mode)}
      {ProjectsCard(E, width, rp, used, clash, now, isOpen, mode)}
      {KeysLine(E, { isAuto, isKeepWarm, ho, hasIdle: rp.some(r => !used.includes(r.dir)), isOpen, isExpanded: Boolean(isOpenAll) }, {
        expand: () => void quietly($, async () => {
          await update($, isExpanded, () => !isOpenAll)
          await $.store.set('paneExpanded', !isOpenAll)
        }),
        auto: async () => {
          await $.store.set('auto', !isAuto)
          if (isAuto) await update($, pin, () => null) // off = back to the session's own model
          await update($, tick, n => n + 1)
        },
        keepWarm: () => void setKeepWarm($, isKeepWarm ? null : 2),
        handoff: () => void quietly($, () => askHandoff($)),
        resume: () => void quietly($, () => continueFromHandoff($)),
        refresh: refreshRepos,
        fold: () => void update($, isProjectsOpen, v => !v),
      })}
    </Box>
  )
}
