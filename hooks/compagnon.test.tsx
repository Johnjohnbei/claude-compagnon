import { expect, test } from 'claude-code/testing'

import type { CacheInfo, Ledger, LogEntry } from '../types'
import { advise, adviseClassified, asLedger, cacheFromRelay, cacheState, chargeReport, CLASSIFY_LABELS, DEFAULT_TIER, RULES, TIER_NAME, TIERS, TIERS_STRONGEST_FIRST, tierOf, collisionFor, collisionsWith, contextParts, costDelta, costSummary, delegationHint, goalProgress, isOptionOn, keepWarmDue, lastSevenDays, LOG_MAX, modelLabel, needsClassifier, needsColdGuard, parseStatus, pingMissed, pushLog, pushRoute, recordSample, releaseOf, route, ROUTE_LOG_MAX, routeRecord, routeReport, settle, spawnModel, summarizeParallel, supportsAlias, tierOfLabel, tokensOption, touchedRepos, ttlMs, versionOf, withoutPin } from './logic'

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

test('reads that waited for each other are flagged, batched ones are not', async () => {
  const serial = [0, 1, 2, 3, 4].map(i => ({ tool: 'Grep', start: i * 10, end: i * 10 + 5 }))
  expect(summarizeParallel(serial).sequentialReads).toBe(5)
  const batched = [0, 1, 2, 3, 4].map(() => ({ tool: 'Read', start: 0, end: 5 }))
  const sum = summarizeParallel(batched)
  expect(sum.sequentialReads).toBe(1)
  expect(sum.overlapped).toBe(5)
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

test('the pane draws its cards before any measure', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const title of ['Modèle', 'Contexte', 'Forfait 7 j', 'Process', 'Parallélisme', 'Projets']) {
    // the title sits in the card's top border: ╭─ Title ─…
    const top = new RegExp(`^╭─ ${title} ─`)
    expect((await ui.find({ type: 'Text', text: top }))?.text).toMatch(top)
  }
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
  decision: { action: 'delegate', tier: 'sonnet', effort: 'medium', why: 'cache chaud de 148 k : Opus garde la main, travail confié à un sous-agent Sonnet' },
  keepWarm: { until: LIVE + 7_200_000, pings: 2, lastPingAt: LIVE - 600_000, stopped: null },
  running: [{ id: 't1', tool: 'Bash', label: 'npx vitest run', start: LIVE - 150_000 }],
  agents: [
    { id: 'a1', label: 'Survey cache keeper', type: 'general-purpose', status: 'running', firstSeen: LIVE - 200_000 },
    { id: 's1', label: 'cartographie', type: 'search', status: 'running', firstSeen: LIVE - 42_000 },
    { id: 'g1', label: 'sites d’appel', type: 'grep', status: 'completed', firstSeen: LIVE - 60_000, endedAt: LIVE - 42_000 },
  ],
  parallel: { total: 12, overlapped: 4, sequentialReads: 5, agents: 1 },
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
    { at: LIVE - 60_000, kind: 'advisor', text: 'consulté' },
    { at: LIVE - 30_000, kind: 'route', text: 'Débogage : Opus, effort high' },
  ],
  tasks: [
    { id: '1', subject: 'Lot A', status: 'completed' },
    { id: '2', subject: 'Lot B', status: 'completed' },
    { id: '3', subject: 'Revue à l’aveugle', status: 'in_progress' },
    { id: '4', subject: 'Commit et push', status: 'pending' },
  ],
}


