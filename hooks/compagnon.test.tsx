import { expect, mock, test, type TestBody } from 'claude-code/testing'

import type { CacheInfo, ErrorEntry, Ledger, LogEntry } from '../types'
import { DEFAULT_TIER, TIER_NAME, TIERS, TIERS_STRONGEST_FIRST, tierOf, modelLabel, releaseOf, versionOf } from './tiers'
import { advise, adviseClassified, CLASSIFY_LABELS, RULES, delegationHint, needsClassifier, pushRoute, route, ROUTE_LOG_MAX, routeRecord, routeReport, settle, spawnModel, supportsAlias, tierOfLabel, withoutPin } from './request-routing'
import { chargeReport, contextParts } from './load-report'
import { SPRITE_COLUMNS, SPRITE_ROWS, spriteCells, spriteRuns } from './companion-sprite'
import { activeAgents, activityOf, asLedger, cacheFromRelay, cacheState, collisionFor, collisionsWith, costDelta, costSummary, DONE_MS, elapsedLabel, ERROR_LOG_MAX, errorReport, clockLabel, errorSummary, errorText, FRESH_ERROR_MS, goalProgress, hasFreshError, isAnimated, isFinished, isOptionOn, keepWarmDue, lastSevenDays, LOG_MAX, moodOf, needsColdGuard, parseStatus, pingMissed, pushError, pushLog, recordSample, sessionErrors, tokensOption, touchedRepos, ttlMs } from './logic'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const warm = (recache: number, expiresIn = 1_800): CacheInfo => ({
  warm: true, caching: true, ttl: '1h', expiresAt: NOW / 1000 + expiresIn, recacheTokensIfCold: recache, hitRatio: 0.9,
})

test('advise reads the need, and leaves follow-ups and commands alone', async () => {
  expect(advise('ok')).toBe(null)
  expect(advise('/compact maintenant stp merci')).toBe(null)
  expect(advise("revois l'architecture du pipeline de génération")?.tier).toBe('fable')
  expect(advise('il y a un bug sur la page profil quand on clique')?.effort).toBe('high')
  expect(advise('où est défini le hook useModuleEnabled ?')?.tier).toBe('haiku')
  expect(advise('quelle branche est en retard sur origin ?')?.tier).toBe('haiku')
})

test('a warm big cache is never thrown away: the work goes to a subagent', async () => {
  const need = advise('où est défini le hook useModuleEnabled ?')!
  const d = route(need, 'opus', cacheState(warm(150_000), NOW, 0, 150_000))
  expect(d.action).toBe('delegate')
  expect(d.tier).toBe('haiku')
  expect(delegationHint(d, need.need)).toContain('model: "haiku"')
})

test('a switch happens only when it costs nothing', async () => {
  const need = advise('où est défini le hook useModuleEnabled ?')!
  // cold cache, expired TTL, compaction just done, small context
  expect(route(need, 'opus', cacheState({ ...warm(150_000), warm: false }, NOW, 0, 150_000)).action).toBe('switch')
  expect(route(need, 'opus', cacheState(warm(150_000, -10), NOW, 0, 150_000)).action).toBe('switch')
  expect(route(need, 'opus', cacheState({ ...warm(0), recacheTokensIfCold: null }, NOW, 0, 150_000)).action).toBe('switch')
  expect(route(need, 'opus', cacheState(warm(12_000), NOW, 0, 12_000)).action).toBe('switch')
  // no relay from the status line: warm for 1 h after the last turn, then free
  expect(route(need, 'opus', cacheState(null, NOW, NOW - 600_000, 150_000)).action).toBe('delegate')
  expect(route(need, 'opus', cacheState(null, NOW, NOW - 3_700_000, 150_000)).action).toBe('switch')
  // same tier: nothing to do
  expect(route({ ...need, tier: 'opus' }, 'opus', cacheState(warm(150_000), NOW, 0, 150_000)).action).toBe('keep')
})

test('a version is read from the model id, never written in the mod', async () => {
  expect(versionOf('claude-opus-5-5')).toBe('5.5')
  expect(versionOf('claude-fable-5-1')).toBe('5.1')
  expect(versionOf('claude-sonnet-4-5-20250929')).toBe('4.5')
  expect(versionOf('claude-sonnet-4-20250514')).toBe('4')
  expect(versionOf('claude-opus-5-5[1m]')).toBe('5.5')
  expect(versionOf('claude-3-5-sonnet-20241022')).toBe(null)
  expect(versionOf('opus')).toBe(null)
  expect(modelLabel('claude-haiku-5-5')).toBe('Haiku 5.5')
  expect(modelLabel('sonnet')).toBe('Sonnet')
})

test('the alias pin needs engine 2.1.309, and a doubt never breaks a turn', async () => {
  expect(supportsAlias('2.1.309')).toBe(true)
  expect(supportsAlias('2.1.318 (Claude Code)')).toBe(true)
  expect(supportsAlias({ version: '2.2.0', release: 'x', builtAt: '2026-11-01T10:00:00Z' })).toBe(true)
  expect(supportsAlias('3.0.0')).toBe(true)
  expect(supportsAlias('2.1.308')).toBe(false)
  expect(supportsAlias({ version: '2.0.999' })).toBe(false)
  expect(supportsAlias(undefined)).toBe(false)
  expect(supportsAlias({ build: 'unknown' })).toBe(false)
  // without alias support a switch becomes a delegation, the other actions are untouched
  const need = advise('où est défini le hook useModuleEnabled ?')!
  const free = route(need, 'opus', cacheState({ ...warm(150_000), warm: false }, NOW, 0, 150_000))
  expect(free.action).toBe('switch')
  expect(withoutPin(free, 'opus').action).toBe('delegate')
  expect(withoutPin({ ...free, action: 'keep' }, 'opus').action).toBe('keep')
})

test('a delegation fills the model of a general-purpose subagent, and nothing else', async () => {
  const delegate = { action: 'delegate', tier: 'sonnet', effort: 'medium', why: 'x' } as const
  expect(spawnModel(delegate, { subagentType: 'general-purpose' })).toBe('sonnet')
  // a model the call gave stays, a named agent keeps its own model
  expect(spawnModel(delegate, { subagentType: 'general-purpose', model: 'opus' })).toBe(undefined)
  expect(spawnModel(delegate, { subagentType: 'search' })).toBe(undefined)
  expect(spawnModel(delegate, { subagentType: 'Explore' })).toBe(undefined)
  // forks, teammates and resumed runs are left alone
  expect(spawnModel(delegate, { subagentType: 'general-purpose', fork: true })).toBe(undefined)
  expect(spawnModel(delegate, { subagentType: 'general-purpose', isTeammate: true })).toBe(undefined)
  expect(spawnModel(delegate, { subagentType: 'general-purpose', resume: { agentId: 'a1' } })).toBe(undefined)
  // no delegation, no imposition
  expect(spawnModel({ ...delegate, action: 'switch' }, { subagentType: 'general-purpose' })).toBe(undefined)
  expect(spawnModel({ ...delegate, action: 'keep' }, { subagentType: 'general-purpose' })).toBe(undefined)
  expect(spawnModel(null, { subagentType: 'general-purpose' })).toBe(undefined)
})

test('the journal keeps the last dozen lines, each cut short', async () => {
  let list: LogEntry[] = []
  for (let i = 0; i < LOG_MAX + 5; i++) list = pushLog(list, { at: i, kind: 'route', text: `ligne ${i}` })
  expect(list.length).toBe(LOG_MAX)
  expect(list[0]?.text).toBe('ligne 5')
  expect(pushLog([], { at: 1, kind: 'route', text: `a\n${'x'.repeat(300)}` })[0]?.text.length).toBe(100)
})

test('a turn costs what the session figure moved by, and the advisor share is read off the turns it joined', async () => {
  expect(Math.round(costDelta(1.2, 1.5) * 100)).toBe(30)
  expect(costDelta(1.5, 0.2)).toBe(0) // a reload reads lower: never a negative cost
  const turns = [
    { at: 1, usd: 0.08, tier: 'sonnet' as const, advisorCalls: 0 },
    { at: 2, usd: 0.21, tier: 'sonnet' as const, advisorCalls: 1 },
  ]
  const s = costSummary(turns)
  expect(s.turns).toBe(2)
  expect(Math.round(s.totalUsd * 100)).toBe(29)
  expect(s.advisorTurns).toBe(1)
  expect(Math.round(s.advisorShare * 100)).toBe(72)
  expect(costSummary([])).toEqual({ turns: 0, totalUsd: 0, avgUsd: 0, advisorTurns: 0, advisorUsd: 0, advisorShare: 0 })
})

test('the context parts keep what is loaded, largest first', async () => {
  const parts = contextParts([
    { name: 'Skills', tokens: 9451, kind: 'used' },
    { name: 'System tools', tokens: 27908, kind: 'used' },
    { name: 'System tools (deferred)', tokens: 34807, kind: 'deferred' },
    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    { name: 'Free space', tokens: 921206, kind: 'free' },
    { name: 'Empty', tokens: 0, kind: 'used' },
  ])
  expect(parts.map(p => p.name)).toEqual(['System tools', 'Skills'])
})

test('an alias that now resolves to another id is a release, said once; a first sight is learned silently', async () => {
  const first = releaseOf({}, 'claude-opus-5-5')
  expect(first.changed).toBe(null)
  expect(first.seen).toEqual({ opus: 'claude-opus-5-5' })
  expect(releaseOf(first.seen, 'claude-opus-5-5').seen).toBe(first.seen) // same id: nothing to learn
  const moved = releaseOf(first.seen, 'claude-opus-5-6')
  expect(moved.changed).toEqual({ tier: 'opus', from: 'claude-opus-5-5', to: 'claude-opus-5-6' })
  expect(moved.seen).toEqual({ opus: 'claude-opus-5-6' })
  expect(releaseOf(first.seen, 'some-other-model').changed).toBe(null) // names no tier: teaches nothing
  expect(releaseOf(first.seen, 'claude-opus-6').changed?.to).toBe('claude-opus-6') // a major counts too
})

