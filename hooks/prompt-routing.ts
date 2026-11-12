// What a submitted prompt goes through, extracted from register.tsx (over its size): the cold-send guard, then the
// automatic routing (classifier, free switch or delegation hint). The decisions themselves are pure, in request-routing.ts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { CacheVerdict, RouteRecord, Tier } from '../types'
import { askHandoff } from './guards'
import { tierOf } from './tiers'
import { CLASSIFY_LABELS, CLASSIFY_TIMEOUT_MS, SOURCE_NAME, advise, delegationHint, needsClassifier, pushRoute, route, routeRecord, settle, supportsAlias, tierOfLabel, withoutPin } from './request-routing'
import { needsColdGuard } from './logic'
import { note, quietly, recordError, refreshCache, verdictNow } from './session-tracking'

// Declared again in each module that touches them: the state scan reads each module alone.
const pin = atom({ plugin: 'compagnon', key: 'pin' } as const, null, { shape: 'v1' })
const decision = atom({ plugin: 'compagnon', key: 'decision' } as const, null, { shape: 'v1' })
const usage = atom({ plugin: 'compagnon', key: 'usage' } as const, null, { shape: 'v1' })

type $ = EngineInterface

let aliasSupport: Promise<boolean> | null = null
/**
 * Asked once: the engine version does not change during a session. A failed read counts as no support, said once.
 * A function declaration, not an arrow: past an import, the engine follows `$` only into a declaration.
 */
export function isAliasSupported($: $): Promise<boolean> {
  aliasSupport ??= $.session.version().then(supportsAlias, () => false).then(async ok => {
    if (!ok) await quietly($, async () => $.ui.toast('compagnon: model switching off (needs Claude Code 2.1.309 or later, or the version could not be read).'))
    return ok
  })
  return aliasSupport
}

/**
 * The classifier layer: one Haiku call that picks the tier a request needs. Gives up after CLASSIFY_TIMEOUT_MS (or on any
 * failure, or when no label is named) so a slow or failing call never holds the prompt: the caller keeps the default.
 * A failing call is recorded (a classifier that always fails would otherwise route on keywords alone without a word).
 */
async function classifyTier($: $, text: string): Promise<Tier | undefined> {
  const answer = await Promise.race([
    $.model.classify(text, Object.values(CLASSIFY_LABELS), { model: 'haiku' }).catch(err => recordError($, err, 'classifier').then(() => undefined)),
    $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(() => undefined),
  ]).catch(() => undefined)
  return typeof answer === 'string' ? tierOfLabel(answer) : undefined
}

/**
 * Cold-send guard (from Cache Keeper): a cold cache over `threshold` asks before rewriting it all. Returns why the message
 * is held back (the prompt is dropped with it), or null to send it.
 */
export async function coldSendGuard($: $, text: string, threshold: number): Promise<string | null> {
  let verdict: CacheVerdict | null = null
  await quietly($, async () => {
    await refreshCache($)
    verdict = await verdictNow($)
  })
  const v = verdict as CacheVerdict | null
  if (!v || !needsColdGuard(v, threshold)) return null
  const answer = await $.ui
    .ask(`Cold cache: sending now rereads ${Math.round(v.recache / 1000)}k tokens of context. What should happen?`, {
      header: 'Cold cache',
      options: ['Send', 'Compact then send', 'Handoff then fresh session', 'Cancel'],
    })
    .catch(() => 'Send') // nobody to ask (a -p run) or dismissed: send as typed
  if (answer === 'Compact then send') {
    const isCompacted = await $.session.compact().then(() => true, () => false)
    if (!isCompacted) await $.ui.toast('Compaction refused by the engine: message sent as typed.')
  }
  if (answer === 'Handoff then fresh session') {
    $.clock.after(300, () => void quietly($, () => askHandoff($, text)))
    return 'Held by compagnon: handoff then fresh session, the message is sent again afterwards.'
  }
  if (answer === 'Cancel') return 'Cancelled by compagnon before rereading a cold cache.'
  return null
}

/**
 * Automatic routing (user directive 2026-11-05): switch the main loop only when no warm cache is lost, otherwise keep it
 * and steer the work to a subagent on the right model. Returns the hint to append to the message, '' for none.
 */
export async function routePrompt($: $, text: string, isClassifierOn: boolean): Promise<string> {
  const keyword = advise(text)
  if (!keyword || (await $.store.get('auto')) === false) return ''
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
  await note($, 'route', `${SOURCE_NAME[need.source]}: ${d.why}`)
  const kept = ((await $.store.get('routeLog')) ?? []) as RouteRecord[]
  await $.store.set('routeLog', pushRoute(kept, routeRecord(await $.clock.now(), text, need, d.action)))
  if (d.action === 'switch') await update($, pin, () => ({ tier: d.tier, effort: d.effort }))
  return d.action === 'delegate' ? delegationHint(d, need.need) : ''
}