test('a busy session reads in plain words: cache countdown, keep-warm, goal, collision', async ($, on) => {
  const arrays = ['running', 'spans', 'background', 'agents', 'repos', 'usedRepos', 'collisions', 'tasks', 'journal', 'costs', 'ctxParts']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : ['lastTurnEnd', 'tick', 'costMark'].includes(key) ? 0 : key === 'seen' ? {} : key === 'advisor' ? { calls: 0, lastAt: 0, pending: 0 } : ['isProjectsOpen', 'isWorking'].includes(key) ? false : null
    return { value: { value: { shape: 'v1', value: key in STATE ? STATE[key] : fallback }, version: 1 } }
  })
  on('store.get', (_, e) => ({ value: (e as unknown as { key: string }).key === 'routeLog' ? ROUTES : undefined }))
  on('clock.now', () => ({ value: LIVE }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // the ping 10 min ago holds the cache 50 min more, past the status line's stale 42 min
  for (const words of [/^ {2}50 min$/, /au chaud/, /confié à Sonnet$/, /^2\/4$/, /Bouton\.tsx · « refonte hub mobile »/, /Bash 2 min · 2 agents/, /148 k \/ 200 k/]) {
    expect((await ui.find({ type: 'Text', text: words }))?.text).toMatch(words)
  }
  // a collision turns the Projets card's key value into ▲ 1
  expect((await ui.find({ type: 'Text', text: /^╭─ Projets ─+ ▲ 1 ─╮$/ }))?.text).toMatch(/▲ 1/)
  // the chain: advisor, the main session with what it loads, the decision layer, the scouts, the journal, the status line
  for (const words of [
    /^╭─ Advisor ─+ ▲ 2 appels ─╮$/, /^il y a 2 min$/, /~72 % du coût \(advisor\)/,
    /vus : Opus 5\.5 · Sonnet 5\.5 · Haiku 5\.5/, /^outils 28 k · skills 9 k · prompt 2 k$/,
    /^╭─ Décisions ─+ 2 ─╮$/, /mots-clés 1 · classifieur 1 · défaut 0/, /bascule sur ce palier/,
    /^╭─ search ─+╮$/, /^╭─ grep ─+╮$/, /^╭─ audit ─+╮$/, /^● 0:42$/, /^✓ 0:18$/, /^· inactif$/,
    /^consulté$/, /^Débogage : Opus, effort high$/,
    /agents \[2 actifs\] · advisor \[2 appels\] · décisions \[2\] · coût 0,29 \$/,
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
  const ui = await $.ui.mount({
    plugin: 'compagnon',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 90, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as never)
  // 74 % is past the warning threshold: ▲ says it without the colour
  const line = /^Opus 5\.5 · advisor 2 · 0,29 \$ · ▲ ctx 74 % · agents 2$/
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
  expect(routeReport([])).toBe('Aucune décision enregistrée pour l’instant.')
  const kw = routeRecord(NOW, 'corrige ceci', { ...need, source: 'keywords' }, 'switch')
  const report = routeReport([kw, record])
  expect(report.split('\n')[0]).toBe('2 décisions : mots-clés 1, classifieur 1, défaut 0.')
  expect(report).toContain('corrige ceci')
})

test('wide pane: the advisor sits beside the main session, the three scouts side by side', async ($, on) => {
  const arrays = ['running', 'spans', 'background', 'agents', 'repos', 'usedRepos', 'collisions', 'tasks', 'journal', 'costs', 'ctxParts']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : ['lastTurnEnd', 'tick', 'costMark'].includes(key) ? 0 : key === 'seen' ? {} : key === 'advisor' ? { calls: 0, lastAt: 0, pending: 0 } : ['isProjectsOpen', 'isWorking'].includes(key) ? false : null
    return { value: { value: { shape: 'v1', value: key in STATE ? STATE[key] : fallback }, version: 1 } }
  })
  on('store.get', (_, e) => ({ value: (e as unknown as { key: string }).key === 'routeLog' ? ROUTES : undefined }))
  on('clock.now', () => ({ value: LIVE }))
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 }, surface: 'terminal' } as never)
  for (const title of ['Advisor', 'Modèle', 'Décisions', 'search', 'grep', 'audit']) {
    const top = new RegExp(`^╭─ ${title} ─`)
    expect((await ui.find({ type: 'Text', text: top }))?.text).toMatch(top)
  }
  expect((await ui.find({ type: 'Text', text: /↓ sous-agents/ }))?.text).toMatch(/↓ sous-agents/)
  await ui.unmount()
})