test('an older id (a fallback step, another window still on the previous release) or another spelling is not a release', async () => {
  const seen = { opus: 'claude-opus-5-5' }
  expect(releaseOf(seen, 'claude-opus-5')).toEqual({ seen, changed: null }) // the 2026-11-07 ping-pong: Opus 5 ↔ 5.5
  expect(releaseOf(seen, 'claude-opus-5-5[1m]')).toEqual({ seen, changed: null })
  expect(releaseOf(seen, 'claude-opus-5-5-20261001')).toEqual({ seen, changed: null })
  expect(releaseOf(seen, 'opus')).toEqual({ seen, changed: null }) // an alias carries no version
  expect(releaseOf({ opus: 'opus' }, 'claude-opus-5-5')).toEqual({ seen: { opus: 'claude-opus-5-5' }, changed: null }) // a versionless memory is replaced silently
})

test('git status v2 gives branch, ahead, behind and changes', async () => {
  const out = '# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/x.ts\n? undefined/\n'
  const r = parseStatus('mon-projet', out)
  expect(r.branch).toBe('main')
  expect(r.ahead).toBe(2)
  expect(r.behind).toBe(1)
  expect(r.dirty).toBe(2)
  expect(r.hasUpstream).toBe(true)
})

test('daily samples keep each window peak and seven days only', async () => {
  let s = {}
  for (let d = 1; d <= 9; d++) s = recordSample(s, `2026-11-0${d}`, d * 5)
  s = recordSample(s, '2026-11-09', 1)
  expect(Object.keys(s).length).toBe(7)
  expect(s['2026-11-09' as keyof typeof s]).toBe(45)
  expect(lastSevenDays({}, NOW)).toEqual([0, 0, 0, 0, 0, 0, 0])
})

test('a tool call marks the repositories it touches, whatever the path spelling', async () => {
  const dirs = ['C:/Users/me/GitHub/projet-a', 'C:/Users/me/GitHub/projet-b']
  expect(touchedRepos({ file_path: 'C:\\Users\\me\\GitHub\\projet-a\\src\\x.ts' }, dirs)).toEqual([dirs[0]])
  expect(touchedRepos({ command: 'git -C /c/Users/me/GitHub/projet-b status' }, dirs)).toEqual([dirs[1]])
  expect(touchedRepos({ command: 'ls' }, dirs)).toEqual([])
  // a sibling whose name starts the same is not a hit
  expect(touchedRepos({ path: 'C:/Users/me/GitHub/projet-a-old/x' }, dirs)).toEqual([])
})

test('the cold guard asks only for a big context on a cold cache', async () => {
  const cold = cacheState({ ...warm(200_000), warm: false }, NOW, 0, 200_000)
  expect(cold.isCold).toBe(true)
  expect(needsColdGuard(cold, 150_000)).toBe(true)
  expect(needsColdGuard(cold, 0)).toBe(false) // 0 = guard off
  expect(needsColdGuard(cacheState({ ...warm(50_000), warm: false }, NOW, 0, 50_000), 150_000)).toBe(false)
  expect(needsColdGuard(cacheState(warm(200_000), NOW, 0, 200_000), 150_000)).toBe(false)
  // a keep-warm ping after the status line spoke: still warm, no switch, no guard
  const pinged = cacheState({ ...warm(200_000), warm: false }, NOW, 0, 200_000, NOW + 600_000)
  expect(pinged.isCold).toBe(false)
  expect(pinged.isFree).toBe(false)
})

test('keep-warm pings a margin before the TTL ends, never during a turn, and stops at its limit', async () => {
  const hour = 3_600_000
  expect(ttlMs({ ...warm(1), ttl: '5m' })).toBe(300_000)
  expect(ttlMs(null)).toBe(hour)
  expect(keepWarmDue(NOW, NOW - 55 * 60_000, hour, NOW + hour, false)).toBe('ping')
  expect(keepWarmDue(NOW, NOW - 20 * 60_000, hour, NOW + hour, false)).toBe('wait')
  expect(keepWarmDue(NOW, NOW - 55 * 60_000, hour, NOW + hour, true)).toBe('wait')
  expect(keepWarmDue(NOW, NOW - 55 * 60_000, hour, NOW - 1, false)).toBe('stop')
  expect(pingMissed({ cache_creation_input_tokens: 150_000, cache_read_input_tokens: 2_000 })).toBe(true)
  expect(pingMissed({ cache_creation_input_tokens: 40, cache_read_input_tokens: 150_000 })).toBe(false)
  // a small context: the ping's own tokens are written, the cache was still read
  expect(pingMissed({ cache_creation_input_tokens: 60, cache_read_input_tokens: 500 })).toBe(false)
})

test('a collision is another live session editing the same file in the window, until allowed', async () => {
  const other: Ledger = { id: 'abcdef12-x', title: 'refonte hub', updatedAt: NOW, ended: false, files: { 'c:/r/a.ts': { path: 'C:/r/a.ts', at: NOW - 5 * 60_000 } } }
  const allowed = new Map<string, number>()
  expect(collisionFor('c:/r/a.ts', [other], NOW, 30 * 60_000, allowed)?.other.title).toBe('refonte hub')
  expect(collisionFor('c:/r/b.ts', [other], NOW, 30 * 60_000, allowed)).toBe(null)
  expect(collisionFor('c:/r/a.ts', [other], NOW + 40 * 60_000, 30 * 60_000, allowed)).toBe(null)
  allowed.set('c:/r/a.ts|abcdef12-x', NOW - 5 * 60_000)
  expect(collisionFor('c:/r/a.ts', [other], NOW, 30 * 60_000, allowed)).toBe(null)
  const mine = { 'c:/r/a.ts': { path: 'C:/r/a.ts', at: NOW } }
  expect(collisionsWith(mine, [other], NOW, 30 * 60_000)).toEqual([{ file: 'a.ts', who: 'refonte hub', at: NOW - 5 * 60_000 }])
})

test('another session ledger that is valid JSON but not a ledger is dropped or trimmed, never thrown on', async () => {
  for (const raw of [null, 3, 'x', [], {}, { id: 'a', updatedAt: NOW }, { id: 'a', updatedAt: 'hier', files: {} }, { id: 1, updatedAt: NOW, files: {} }])
    expect(asLedger(raw)).toBe(null)
  const odd = asLedger({ id: 'abcdef12-x', updatedAt: NOW, files: { 'c:/r/a.ts': { path: 'C:/r/a.ts', at: NOW - 60_000 }, 'c:/r/b.ts': { at: NOW }, 'c:/r/c.ts': null } })
  expect(odd).toEqual({ id: 'abcdef12-x', title: '', updatedAt: NOW, ended: false, files: { 'c:/r/a.ts': { path: 'C:/r/a.ts', at: NOW - 60_000 } } })
  // what used to throw in every collision check of the session now reads
  const mine = { 'c:/r/a.ts': { path: 'C:/r/a.ts', at: NOW }, 'c:/r/b.ts': { path: 'C:/r/b.ts', at: NOW } }
  expect(collisionsWith(mine, [odd!], NOW, 30 * 60_000).map(c => c.file)).toEqual(['a.ts'])
  expect(collisionFor('c:/r/b.ts', [odd!], NOW, 30 * 60_000, new Map())).toBe(null)
})

test('a token count option reads decimals, a k and a thousands space; anything else keeps the default', async () => {
  expect(tokensOption('150000')).toBe(150_000)
  expect(tokensOption('150k')).toBe(150_000)
  expect(tokensOption('1.5k')).toBe(1_500) // it used to read as 1.5 tokens: a guard before every cold send
  expect(tokensOption('1,5 k')).toBe(1_500)
  expect(tokensOption('150 000')).toBe(150_000)
  expect(tokensOption('150,000')).toBe(150_000) // a thousands separator read as a decimal gave 150 tokens: a question before every cold send
  expect(tokensOption('1,5k')).toBe(1_500)
  expect(tokensOption('0')).toBe(0) // 0 = guard off, a real value
  expect(tokensOption(200000)).toBe(200_000)
  for (const v of ['', undefined, null, 'abc', '-5', '1e5', '150kk']) expect(tokensOption(v)).toBe(null)
})

test('goal progress counts live tasks and gives an ETA after two are done', async () => {
  const t = (id: string, status: 'pending' | 'in_progress' | 'completed' | 'deleted') => ({ id, subject: id, status })
  expect(goalProgress([t('1', 'completed'), t('2', 'pending'), t('3', 'deleted')], NOW - 600_000, NOW)).toEqual({ done: 1, total: 2, pct: 50, etaMs: null })
  expect(goalProgress([t('1', 'completed'), t('2', 'completed'), t('3', 'pending'), t('4', 'pending')], NOW - 600_000, NOW).etaMs).toBe(600_000)
})

