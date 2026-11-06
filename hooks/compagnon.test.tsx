import { expect, test } from 'claude-code/testing'

import type { CacheInfo, Ledger } from '../types'
import { advise, cacheState, collisionFor, collisionsWith, delegationHint, goalProgress, keepWarmDue, lastSevenDays, needsColdGuard, parseStatus, pingMissed, recordSample, modelLabel, route, spawnModel, summarizeParallel, supportsAlias, touchedRepos, ttlMs, versionOf, withoutPin } from './logic'

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
const STATE: Record<string, unknown> = {
  usage: { model: 'claude-opus-5-5', contextPct: 74, contextTokens: 148_000, contextWindow: 200_000, limits: [{ kind: 'seven_day', percentUsed: 41, resetsAt: '2026-11-08T09:00:00Z' }], costUsd: 0 },
  cache: { warm: true, caching: true, ttl: '1h', expiresAt: LIVE / 1000 + 2_520, recacheTokensIfCold: 148_000, hitRatio: 0.93 },
  decision: { action: 'delegate', tier: 'sonnet', effort: 'medium', why: 'cache chaud de 148 k : Opus garde la main, travail confié à un sous-agent Sonnet' },
  keepWarm: { until: LIVE + 7_200_000, pings: 2, lastPingAt: LIVE - 600_000, stopped: null },
  running: [{ id: 't1', tool: 'Bash', label: 'npx vitest run', start: LIVE - 150_000 }],
  agents: [{ id: 'a1', label: 'Survey cache keeper', type: 'general-purpose', status: 'running', firstSeen: LIVE - 200_000 }],
  parallel: { total: 12, overlapped: 4, sequentialReads: 5, agents: 1 },
  repos: [
    { dir: 'C:/Users/me/GitHub/arkanes', name: 'Arkanes', branch: 'main', ahead: 2, behind: 0, dirty: 17, hasUpstream: true },
    { dir: 'C:/Users/me/GitHub/cv-builder', name: 'cv-builder', branch: 'main', ahead: 0, behind: 0, dirty: 0, hasUpstream: true },
  ],
  usedRepos: ['C:/Users/me/GitHub/arkanes'],
  collisions: [{ file: 'ArkButton.tsx', who: 'refonte hub mobile', at: LIVE - 420_000 }],
  goal: { condition: 'les 18 warnings exhaustive-deps corrigés, gates verts', startedAt: LIVE - 1_800_000 },
  tasks: [
    { id: '1', subject: 'Lot A', status: 'completed' },
    { id: '2', subject: 'Lot B', status: 'completed' },
    { id: '3', subject: 'Revue à l’aveugle', status: 'in_progress' },
    { id: '4', subject: 'Commit et push', status: 'pending' },
  ],
}


test('a busy session reads in plain words: cache countdown, keep-warm, goal, collision', async ($, on) => {
  const arrays = ['running', 'spans', 'background', 'agents', 'repos', 'usedRepos', 'collisions', 'tasks']
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const fallback = arrays.includes(key) ? [] : ['lastTurnEnd', 'tick'].includes(key) ? 0 : ['isProjectsOpen', 'isWorking'].includes(key) ? false : null
    return { value: { value: { shape: 'v1', value: key in STATE ? STATE[key] : fallback }, version: 1 } }
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: LIVE }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // the ping 10 min ago holds the cache 50 min more, past the status line's stale 42 min
  for (const words of [/^ {2}50 min$/, /au chaud/, /confié à Sonnet$/, /^2\/4$/, /ArkButton\.tsx · « refonte hub mobile »/, /Bash 2 min · 1 agent/, /148 k \/ 200 k/]) {
    expect((await ui.find({ type: 'Text', text: words }))?.text).toMatch(words)
  }
  // a collision turns the Projets card's key value into ▲ 1
  expect((await ui.find({ type: 'Text', text: /^╭─ Projets ─+ ▲ 1 ─╮$/ }))?.text).toMatch(/▲ 1/)
  await ui.unmount()
})