test('a narrow pane: no card spills past its width, the scouts stack, and a state reads without its colour', async ($, on) => {
  const arrays = ['running', 'spans', 'background', 'agents', 'repos', 'usedRepos', 'collisions', 'tasks', 'journal', 'costs', 'ctxParts']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : ['lastTurnEnd', 'tick', 'costMark'].includes(key) ? 0 : key === 'seen' ? {} : key === 'advisor' ? { calls: 0, lastAt: 0, pending: 0 } : ['isProjectsOpen', 'isWorking'].includes(key) ? false : null
    return { value: { value: { shape: 'v1', value: key in STATE ? STATE[key] : fallback }, version: 1 } }
  })
  on('store.get', (_, e) => ({ value: (e as unknown as { key: string }).key === 'routeLog' ? ROUTES : undefined }))
  on('clock.now', () => ({ value: LIVE }))
  for (const columns of [36, 24]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' } as never)
    // every border line of every card fits the pane (cards had a 24-column floor, the scouts 12 each side by side)
    const borders = await ui.findAll({ type: 'Text', text: /^[╭╰]─.*[╮╯]$/ })
    expect(borders.length).toBeGreaterThan(8)
    expect(borders.map(b => b.text).filter(t => t.length > columns)).toEqual([])
    // three scouts cannot sit side by side: each takes the pane's width
    expect((await ui.find({ type: 'Text', text: /^╭─ search ─+╮$/ }))?.text.length).toBe(columns)
    // the context card past 70 % shows ▲ before its value, not only an orange border
    expect((await ui.find({ type: 'Text', text: /^╭─ Contexte ─+ ▲ 74 % ─╮$/ }))?.text).toMatch(/▲ 74 %/)
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
  expect(report.split('\n')[0]).toBe('Charge au démarrage : 41,0 k jetons, plus la conversation 13,1 k jetons.')
  expect(report).toContain('Memory files 15,8 k')
  // the heaviest memory file comes first, with its path
  expect(report.indexOf('15,6 k')).toBeLessThan(report.indexOf('151'))
  expect(report).toContain('/p/CLAUDE.md')
  expect(report).toContain('Skills (3, 161), par origine : userSettings 101 · brand-voice 60.')
  expect(report).toContain('Agents (2, 704), par origine : plugin 404 · userSettings 300.')
  expect(report).toContain('Outils MCP (3, 1,5 k), par serveur : supabase 1,0 k · github 500.')
  expect(report).toContain('Commandes : 65 (919).')
  // a shape it does not know never throws
  expect(chargeReport(undefined)).toBe('Aucune mesure : le moteur n’a pas renvoyé de détail de contexte.')
  expect(chargeReport({ categories: [{ name: 'Skills', tokens: 10, kind: 'used' }], memoryFiles: 'oops', skills: null, mcpTools: [null, 3] })).toContain('Charge au démarrage : 10 jetons.')
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
  expect(heavy).toContain('Pistes :')
  expect(heavy).toContain('projet-e/CLAUDE.md pèse 17,0 k')
  expect(heavy).toContain('Plugin marketing : 1,8 k de skills')
  expect(heavy).toContain('Agents de plugins : 1,9 k')
  expect(heavy).toContain('Serveur MCP supabase : 2,5 k')
  // a small memory file and a user skill earn no pointer
  expect(heavy).not.toContain('RTK.md pèse')
  expect(heavy).not.toContain('Plugin userSettings')
  const light = chargeReport({ categories: [{ name: 'Memory files', tokens: 3000, kind: 'used' }], memoryFiles: [{ path: '/p/CLAUDE.md', type: 'Project', tokens: 3000 }] })
  expect(light).not.toContain('Pistes')
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