const PANE = {
  plugin: 'compagnon',
  component: 'Pane',
  requestId: 'compagnon',
  props: { title: 'Compagnon', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

test('the pane opens compact before any measure: one row per subject, and e unfolds it into cards and back', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.id', () => ({ value: 'session-1' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = [/^Model {6}\S/, /^Context {4}…$/, /^7-day plan …$/, /^z Resting$/, /^Errors {5}none$/, /^Projects {3}0$/]
  for (const row of rows) expect((await ui.find({ type: 'Text', text: row }))?.text).toMatch(row)
  expect(await ui.findAll({ type: 'Text', text: /^╭─/ })).toEqual([])
  expect((await ui.find({ type: 'Button', key: 'expand' }))?.props.label).toBe('expand')
  await ui.press({ key: 'expand' })
  for (const title of ['Model', 'Context', '7-day plan', 'Errors', 'Projects', 'Advisor', 'Decisions', 'Scouts', 'Log']) {
    // unfolded, the title sits in the card's top border: ╭─ Title ─…
    const top = new RegExp(`^╭─ ${title} ─`)
    expect((await ui.find({ type: 'Text', text: top }))?.text).toMatch(top)
  }
  expect((await ui.find({ type: 'Button', key: 'expand' }))?.props.label).toBe('collapse')
  await ui.press({ key: 'expand' })
  expect(await ui.findAll({ type: 'Text', text: /^╭─/ })).toEqual([])
  await ui.unmount()
})

const LIVE = Date.parse('2026-11-05T15:20:00Z')
const ROUTES = [
  { at: LIVE - 90_000, source: 'keywords', tier: 'opus', effort: 'high', action: 'keep', head: 'il y a un bug sur la page profil' },
  { at: LIVE - 30_000, source: 'classifier', tier: 'sonnet', effort: 'medium', action: 'switch', head: 'change la couleur du lien' },
]
const STATE: Record<string, unknown> = {
  usage: { model: 'claude-opus-5-5', contextPct: 74, contextTokens: 148_000, contextWindow: 200_000, limits: [{ kind: 'seven_day', percentUsed: 41, resetsAt: '2026-11-08T09:00:00Z' }], costUsd: 0 },
  cache: { warm: true, caching: true, ttl: '1h', expiresAt: LIVE / 1000 + 2_520, recacheTokensIfCold: 148_000, hitRatio: 0.93 },
  decision: { action: 'delegate', tier: 'sonnet', effort: 'medium', why: 'warm cache of 148k: Opus keeps the lead, work handed to a Sonnet subagent' },
  keepWarm: { until: LIVE + 7_200_000, pings: 2, lastPingAt: LIVE - 600_000, stopped: null },
  running: [{ id: 't1', tool: 'Bash', label: 'npx vitest run', start: LIVE - 150_000 }],
  agents: [
    { id: 'a1', label: 'Survey cache keeper', type: 'general-purpose', status: 'running', firstSeen: LIVE - 200_000 },
    { id: 's1', label: 'cartographie', type: 'search', status: 'running', firstSeen: LIVE - 42_000 },
    { id: 'g1', label: 'sites d’appel', type: 'grep', status: 'completed', firstSeen: LIVE - 60_000, endedAt: LIVE - 42_000 },
  ],
  repos: [
    { dir: 'C:/Users/me/GitHub/projet-c', name: 'projet-c', branch: 'main', ahead: 2, behind: 0, dirty: 17, hasUpstream: true },
    { dir: 'C:/Users/me/GitHub/projet-d', name: 'projet-d', branch: 'main', ahead: 0, behind: 0, dirty: 0, hasUpstream: true },
  ],
  usedRepos: ['C:/Users/me/GitHub/projet-c'],
  collisions: [{ file: 'Bouton.tsx', who: 'refonte hub mobile', at: LIVE - 420_000 }],
  goal: { condition: 'les 18 warnings exhaustive-deps corrigés, gates verts', startedAt: LIVE - 1_800_000 },
  seen: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' },
  advisor: { calls: 2, lastAt: LIVE - 120_000, pending: 0 },
  costs: [
    { at: LIVE - 600_000, usd: 0.08, tier: 'sonnet', advisorCalls: 0 },
    { at: LIVE - 300_000, usd: 0.21, tier: 'sonnet', advisorCalls: 1 },
  ],
  ctxParts: [
    { name: 'System tools', tokens: 27908 },
    { name: 'Skills', tokens: 9451 },
    { name: 'System prompt', tokens: 1987 },
    { name: 'Messages', tokens: 3717 },
  ],
  journal: [
    { at: LIVE - 60_000, kind: 'advisor', text: 'consulted' },
    { at: LIVE - 30_000, kind: 'route', text: 'Debugging: Opus, effort high' },
  ],
  tasks: [
    { id: '1', subject: 'Lot A', status: 'completed' },
    { id: '2', subject: 'Lot B', status: 'completed' },
    { id: '3', subject: 'Revue à l’aveugle', status: 'in_progress' },
    { id: '4', subject: 'Commit et push', status: 'pending' },
  ],
}

/** The busy state with the pane unfolded (`e`): the full detail of every card. */
const OPEN: Record<string, unknown> = { ...STATE, isExpanded: true }

test('a busy session reads in plain words: cache countdown, keep-warm, goal, collision', async ($, on) => {
  const arrays = ['running', 'background', 'agents', 'repos', 'usedRepos', 'collisions', 'tasks', 'journal', 'costs', 'ctxParts']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : ['lastTurnEnd', 'tick', 'costMark'].includes(key) ? 0 : key === 'seen' ? {} : key === 'advisor' ? { calls: 0, lastAt: 0, pending: 0 } : ['isProjectsOpen', 'isWorking'].includes(key) ? false : null
    return { value: { value: { shape: 'v1', value: key in OPEN ? OPEN[key] : fallback }, version: 1 } }
  })
  on('store.get', (_, e) => ({ value: (e as unknown as { key: string }).key === 'routeLog' ? ROUTES : undefined }))
  on('clock.now', () => ({ value: LIVE }))
  on('session.id', () => ({ value: 'session-1' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // the ping 10 min ago holds the cache 50 min more, past the status line's stale 42 min
  for (const words of [/^ {2}50 min$/, /● kept warm/, /handed to Sonnet$/, /^goal 2\/4 ▰/, /Bouton\.tsx also edited in "refonte hub mobile"/, /^RUNNING {2}1 tool · 2 agents$/, /148k \/ 200k/]) {
    expect((await ui.find({ type: 'Text', text: words }))?.text).toMatch(words)
  }
  // a collision turns the Projects card's key value into ▲ 1
  expect((await ui.find({ type: 'Text', text: /^╭─ Projects ─+ ▲ 1 ─╮$/ }))?.text).toMatch(/▲ 1/)
  // the chain: advisor, the main session with what it loads, the decision layer, the scouts (one card), the journal, the status line
  for (const words of [
    /^╭─ Advisor ─+ ▲ 2 calls ─╮$/, /^2 min ago$/, /~72% of the cost \(advisor\)/,
    /seen: Opus 5\.5 · Sonnet 5\.5 · Haiku 5\.5/, /^tools 28k · skills 9k · prompt 2k$/,
    /^╭─ Decisions ─+ 2 ─╮$/, /keywords 1 · classifier 1 · default 0/, /switches to this tier/,
    /^╭─ Scouts ─+ ● 1 running ─╮$/, /^● search 0:42 · map$/, /^✓ grep {3}0:18 · calls$/, /^· audit {2}idle · review$/,
    /^consulted$/, /^Debugging: Opus, effort high$/,
    /agents \[2 active\] · advisor \[2 calls\] · decisions \[2\] · cost \$0\.29/,
  ]) {
    expect((await ui.find({ type: 'Text', text: words }))?.text).toMatch(words)
  }
  await ui.unmount()
})

test('the band above the prompt is one line of figures', async ($, on) => {
  const arrays = ['agents', 'costs']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : key === 'advisor' ? { calls: 0, lastAt: 0, pending: 0 } : ['tick'].includes(key) ? 0 : null
    return { value: { value: { shape: 'v1', value: key in STATE ? STATE[key] : fallback }, version: 1 } }
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: LIVE }))
  on('session.id', () => ({ value: 'session-1' }))
  const ui = await $.ui.mount({
    plugin: 'compagnon',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 90, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as never)
  // 74 % is past the warning threshold: ▲ says it without the colour
  const line = /^Opus 5\.5 · advisor 2 · \$0\.29 · ▲ ctx 74% · agents 2$/
  expect((await ui.find({ type: 'Text', text: line }))?.text).toMatch(line)
  await ui.unmount()
})

test('a boolean option is on unless it says off, whichever way it arrives', async () => {
  expect(isOptionOn(undefined)).toBe(true) // unset: the default
  expect(isOptionOn(true)).toBe(true)
  expect(isOptionOn('true')).toBe(true)
  expect(isOptionOn(false)).toBe(false)
  expect(isOptionOn('false')).toBe(false)
  expect(isOptionOn(' False ')).toBe(false)
})

test('the keyword rules say who decided, and a lookup stays a lookup whatever it names', async () => {
  expect(advise("revois l'architecture du pipeline")?.source).toBe('keywords')
  expect(advise('la page profil affiche des résultats bizarres depuis hier')?.source).toBe('default')
  expect(advise('la page profil affiche des résultats bizarres depuis hier')?.tier).toBe('opus')
  // a request that opens with a lookup word: a lookup, even when it names tests (it used to go to Sonnet)
  expect(advise('liste les fichiers de tests du dossier arsenal')?.tier).toBe('haiku')
  // « montre-moi » with its hyphen (it used to fall through to the default)
  expect(advise('montre-moi le contenu du fichier vercel.json')?.tier).toBe('haiku')
  // debugging and architecture keep priority over the lookup opening
  expect(advise('où est le bug sur la page profil ?')?.tier).toBe('opus')
  expect(advise('quelle est la cause racine des lenteurs sur mobile ?')?.tier).toBe('fable')
  // edits and features unchanged
  expect(advise('corrige la faute dans le titre de la page lab')?.tier).toBe('sonnet')
  expect(advise('implémente la sauvegarde automatique du brouillon')?.tier).toBe('opus')
})

test('a classifier answer maps back to its tier, and only an exact label counts', async () => {
  for (const tier of ['haiku', 'sonnet', 'opus', 'fable'] as const) expect(tierOfLabel(CLASSIFY_LABELS[tier])).toBe(tier)
  expect(tierOfLabel('sonnet')).toBe(undefined)
  expect(tierOfLabel('')).toBe(undefined)
  const advice = adviseClassified('fable')
  expect(advice.source).toBe('classifier')
  expect(advice.tier).toBe('fable')
  expect(advice.effort).toBe('xhigh')
  expect(adviseClassified('haiku').effort).toBe('low')
})

