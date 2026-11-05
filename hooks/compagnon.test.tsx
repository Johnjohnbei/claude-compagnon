import { expect, test } from 'claude-code/testing'

import type { CacheInfo } from '../types'
import { advise, cacheState, delegationHint, lastSevenDays, parseStatus, recordSample, route, summarizeParallel, touchedRepos } from './logic'

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

const PANE = {
  plugin: 'compagnon',
  component: 'Pane',
  requestId: 'compagnon',
  props: { title: 'Compagnon', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

test('the pane draws its six cards before any measure', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const title of ['Modèle', 'Contexte', 'Forfait', 'Process', 'Parallélisme', 'Projets']) {
    expect((await ui.find({ type: 'Text', text: title }))?.text).toBe(title)
  }
  await ui.unmount()
})
