// The hooks of a turn's life, extracted from register.tsx (over its size): a permission prompt, the background work a stop
// reports, a turn's start and its end (and why it ended). They feed the state the pane and the companion read.
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { BackgroundTask } from '../types'
import { checkHandoff, noteTurnStart } from './guards'
import { refreshReposIfStale } from './repo-tracking'
import { animateWhileMoving, quietly, recordError, recordTurn, refreshAgents, refreshCache, refreshUsage } from './session-tracking'

// Declared again in each module that touches them: the state scan reads each module alone.
const background = atom({ plugin: 'compagnon', key: 'background' } as const, [], { shape: 'v1' })
const waiting = atom({ plugin: 'compagnon', key: 'waiting' } as const, null, { shape: 'v2' })
const lastTurnEnd = atom({ plugin: 'compagnon', key: 'lastTurnEnd' } as const, 0, { shape: 'v1' })
const lastTurnReason = atom({ plugin: 'compagnon', key: 'lastTurnReason' } as const, null, { shape: 'v1' })
const isWorking = atom({ plugin: 'compagnon', key: 'isWorking' } as const, false, { shape: 'v1' })
/** When the main turn in flight began, 0 when none: the activity indicator's clock. */
const turnStartedAt = atom({ plugin: 'compagnon', key: 'turnStartedAt' } as const, 0, { shape: 'v1' })

export function registerTurnHooks(on: On) {
  // Only a permission prompt waits for the person; an idle notice is rest, never a wait.
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') {
      await quietly($, async () => {
        const at = await $.clock.now()
        await update($, waiting, () => ({ kind: e.notification_type, message: e.message.slice(0, 80), at, ...(e.agent_id ? { agentId: e.agent_id } : {}) }))
      })
      void quietly($, () => animateWhileMoving($))
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'classic.Notification')
    return next.called ? undefined : next(e)
  }) // own failure: pass the work on, never run it twice

  // Stop carries the background work still in flight: the only list of shells and monitors a mod can read.
  on('classic.Stop', async ($, e, next) => {
    await quietly($, async () => {
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
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'classic.Stop')
    return next.called ? undefined : next(e)
  }) // own failure: pass the work on, never run it twice

  on('turn.start', async ($, e, next) => {
    if (!e.agentId)
      await quietly($, async () => {
        await update($, isWorking, () => true)
        const at = await $.clock.now()
        await update($, turnStartedAt, () => at)
        await update($, waiting, () => null) // a new turn means the prompt was answered
        await noteTurnStart($)
      })
    void quietly($, () => animateWhileMoving($))
    return next(e)
  }).catch(async ($, e, next) => {
    await recordError($, next.error, 'turn.start')
    return next.called ? undefined : next(e)
  }) // own failure: pass the work on, never run it twice

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A subagent's end changes the RUNNING and DONE sections, and settles the permission that agent raised: nobody waits for an
    // agent that is over. A prompt of the main loop or of another agent is not its to settle.
    if (e.agentId) {
      await quietly($, async () => {
        const w = await read($, waiting)
        if (w?.agentId === e.agentId) await update($, waiting, () => null)
      })
      await quietly($, () => refreshAgents($))
      return done
    }
    await quietly($, async () => {
      await update($, isWorking, () => false)
      await update($, turnStartedAt, () => 0)
      await update($, waiting, () => null) // the turn is over: an approved or denied prompt no longer waits
      await checkHandoff($)
    })
    // After `next`: a failure here must not lose the turn's result (it used to throw past it).
    await quietly($, async () => {
      const ended = await $.clock.now()
      await update($, lastTurnEnd, () => ended)
      await update($, lastTurnReason, () => e.reason)
      await Promise.all([quietly($, () => refreshUsage($)), quietly($, () => refreshAgents($)), quietly($, () => refreshCache($))])
    })
    await quietly($, () => recordTurn($))
    await quietly($, () => refreshReposIfStale($))
    return done
  })
}