test('every tier the rules, the labels and the names use exists in TIERS, and an unknown id falls back on the default', async () => {
  const ids = TIERS.map(t => t.id) as string[]
  expect(new Set(ids).size).toBe(ids.length)
  for (const rule of RULES) expect(ids).toContain(rule.tier)
  expect(Object.keys(CLASSIFY_LABELS)).toEqual(ids)
  expect(Object.keys(TIER_NAME)).toEqual(ids)
  expect(new Set(Object.values(CLASSIFY_LABELS)).size).toBe(ids.length) // two equal labels would make tierOfLabel ambiguous
  expect(ids).toContain(DEFAULT_TIER)
  // The table reproduces the former hand-written values: same order for the classifier, same ranks, names and efforts.
  expect(ids).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
  expect(TIERS_STRONGEST_FIRST).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  expect(TIERS.map(t => `${t.name}:${t.effort}`)).toEqual(['Haiku:low', 'Sonnet:medium', 'Opus:medium', 'Fable:xhigh'])
  for (const model of ['', 'gpt-5', 'mistral-large-2', 'claude-unknown-9-9']) {
    expect(tierOf(model)).toBe(DEFAULT_TIER)
    expect(releaseOf({}, model)).toEqual({ seen: {}, changed: null })
  }
  // An unknown id routes as the default tier but is shown as it is, never as « Opus 9.9 ».
  expect(modelLabel('claude-unknown-9-9')).toBe('claude-unknown-9-9')
  expect(modelLabel('gpt-5')).toBe('gpt-5')
  expect(modelLabel('')).toBe(TIER_NAME[DEFAULT_TIER])
  expect(tierOf('claude-haiku-5-5')).toBe('haiku')
  expect(advise('rédige une réponse pour ce message reçu ce matin')?.tier).toBe(DEFAULT_TIER)
})

test('the routing record keeps the first words only, the last two hundred, and reports by layer', async () => {
  const need = adviseClassified('sonnet')
  const record = routeRecord(NOW, `change la couleur\n${'x'.repeat(300)}`, need, 'switch')
  expect(record.head.length).toBe(80)
  expect(record.head.startsWith('change la couleur x')).toBe(true)
  let list: ReturnType<typeof routeRecord>[] = []
  for (let i = 0; i < ROUTE_LOG_MAX + 3; i++) list = pushRoute(list, routeRecord(NOW + i, `demande ${i}`, need, 'keep'))
  expect(list.length).toBe(ROUTE_LOG_MAX)
  expect(list[0]?.head).toBe('demande 3')
  expect(routeReport([])).toBe('No decision recorded yet.')
  const kw = routeRecord(NOW, 'corrige ceci', { ...need, source: 'keywords' }, 'switch')
  const report = routeReport([kw, record])
  expect(report.split('\n')[0]).toBe('2 decisions: keywords 1, classifier 1, default 0.')
  expect(report).toContain('corrige ceci')
})

test('wide pane: the advisor sits beside the main session, the scouts under them with what each is for', async ($, on) => {
  const arrays = ['running', 'background', 'agents', 'repos', 'usedRepos', 'collisions', 'tasks', 'journal', 'costs', 'ctxParts']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : ['lastTurnEnd', 'tick', 'costMark'].includes(key) ? 0 : key === 'seen' ? {} : key === 'advisor' ? { calls: 0, lastAt: 0, pending: 0 } : ['isProjectsOpen', 'isWorking'].includes(key) ? false : null
    return { value: { value: { shape: 'v1', value: key in OPEN ? OPEN[key] : fallback }, version: 1 } }
  })
  on('store.get', (_, e) => ({ value: (e as unknown as { key: string }).key === 'routeLog' ? ROUTES : undefined }))
  on('clock.now', () => ({ value: LIVE }))
  on('session.id', () => ({ value: 'session-1' }))
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 }, surface: 'terminal' } as never)
  for (const title of ['Advisor', 'Model', 'Decisions', 'Scouts']) {
    const top = new RegExp(`^╭─ ${title} ─`)
    expect((await ui.find({ type: 'Text', text: top }))?.text).toMatch(top)
  }
  expect((await ui.find({ type: 'Text', text: /↓ subagents/ }))?.text).toMatch(/↓ subagents/)
  expect((await ui.find({ type: 'Text', text: /^● search 0:42 · maps the repository$/ }))?.text).toMatch(/maps the repository/)
  await ui.unmount()
})

test('a narrow pane: no card spills past its width, compact or unfolded, and a state reads without its colour', async ($, on) => {
  const arrays = ['running', 'background', 'agents', 'repos', 'usedRepos', 'collisions', 'tasks', 'journal', 'costs', 'ctxParts']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : ['lastTurnEnd', 'tick', 'costMark'].includes(key) ? 0 : key === 'seen' ? {} : key === 'advisor' ? { calls: 0, lastAt: 0, pending: 0 } : ['isProjectsOpen', 'isWorking'].includes(key) ? false : null
    return { value: { value: { shape: 'v1', value: key in OPEN ? OPEN[key] : fallback }, version: 1 } }
  })
  on('store.get', (_, e) => ({ value: (e as unknown as { key: string }).key === 'routeLog' ? ROUTES : undefined }))
  on('clock.now', () => ({ value: LIVE }))
  on('session.id', () => ({ value: 'session-1' }))
  for (const columns of [36, 24]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' } as never)
    // every border line of every card fits the pane (cards had a 24-column floor, the scouts 12 each side by side)
    const borders = await ui.findAll({ type: 'Text', text: /^[╭╰]─.*[╮╯]$/ })
    expect(borders.length).toBeGreaterThan(8)
    expect(borders.map(b => b.text).filter(t => t.length > columns)).toEqual([])
    // the scouts' one card takes the pane's width; its title gives way first, never its value
    expect((await ui.find({ type: 'Text', text: /● 1 running ─╮$/ }))?.text.length).toBe(columns)
    // the context card past 70 % shows ▲ before its value, not only an orange border
    expect((await ui.find({ type: 'Text', text: /^╭─ Context ─+ ▲ 74% ─╮$/ }))?.text).toMatch(/▲ 74%/)
    await ui.unmount()
  }
})

test('a narrow compact pane keeps every row inside its width and its key value readable', async ($, on) => {
  mockState(on, STATE)
  for (const columns of [40, 24]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' } as never)
    for (const row of [/^Context {4}▲ 74%/, /^Errors {5}none$/, /^Projects {3}▲ 1/]) {
      const found = await ui.find({ type: 'Text', text: row })
      expect(found?.text).toMatch(row)
    }
    // the Box around each row holds it to the pane: no row is given more than the pane's width
    const boxes = (await ui.findAll({ type: 'Box' })).map(b => b.props.width).filter((w): w is number => typeof w === 'number')
    expect(boxes.filter(w => w > columns)).toEqual([])
    await ui.unmount()
  }
})

test('the load report names the heavy sources: memory files by path, skills by plugin, agents, commands, MCP by server', async () => {
  const breakdown = {
    categories: [
      { name: 'System tools', tokens: 15818, kind: 'used' },
      { name: 'Memory files', tokens: 15757, kind: 'used' },
      { name: 'Skills', tokens: 9451, kind: 'used' },
      { name: 'Messages', tokens: 13092, kind: 'used' },
      { name: 'Free space', tokens: 907516, kind: 'free' },
    ],
    memoryFiles: [{ path: '/p/RTK.md', type: 'Project', tokens: 151 }, { path: '/p/CLAUDE.md', type: 'Project', tokens: 15606 }],
    skills: { totalSkills: 3, tokens: 161, skillFrontmatter: [
      { name: 'a', source: 'userSettings', tokens: 101 },
      { name: 'brand-voice:x', source: 'plugin', pluginName: 'brand-voice', tokens: 36 },
      { name: 'brand-voice:y', source: 'plugin', pluginName: 'brand-voice', tokens: 24 },
    ] },
    agents: [{ agentType: 'brand-voice:z', source: 'plugin', tokens: 404 }, { agentType: 'search', source: 'userSettings', tokens: 300 }],
    slashCommands: { totalCommands: 65, tokens: 919 },
    mcpTools: [{ server: 'supabase', tokens: 800 }, { name: 'github', tokens: 500 }, { server: 'supabase', tokens: 200 }],
  }
  const report = chargeReport(breakdown)
  expect(report.split('\n')[0]).toBe('Startup load: 41.0k tokens, plus the conversation 13.1k tokens.')
  expect(report).toContain('Memory files 15.8k')
  // the heaviest memory file comes first, with its path
  expect(report.indexOf('15.6k')).toBeLessThan(report.indexOf('151'))
  expect(report).toContain('/p/CLAUDE.md')
  expect(report).toContain('Skills (3, 161), by source: userSettings 101 · brand-voice 60.')
  expect(report).toContain('Agents (2, 704), by source: plugin 404 · userSettings 300.')
  expect(report).toContain('MCP tools (3, 1.5k), by server: supabase 1.0k · github 500.')
  expect(report).toContain('Commands: 65 (919).')
  // a shape it does not know never throws
  expect(chargeReport(undefined)).toBe('No measure: the engine returned no context detail.')
  expect(chargeReport({ categories: [{ name: 'Skills', tokens: 10, kind: 'used' }], memoryFiles: 'oops', skills: null, mcpTools: [null, 3] })).toContain('Startup load: 10 tokens.')
})

test('a request that opens with a lookup verb is a lookup: mapping, finding, listing', async () => {
  for (const ask of [
    'cartographie ce dépôt : où le palier est décidé et qui appelle tierOf',
    'trouve tous les endroits qui lisent le fichier claude-ctx',
    'recense les hooks qui touchent au cache',
    'fais-moi la liste des agents et de leurs modèles',
    'qui appelle tierOf dans ce dépôt ?',
  ]) expect(advise(ask)?.tier).toBe('haiku')
  // debugging and architecture words still win over the lookup verb
  expect(advise('trouve le bug qui fait planter la page profil')?.tier).toBe('opus')
  expect(advise('cartographie la cause racine de la lenteur sur mobile')?.tier).toBe('fable')
})

test('the debugging rule does not fire on a typo or inside another word', async () => {
  // « erreur de frappe » used to cost an Opus turn at high effort, while « faute de frappe » went to Sonnet
  expect(advise("corrige l'erreur de frappe dans le titre de la page lab")?.tier).toBe('sonnet')
  expect(advise('corrige les erreurs de frappe du README')?.tier).toBe('sonnet')
  expect(advise('corrige la faute de frappe dans le README')?.tier).toBe('sonnet')
  // « implante » holds « plante »: it is no crash
  expect(advise('implante le composant de recherche dans la page')?.need).not.toBe('Debugging')
  // the real ones still are
  expect(advise('il y a une erreur dans les logs au démarrage du serveur')?.need).toBe('Debugging')
  expect(advise('le build plante depuis la mise à jour de vite')?.need).toBe('Debugging')
  expect(advise('plante au démarrage quand le cache est vide, regarde')?.need).toBe('Debugging')
})

test('the keyword rules read English as well as French, each language on a real request', async () => {
  // English requests: the same tiers as their French twins in the tests above
  expect(advise('review the architecture of the generation pipeline')?.tier).toBe('fable')
  expect(advise('what is the root cause of the slowness on mobile?')?.tier).toBe('fable')
  expect(advise('there is a bug on the profile page when I click')?.need).toBe('Debugging')
  expect(advise('the build crashes since the vite upgrade')?.need).toBe('Debugging')
  expect(advise('the tests are failing after the merge, have a look')?.need).toBe('Debugging')
  expect(advise('where is the useModuleEnabled hook defined?')?.tier).toBe('haiku')
  expect(advise('list the test files in the arsenal folder')?.tier).toBe('haiku')
  expect(advise('who calls tierOf in this repository?')?.tier).toBe('haiku')
  expect(advise('find the bug that crashes the profile page')?.tier).toBe('opus') // debugging wins over the lookup verb
  expect(advise('refactor the auth service into smaller modules')?.need).toBe('Feature or refactor')
  expect(advise('implement automatic saving of the draft')?.need).toBe('Feature or refactor')
  expect(advise('fix the typo in the title of the lab page')?.need).toBe('Routine edit')
  expect(advise('fix the spelling error in the README')?.need).toBe('Routine edit') // a spelling error is a typo, not a bug
  expect(advise('add a dark theme toggle to the settings page')?.need).toBe('Routine edit')
  expect(advise('commit and push the changes on this branch')?.need).toBe('Routine edit')
  // the French keywords are all still read
  expect(advise("revois l'architecture du pipeline de génération")?.tier).toBe('fable')
  expect(advise('il y a un bug sur la page profil quand on clique')?.need).toBe('Debugging')
  expect(advise('où est défini le hook useModuleEnabled ?')?.tier).toBe('haiku')
  expect(advise('implémente la sauvegarde automatique du brouillon')?.need).toBe('Feature or refactor')
  expect(advise('corrige la faute dans le titre de la page lab')?.need).toBe('Routine edit')
})

test('the classifier labels are English and carry the criteria of each tier', async () => {
  expect(CLASSIFY_LABELS.haiku).toBe('simple lookup or reading question (where, list, show, how many)')
  expect(CLASSIFY_LABELS.fable).toContain('root cause')
  for (const label of Object.values(CLASSIFY_LABELS)) expect(label).toMatch(/^[a-z][a-z ,()-]+\)?$/)
})

test('the classifier raises the weak edit rule, never lowers it, and answers what no rule recognised', async () => {
  const edit = advise('ajoute un nouveau type de fiche concept avec ses relations')!
  expect(edit.tier).toBe('sonnet')
  expect(needsClassifier(edit)).toBe(true)
  expect(settle(edit, 'opus').tier).toBe('opus') // a feature, not an edit
  expect(settle(edit, 'opus').source).toBe('classifier')
  expect(settle(edit, 'fable').tier).toBe('fable')
  expect(settle(edit, 'haiku')).toBe(edit) // never lowered
  expect(settle(edit, undefined)).toBe(edit) // a timeout or a failure keeps the keyword answer
  const unknown = advise('la page profil affiche des résultats bizarres depuis hier')!
  expect(needsClassifier(unknown)).toBe(true)
  expect(settle(unknown, 'haiku').tier).toBe('haiku') // nothing recognised it: the classifier decides, up or down
  const debug = advise('il y a un bug sur la page profil quand on clique')!
  expect(needsClassifier(debug)).toBe(false) // a strong rule is not second-guessed
  const lookup = advise('où est défini le hook useModuleEnabled ?')!
  expect(needsClassifier(lookup)).toBe(false)
})

test('the load report points at the heavy sources only', async () => {
  const heavy = chargeReport({
    categories: [{ name: 'Memory files', tokens: 20000, kind: 'used' }],
    memoryFiles: [{ path: '/work/projet-e/CLAUDE.md', type: 'Project', tokens: 17000 }, { path: '/work/projet-e/RTK.md', type: 'Project', tokens: 151 }],
    skills: { totalSkills: 2, tokens: 2000, skillFrontmatter: [{ name: 'a:x', source: 'plugin', pluginName: 'marketing', tokens: 1800 }, { name: 'b', source: 'userSettings', tokens: 200 }] },
    agents: [{ agentType: 'brand-voice:z', source: 'plugin', tokens: 1900 }],
    mcpTools: [{ server: 'supabase', tokens: 2500 }],
  })
  expect(heavy).toContain('Pointers:')
  expect(heavy).toContain('projet-e/CLAUDE.md weighs 17.0k')
  expect(heavy).toContain('Plugin marketing: 1.8k of skills')
  expect(heavy).toContain('Plugin agents: 1.9k')
  expect(heavy).toContain('MCP server supabase: 2.5k')
  // a small memory file and a user skill earn no pointer
  expect(heavy).not.toContain('RTK.md weighs')
  expect(heavy).not.toContain('Plugin userSettings')
  const light = chargeReport({ categories: [{ name: 'Memory files', tokens: 3000, kind: 'used' }], memoryFiles: [{ path: '/p/CLAUDE.md', type: 'Project', tokens: 3000 }] })
  expect(light).not.toContain('Pointers')
})

test('contract with claude-config: the prompt_cache the status line relays reads into a cache state', async () => {
  // exactly what hooks/statusline.js writes under `prompt_cache` (raw input.prompt_cache), keys as the engine names them
  const relayed = { warm: true, caching_observed: true, ttl: '1h', expires_at: 1793990000, recache_tokens_if_cold: 148000, hit_ratio: 0.93 }
  expect(cacheFromRelay(relayed)).toEqual({ warm: true, caching: true, ttl: '1h', expiresAt: 1793990000, recacheTokensIfCold: 148000, hitRatio: 0.93 })
  expect(cacheFromRelay(null)).toBe(null) // statusline.js writes null before the engine reports a cache
  expect(cacheFromRelay(undefined)).toBe(null)
  expect(cacheFromRelay('x')).toBe(null)
  // a key of the wrong type reads as absent, never as a wrong number
  const odd = cacheFromRelay({ warm: 'yes', ttl: 3600, expires_at: '1793990000', hit_ratio: NaN })
  expect(odd).toEqual({ warm: false, caching: false, ttl: undefined, expiresAt: null, recacheTokensIfCold: null, hitRatio: null })
})

test('the error log keeps the last twenty, each message on one line and cut short, and counts this session only', async () => {
  let list: ErrorEntry[] = []
  for (let i = 0; i < ERROR_LOG_MAX + 4; i++) list = pushError(list, { at: NOW + i, session: i % 2 ? 's1' : 's0', message: `failure ${i}` })
  expect(list.length).toBe(ERROR_LOG_MAX)
  expect(list[0]?.message).toBe('failure 4')
  expect(pushError([], { at: NOW, session: 's1', message: `a\n${'x'.repeat(300)}` })[0]?.message.length).toBe(120)
  expect(sessionErrors(list, 's1').every(e => e.session === 's1')).toBe(true)
  // only the message is kept: an Error, a hook failure, a string, anything else
  expect(errorText(new Error('agent list down'))).toBe('agent list down')
  expect(errorText({ kind: 'throw', message: 'boom', budget: 5000 }, 'tool.call')).toBe('tool.call: boom')
  expect(errorText({ kind: 'timeout', budget: 5000 }, 'band')).toBe('band: timed out')
  expect(errorText('plain')).toBe('plain')
  expect(errorText(undefined)).toBe('unknown error')
  expect(errorSummary([])).toBe(null)
  expect(errorSummary([{ at: NOW, session: 's1', message: 'agent list down' }])).toBe('✕ 1 error, last: agent list down')
  expect(errorSummary(list.slice(-2))).toBe('✕ 2 errors, last: failure 23')
  expect(errorSummary([{ at: NOW, session: 's1', message: 'y'.repeat(100) }])?.endsWith('…')).toBe(true)
  expect(errorReport([])).toBe('No error recorded.')
  const report = errorReport(list.slice(-2))
  expect(report.split('\n').length).toBe(3)
  expect(report).toContain('failure 23')
  expect(report.split('\n')[1]).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} {2}failure 22$/)
})

test('a failed refresh is recorded and shown on the status line, a good loop adds nothing, and the 15 s loop keeps going', async ($, on) => {
  const clock = mock.clock(on, { now: LIVE })
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get((e as unknown as { key: string }).key) }))
  on('store.set', (_, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined }
  })
  mock.env(on, { USERPROFILE: 'C:/home/someone', TEMP: 'C:/tmp' })
  let isAgentListDown = false
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: 'C:/work/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { percent: 10, tokens: 20_000, window: 200_000 }, rateLimits: [], cost: { usd: 0 }, startedAt: LIVE } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', () => ({ value: { command: 'compagnon' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', () => {
    throw new Error('no relay file') // refreshCache reads that as "no status line relay yet", not as a failure
  })
  on('agent.list', () => {
    // a hook of the test's that throws is skipped: the call then rejects, as an engine call without an answer does
    if (isAgentListDown) throw new Error('agent list down')
    return { value: [] }
  })
  on('session.start', () => ({ cwd: 'C:/work/repo' }))
  await $.session.start({ cwd: 'C:/work/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const errorLog = async () => (store.get('errorLog') ?? []) as ErrorEntry[]
  expect(await errorLog()).toEqual([])
  await clock.advance(15_000)
  expect(await errorLog()).toEqual([]) // a loop that succeeds adds nothing
  isAgentListDown = true
  await clock.advance(15_000)
  const log = await errorLog()
  expect(log.length).toBe(1)
  expect(log[0]?.message).toBe('no implementation for agent.list')
  expect(log[0]?.session).toBe('session-1')
  isAgentListDown = false
  await clock.advance(15_000)
  expect((await errorLog()).length).toBe(1)
  isAgentListDown = true
  await clock.advance(15_000)
  expect((await errorLog()).length).toBe(2) // the loop went on past the first error
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // compact: the Errors row says how many, in red with ✕; unfolded, the card says the last one
  const row = await ui.find({ type: 'Text', text: /^Errors {5}✕ 2/ })
  expect(row?.text).toMatch(/✕ 2/)
  await ui.press({ key: 'expand' })
  const line = /^✕ 2 errors, last: no implementation for agent\.list$/
  expect((await ui.find({ type: 'Text', text: line }))?.props.color).toBe('error')
  await ui.unmount()
  const band = await $.ui.mount({
    plugin: 'compagnon',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 90, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as never)
  expect((await band.find({ type: 'Text', text: /· ✕ 2$/ }))?.text).toMatch(/✕ 2$/)
  await band.unmount()
  // `/compagnon errors` lists them with their date and time
  const listed = (await $.command.run({ command: 'compagnon', args: 'errors' } as never)) as { text?: string }
  expect(listed.text?.split('\n')[0]).toBe('2 errors (last 20 kept, newest last):')
  expect(listed.text?.split('\n')[2]).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} {2}no implementation for agent\.list$/)
})

test('the band and the status line count the same active agents: an ended one (completed, failed, killed) is not active', async ($, on) => {
  const statuses = ['running', 'waiting', 'idle', 'pending', 'completed', 'failed', 'killed']
  const everyStatus = statuses.map((status, i) => ({ id: `a${i}`, label: `agent ${status}`, type: 'general-purpose', status, firstSeen: LIVE - 60_000 }))
  expect(activeAgents(everyStatus).map(a => a.status)).toEqual(['running', 'waiting', 'idle', 'pending'])
  for (const status of ['completed', 'failed', 'killed']) expect(isFinished(status)).toBe(true)
  const state: Record<string, unknown> = { ...OPEN, agents: everyStatus }
  const arrays = ['running', 'background', 'agents', 'repos', 'usedRepos', 'collisions', 'tasks', 'journal', 'costs', 'ctxParts']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : ['lastTurnEnd', 'tick', 'costMark'].includes(key) ? 0 : key === 'seen' ? {} : key === 'advisor' ? { calls: 0, lastAt: 0, pending: 0 } : ['isProjectsOpen', 'isWorking'].includes(key) ? false : null
    return { value: { value: { shape: 'v1', value: key in state ? state[key] : fallback }, version: 1 } }
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: LIVE }))
  on('session.id', () => ({ value: 'session-1' }))
  const band = await $.ui.mount({
    plugin: 'compagnon',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 90, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as never)
  const bandCount = (await band.find({ type: 'Text', text: /agents \d+$/ }))?.text.match(/agents (\d+)$/)?.[1]
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const lineCount = (await pane.find({ type: 'Text', text: /agents \[\d+ active\]/ }))?.text.match(/agents \[(\d+) active\]/)?.[1]
  // the failed agent has its own FAILED line (red) and is not counted running: 4 agents and the Bash call run
  expect((await pane.find({ type: 'Text', text: /^RUNNING {2}1 tool · 4 agents$/ }))?.text).toMatch(/4 agents/)
  expect((await pane.find({ type: 'Text', text: /^agent failed · agent failed · / }))?.props.color).toBe('error')
  await pane.unmount()
  expect(bandCount).toBe('4')
  expect(lineCount).toBe(bandCount)
})

/** The state hook a pane test uses, registered once: the state `of` gives at each read, each key's own default otherwise. */
function mockState(on: Parameters<TestBody>[1], of: Record<string, unknown> | (() => Record<string, unknown>), now = () => LIVE) {
  const current = typeof of === 'function' ? of : () => of
  const arrays = ['running', 'background', 'agents', 'repos', 'usedRepos', 'collisions', 'tasks', 'journal', 'costs', 'ctxParts']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : ['lastTurnEnd', 'tick', 'costMark', 'turnStartedAt'].includes(key) ? 0 : key === 'seen' ? {} : key === 'advisor' ? { calls: 0, lastAt: 0, pending: 0 } : ['isProjectsOpen', 'isWorking', 'isExpanded'].includes(key) ? false : null
    const state = current()
    return { value: { value: { shape: 'v1', value: key in state ? state[key] : fallback }, version: 1 } }
  })
  on('store.get', (_, e) => ({ value: (e as unknown as { key: string }).key === 'routeLog' ? ROUTES : undefined }))
  on('clock.now', () => ({ value: now() }))
  on('session.id', () => ({ value: 'session-1' }))
}

test('compact, each subject is one row with its key value, and the detail waits behind e', async ($, on) => {
  mockState(on, STATE)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const row of [
    // the chain folded to one row: the figures of the old status line sit in its note
    /^Model {6}Opus 5\.5 · auto · 2 decisions · advisor 2 calls · \$0\.29$/, /^Context {4}▲ 74% · 148k \/ 200k$/, /^7-day plan 41% · \S+ · resets in /,
    // what runs has its section, the goal its line in the head
    /^RUNNING {2}1 tool · 2 agents$/, /^goal 2\/4 ▰/,
    /^Errors {5}none$/, /^Projects {3}▲ 1 · collision$/,
  ]) expect((await ui.find({ type: 'Text', text: row }))?.text).toMatch(row)
  // no bordered card, no detail line: they are folded, not lost
  expect(await ui.findAll({ type: 'Text', text: /^╭─/ })).toEqual([])
  for (const detail of [/keywords 1 · classifier 1/, /^consulted$/, /^agents \[/]) expect(await ui.find({ type: 'Text', text: detail })).toBe(undefined)
  // `p` folds a list only the unfolded Projects card shows
  expect(await ui.find({ type: 'Button', key: 'fold' })).toBe(undefined)
  await ui.unmount()
})

test('cards follow importance, and the chain keeps its blocks and arrows narrow and wide', async ($, on) => {
  let isExpanded = false
  mockState(on, () => ({ ...STATE, isExpanded }))
  const texts = async (columns: number) => {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' } as never)
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    return all
  }
  // compact: the sections (what asks for you, what runs), then the model, what can call for an action, what informs
  const rows = await texts(50)
  const at = (re: RegExp) => rows.findIndex(t => re.test(t))
  const compact = [/^FOR YOU$/, /^RUNNING /, /^Model /, /^Context /, /^7-day plan /, /^Projects /, /^Errors /].map(at)
  expect(compact.every(i => i >= 0)).toBe(true)
  expect([...compact].sort((a, b) => a - b)).toEqual(compact)
  isExpanded = true
  const titles = (list: string[]) => list.map(t => /^╭─ (.+?) ─+ /.exec(t)?.[1]).filter(Boolean)
  const arrows = (list: string[]) => list.filter(t => /^ +[▽▼▲] (advice|decides|delegates|results)$/.test(t)).map(t => t.trim())
  // under 84 columns the chain is one column, its five blocks linked by four arrows, in the slot the Model row held
  const narrow = await texts(50)
  expect(titles(narrow)).toEqual(['Advisor', 'Model', 'Decisions', 'Scouts', 'Log', 'Context', '7-day plan', 'Projects', 'Errors'])
  expect(arrows(narrow)).toEqual(['▽ advice', '▼ decides', '▼ delegates', '▲ results'])
  const between = (a: RegExp, b: RegExp, c: RegExp) => { const i = narrow.findIndex(t => a.test(t)); const j = narrow.findIndex(t => b.test(t)); const l = narrow.findIndex(t => c.test(t)); return i < j && j < l }
  expect(between(/^╭─ Advisor /, /▽ advice$/, /^╭─ Model /)).toBe(true)
  expect(between(/^╭─ Model /, /▼ decides$/, /^╭─ Decisions /)).toBe(true)
  expect(between(/^╭─ Decisions /, /▼ delegates$/, /^╭─ Scouts /)).toBe(true)
  expect(between(/^╭─ Scouts /, /▲ results$/, /^╭─ Log /)).toBe(true)
  // from 84 columns: advisor beside the main session, no arrow lines, the subagents pointer instead
  const wide = await texts(100)
  expect(titles(wide)).toEqual(['Advisor', 'Model', 'Decisions', 'Scouts', 'Log', 'Context', '7-day plan', 'Projects', 'Errors'])
  expect(arrows(wide)).toEqual([])
  expect(wide.filter(t => /^ {2}↓ subagents$/.test(t)).length).toBe(1)
})

/** A healthy session: nothing needs a look, a keep-warm and a scout running (the accent's two uses). */
const HEALTHY: Record<string, unknown> = {
  ...STATE,
  usage: { model: 'claude-opus-5-5', contextPct: 32, contextTokens: 64_000, contextWindow: 200_000, limits: [{ kind: 'seven_day', percentUsed: 20, resetsAt: '2026-11-08T09:00:00Z' }], costUsd: 0 },
  running: [], collisions: [], costs: [{ at: LIVE - 600_000, usd: 0.08, tier: 'sonnet', advisorCalls: 0 }],
  agents: [{ id: 's1', label: 'cartographie', type: 'search', status: 'running', firstSeen: LIVE - 42_000 }],
  repos: [{ dir: 'C:/Users/me/GitHub/projet-c', name: 'projet-c', branch: 'main', ahead: 0, behind: 0, dirty: 3, hasUpstream: true }],
  journal: [{ at: LIVE - 30_000, kind: 'route', text: 'Debugging: Opus, effort high' }],
}

test('a healthy pane uses the neutral text and the one accent only, compact and unfolded', async ($, on) => {
  let isExpanded = false
  mockState(on, () => ({ ...HEALTHY, isExpanded }))
  for (const unfolded of [false, true]) {
    isExpanded = unfolded
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const colors = new Set((await ui.findAll({ type: 'Text' })).map(t => t.props.color))
    // the companion's own hex colours aside (it draws in its mood's tints, not in the theme's)
    expect([...colors].filter(c => c !== undefined && c !== 'suggestion' && !String(c).startsWith('#'))).toEqual([])
    // the accent marks what is active, with its symbol: the spinner of the work in flight
    expect((await ui.find({ type: 'Text', text: /Claude is working$/ }))?.props.color).toBe('suggestion')
    await ui.unmount()
  }
})

test('the activity reads working while a turn or an agent runs, done for a few seconds after, then nothing', async ($, on) => {
  const agent = { status: 'running', firstSeen: LIVE - 134_000 }
  expect(activityOf(0, 0, [agent], LIVE)).toEqual({ state: 'working', since: LIVE - 134_000 })
  expect(activityOf(LIVE - 20_000, 0, [], LIVE)).toEqual({ state: 'working', since: LIVE - 20_000 })
  expect(activityOf(LIVE - 20_000, 0, [agent], LIVE)).toEqual({ state: 'working', since: LIVE - 134_000 }) // the earliest start
  const ended = { status: 'completed', firstSeen: LIVE - 134_000, endedAt: LIVE - 3_000 }
  expect(activityOf(0, 0, [ended], LIVE)).toEqual({ state: 'done', at: LIVE - 3_000 })
  expect(activityOf(0, LIVE - 2_000, [], LIVE)).toEqual({ state: 'done', at: LIVE - 2_000 }) // a main turn that just ended
  expect(activityOf(0, 0, [ended], LIVE - 3_000 + DONE_MS)).toBe(null)
  expect(activityOf(0, 0, [], LIVE)).toBe(null) // nothing ever ran
  expect(elapsedLabel(134_000)).toBe('2m14')
  expect(elapsedLabel(5_400_000)).toBe('90m00')
  // the pane: the status line and the Process card say it, then it goes
  let now = LIVE
  const base = { ...STATE, running: [], tasks: [], goal: null, collisions: [] }
  let state: Record<string, unknown> = { ...base, isExpanded: true, agents: [{ id: 'a1', label: 'Survey', type: 'general-purpose', ...agent }] }
  mockState(on, () => state, () => now)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text', text: /^. Claude is working · 2m14$/ })).length).toBe(1) // the head
  await ui.unmount()
  state = { ...base, agents: [{ id: 'a1', label: 'Survey', type: 'general-purpose', ...ended }] }
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^✓ Turn done · 3 s ago$/ }))?.text).toBe('✓ Turn done · 3 s ago')
  expect((await ui.find({ type: 'Text', text: /^DONE {2}✓ general-purpose 2m11$/ }))?.props.color).toBe('success')
  await ui.unmount()
  now = LIVE + DONE_MS
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Turn done|working/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^done {2}✓ general-purpose/ }))?.props.dimColor).toBe(true) // then one grey line
  await ui.unmount()
})

/** Mocks a session start over a store that may be pre-seeded, or broken for the `paneExpanded` key only (the rest of the pane needs the store); `e` presses are written to the same store. */
async function startSession($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], store: Map<string, unknown>, isStoreBroken = false) {
  on('store.get', (_, e) => {
    const { key } = e as unknown as { key: string }
    if (isStoreBroken && key === 'paneExpanded') throw new Error('store down')
    return { value: store.get(key) }
  })
  on('store.set', (_, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    if (isStoreBroken && key === 'paneExpanded') throw new Error('store down')
    store.set(key, value)
    return { value: undefined }
  })
  mock.clock(on, { now: LIVE })
  mock.env(on, { USERPROFILE: 'C:/home/someone', TEMP: 'C:/tmp' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: 'C:/work/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { percent: 10, tokens: 20_000, window: 200_000 }, rateLimits: [], cost: { usd: 0 }, startedAt: LIVE } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', () => ({ value: { command: 'compagnon' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', () => {
    throw new Error('no relay file')
  })
  on('agent.list', () => ({ value: [] }))
  on('session.start', () => ({ cwd: 'C:/work/repo' }))
  await $.session.start({ cwd: 'C:/work/repo', surface: 'terminal', isInteractive: true })
}

test('the pane remembers e between sessions: unfolded last time, it reopens unfolded', async ($, on) => {
  const store = new Map<string, unknown>()
  await startSession($, on, store)
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await first.findAll({ type: 'Text', text: /^╭─/ })).toEqual([])
  await first.press({ key: 'expand' })
  expect(store.get('paneExpanded')).toBe(true)
  await first.unmount()
})

test('a new session opens unfolded when the store says paneExpanded, and compact otherwise', async ($, on) => {
  await startSession($, on, new Map([['paneExpanded', true]]))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^╭─ Model ─/ }))?.text).toMatch(/^╭─ Model ─/)
  await ui.press({ key: 'expand' }) // folding is remembered too
  expect((await ui.find({ type: 'Button', key: 'expand' }))?.props.label).toBe('expand')
  await ui.unmount()
})

test('a broken store leaves the pane compact and raises nothing', async ($, on) => {
  const store = new Map<string, unknown>([['paneExpanded', true]])
  await startSession($, on, store, true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Text', text: /^╭─/ })).toEqual([])
  await ui.press({ key: 'expand' }) // the toggle itself still works, only its memory fails
  expect(store.get('paneExpanded')).toBe(true) // untouched: nothing was written
  await ui.unmount()
})

test('the mood is derived by priority: error, then waiting for you, then work, then done, else idle', async () => {
  const working = { state: 'working', since: LIVE - 5_000 } as const
  const done = { state: 'done', at: LIVE - 2_000 } as const
  expect(moodOf({ isFailed: false, isWaiting: false, activity: working })).toBe('work')
  expect(moodOf({ isFailed: false, isWaiting: false, activity: done })).toBe('done')
  expect(moodOf({ isFailed: false, isWaiting: false, activity: null })).toBe('idle')
  // waiting beats work and done; a failure beats everything
  expect(moodOf({ isFailed: false, isWaiting: true, activity: working })).toBe('wait')
  expect(moodOf({ isFailed: false, isWaiting: true, activity: done })).toBe('wait')
  expect(moodOf({ isFailed: true, isWaiting: true, activity: working })).toBe('error')
  expect(moodOf({ isFailed: true, isWaiting: false, activity: null })).toBe('error')
  // only work and a wait move: the pane is redrawn every frame for those two and never otherwise
  expect((['work', 'wait', 'done', 'error', 'idle'] as const).filter(isAnimated)).toEqual(['work', 'wait'])
})

test('an error of the mod counts for the turn in flight, or for a minute when none runs', async () => {
  expect(hasFreshError([], 0, LIVE)).toBe(false)
  expect(hasFreshError([{ at: LIVE - 10_000 }], LIVE - 30_000, LIVE)).toBe(true) // during this turn
  expect(hasFreshError([{ at: LIVE - 40_000 }], LIVE - 30_000, LIVE)).toBe(false) // an earlier turn's
  expect(hasFreshError([{ at: LIVE - 10_000 }], 0, LIVE)).toBe(true) // no turn: the last minute
  expect(hasFreshError([{ at: LIVE - FRESH_ERROR_MS - 1 }], 0, LIVE)).toBe(false)
  expect(clockLabel(41 * 60_000 + 8_000)).toBe('41:08')
})

test('the companion is 16 columns by 9 rows for every mood and frame, half blocks only', async () => {
  for (const mood of ['work', 'wait', 'done', 'error', 'idle'] as const) {
    for (let tick = 0; tick < 4; tick++) {
      const rows = spriteCells(mood, tick)
      expect(rows.length).toBe(SPRITE_ROWS)
      expect(rows.every(r => r.length === SPRITE_COLUMNS)).toBe(true)
      // the merged runs cover the same 16 cells
      expect(spriteRuns(mood, tick).map(r => r.reduce((n, run) => n + run.text.length, 0))).toEqual(Array(SPRITE_ROWS).fill(SPRITE_COLUMNS))
    }
  }
  // work has four frames, wait two, the others one: the tick wraps
  expect(spriteCells('work', 4)).toEqual(spriteCells('work', 0))
  expect(spriteCells('work', 1)).not.toEqual(spriteCells('work', 0))
  expect(spriteCells('wait', 2)).toEqual(spriteCells('wait', 0))
  expect(spriteCells('done', 3)).toEqual(spriteCells('done', 0))
})

test('a half block takes the top pixel as colour and the bottom one as background, a lone bottom pixel is a lower half', async () => {
  const cells = spriteCells('work', 0).flat()
  const both = cells.find(c => c.char === '▀' && c.backgroundColor)
  const topOnly = cells.find(c => c.char === '▀' && !c.backgroundColor)
  const bottomOnly = cells.find(c => c.char === '▄')
  const empty = cells.find(c => c.char === ' ')
  expect(both?.color).toMatch(/^#[0-9a-f]{6}$/)
  expect(both?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
  expect(topOnly?.color).toMatch(/^#[0-9a-f]{6}$/)
  expect(bottomOnly?.color).toMatch(/^#[0-9a-f]{6}$/)
  expect(bottomOnly?.backgroundColor).toBe(undefined)
  expect(empty).toEqual({ char: ' ' })
  // the first row is a stem: the top pixels are lit, the bottom ones too (D then G of the first frame), the corners are empty
  expect(spriteCells('work', 0)[0]?.[0]).toEqual({ char: ' ' })
  // each mood has its own tint: the body is not the same colour in work and in error
  expect(spriteCells('work', 0)[4]?.[8]?.color).not.toBe(spriteCells('error', 0)[4]?.[8]?.color)
})

/** A session that asks for you, runs, failed and just finished: every section at once. */
const BUSY_ALL: Record<string, unknown> = {
  ...STATE,
  waiting: { kind: 'permission_prompt', message: 'Claude needs your permission to use Bash', at: LIVE - 38_000 },
  handoff: { path: 'C:/home/handoffs/session-1.md', state: 'ready', askedAt: LIVE - 90_000, pending: '', turnStarted: false },
  background: [{ id: 'b1', type: 'shell', label: 'npm run dev', firstSeen: LIVE - 720_000 }],
  agents: [
    { id: 'a1', label: 'Survey cache keeper', type: 'general-purpose', status: 'running', firstSeen: LIVE - 200_000 },
    { id: 'a2', label: 'tsc and tests', type: 'verify', status: 'running', firstSeen: LIVE - 20_000, parentId: 'a1' },
    { id: 'a3', label: 'review the diff', type: 'reviewer', status: 'running', firstSeen: LIVE - 700_000 },
    { id: 'f1', label: 'lint pass', type: 'lint', status: 'failed', firstSeen: LIVE - 90_000, endedAt: LIVE - 60_000 },
    { id: 'c1', label: 'map', type: 'Explore', status: 'completed', firstSeen: LIVE - 90_000, endedAt: LIVE - 49_000 },
  ],
  turnStartedAt: LIVE - 134_000,
}

test('the sections come by priority, FOR YOU first, then FAILED, RUNNING, then the cards, each only when it has something', async ($, on) => {
  mockState(on, BUSY_ALL)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const at = (re: RegExp) => rows.findIndex(t => re.test(t))
  const order = [/Something failed/, /^FOR YOU$/, /^FAILED$/, /^RUNNING /, /^─+$/, /^Model /, /^Errors /].map(at)
  expect(order.every(i => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  await ui.unmount()
})

test('a calm session shows none of the sections', async ($, on) => {
  mockState(on, { ...HEALTHY, agents: [], running: [] })
  const calm = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const title of [/^FOR YOU$/, /^FAILED$/, /^RUNNING/, /^DONE|^done /]) expect(await calm.find({ type: 'Text', text: title })).toBe(undefined)
  await calm.unmount()
})

test('DONE comes after RUNNING, and FOR YOU before both', async ($, on) => {
  // a fresh turn end, agents still listed as running elsewhere: all three titles in one pane
  mockState(on, { ...BUSY_ALL, waiting: null, collisions: [], turnStartedAt: 0, lastTurnEnd: LIVE - 3_000, agents: [(BUSY_ALL.agents as unknown[])[4]] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const at = (re: RegExp) => rows.findIndex(t => re.test(t))
  const order = [/^FOR YOU$/, /^RUNNING /, /^DONE {2}✓ Explore 0m41$/].map(at)
  expect(order.every(i => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  await ui.unmount()
})

test('nothing of the old pane is lost: permission, collision, handoff, cold cache, stop, view, goal, keys', async ($, on) => {
  const cold = { ...(STATE.cache as object), warm: false }
  mockState(on, { ...BUSY_ALL, cache: cold, keepWarm: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
  // FOR YOU: the permission with where to answer, the collision, the handoff with c, the cold cache with k
  expect(await text(/Claude needs your permission to use Bash · asked 0m38/)).toBeDefined()
  expect(await text(/^answer in chat$/)).toBeDefined()
  expect(await text(/Bouton\.tsx also edited in "refonte hub mobile"/)).toBeDefined()
  expect(await text(/^ready, written to handoffs\/session-1\.md$/)).toBeDefined()
  expect(await text(/^c restart$/)).toBeDefined()
  expect(await text(/next send rereads 148k tokens/)).toBeDefined()
  expect(await text(/^k keep warm$/)).toBeDefined()
  expect(await text(/74% full, \/clear or handoff/)).toBeUndefined() // a ready handoff already answers it
  // FAILED: the failed agent with view
  expect(await text(/^lint pass · agent failed · 1 min$/)).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'view-f1' }))?.props.label).toBe('view')
  // RUNNING: paused on the permission, a tool, a stuck agent with view, a long background task with stop
  expect(await text(/^RUNNING {2}paused on you$/)).toBeDefined()
  expect(await text(/^npx vitest run$/)).toBeDefined()
  expect(await text(/^review the diff · running 11m40, may be stuck$/)).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'view-a3' }))?.props.label).toBe('view')
  expect(await text(/^npm run dev · in background 12 min$/)).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'stop-b1' }))?.props.label).toBe('stop')
  // the goal with its pace, the keys
  expect(await text(/^goal 2\/4 ▰/)).toMatch(/~/)
  for (const key of ['expand', 'auto', 'keepwarm', 'continue', 'refresh']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
  await ui.unmount()
})

test('a context nearly full asks for a handoff when none is ready', async ($, on) => {
  mockState(on, { ...STATE, collisions: [] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^74% full, \/clear or handoff$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^h handoff$/ }))?.text).toBe('h handoff')
  await ui.unmount()
})

test('a subagent sits under the agent that spawned it, and one orphaned by a missing parent is a root of its own', async ($, on) => {
  mockState(on, { ...BUSY_ALL, waiting: null, collisions: [], agents: [
    { id: 'p', label: 'parent job', type: 'builder', status: 'running', firstSeen: LIVE - 60_000 },
    { id: 'k', label: 'child job', type: 'verify', status: 'running', firstSeen: LIVE - 30_000, parentId: 'p' },
    { id: 'o', label: 'orphan job', type: 'scout', status: 'running', firstSeen: LIVE - 30_000, parentId: 'gone' },
  ] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const at = (re: RegExp) => rows.findIndex(t => re.test(t))
  expect(rows.filter(t => /└/.test(t)).length).toBe(1) // only the child carries the branch mark
  expect(at(/^parent job$/)).toBeGreaterThanOrEqual(0)
  expect(at(/^parent job$/)).toBeLessThan(at(/^child job$/))
  expect(at(/^child job$/)).toBeLessThan(at(/^orphan job$/)) // the orphan comes after the first tree, not under it
  await ui.unmount()
})

test('the head names the state, the routed model and why, and the cache; amber with its key when the cache ends soon', async ($, on) => {
  mockState(on, { ...STATE, collisions: [], turnStartedAt: LIVE - 134_000, cache: { ...(STATE.cache as object), expiresAt: LIVE / 1000 + 200 }, keepWarm: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Opus 5\.5 → Sonnet · auto$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^for “change la couleur du lien” · classifier$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^▲ cache cold in 3:20 {2}k keep warm$/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('a kept-warm cache reads warm in the head, with the keep-warm saying so', async ($, on) => {
  mockState(on, { ...STATE, collisions: [] }) // the ping 10 min ago holds the cache 50 min more
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^cache warm 50:00 · keep-warm on$/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('the companion draws beside the head from 40 columns, and goes below, the text staying', async ($, on) => {
  mockState(on, { ...STATE, collisions: [] })
  const read = async (columns: number) => {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' } as never)
    const halves = (await ui.findAll({ type: 'Text', text: /^[ ▀▄]*[▀▄][ ▀▄]*$/ })).length
    const title = (await ui.find({ type: 'Text', text: /Claude is working|Resting|Waiting/ }))?.text
    await ui.unmount()
    return { halves, title }
  }
  expect((await read(64)).halves).toBeGreaterThan(9)
  expect((await read(40)).halves).toBeGreaterThan(9)
  const narrow = await read(39)
  expect(narrow.halves).toBe(0)
  expect(narrow.title).toBeDefined()
})

test('the band says in amber that the session waits for you, in place of the agents', async ($, on) => {
  mockState(on, { ...STATE, waiting: BUSY_ALL.waiting })
  const band = await $.ui.mount({
    plugin: 'compagnon', component: 'AbovePrompt', surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 90, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as never)
  const line = /^Opus 5\.5 · advisor 2 · \$0\.29 · ▲ ctx 74% · \? waiting for you$/
  expect((await band.find({ type: 'Text', text: line }))?.text).toMatch(line)
  expect((await band.find({ type: 'Text', text: /^ · \? waiting for you$/ }))?.props.color).toBe('warning')
  expect(await band.find({ type: 'Text', text: /agents 2/ })).toBe(undefined)
  await band.unmount()
})

test('each mood is read from the real state, in the head', async ($, on) => {
  let state: Record<string, unknown> = {}
  let now = LIVE
  mockState(on, () => state, () => now)
  const head = async (next: Record<string, unknown>, at = LIVE) => {
    state = next
    now = at
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const title = (await ui.find({ type: 'Text', text: /Claude is working|Waiting for you|Turn done|Something failed|Resting/ }))?.text
    await ui.unmount()
    return title
  }
  const calm = { ...STATE, collisions: [], running: [], agents: [], tasks: [], goal: null }
  expect(await head({ ...calm, turnStartedAt: LIVE - 5_000 })).toMatch(/Claude is working · 0m05/)
  expect(await head({ ...calm, turnStartedAt: LIVE - 5_000, waiting: BUSY_ALL.waiting })).toMatch(/Waiting for you · 0m38/)
  expect(await head({ ...calm, turnStartedAt: LIVE - 5_000, collisions: STATE.collisions })).toMatch(/Waiting for you/) // a collision waits for you too
  expect(await head({ ...calm, turnStartedAt: LIVE - 5_000, waiting: BUSY_ALL.waiting, agents: BUSY_ALL.agents })).toMatch(/Something failed/)
  expect(await head({ ...calm, lastTurnEnd: LIVE - 4_000 })).toMatch(/Turn done · 4 s ago/)
  expect(await head({ ...calm, lastTurnEnd: LIVE - 4_000 }, LIVE + DONE_MS)).toMatch(/Resting · idle 24 s/)
})
