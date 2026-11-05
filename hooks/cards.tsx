// The pane's cards, compact: one line per concern when all is well, detail lines only when something needs a look.
// A coloured dot carries the state (green, orange, red); no borders, no margins.
import type { Elements, RenderChildren } from 'claude-code'

import type { AgentRow, BackgroundTask, CacheInfo, Decision, Level, ParallelSummary, Pin, RepoState, RunningTool, Usage, Waiting } from '../types'
import { TIER_LABEL, ageLabel, bar, lastSevenDays, levelOf, resetLabel, sparkline, tierOf, type DailySamples } from './logic'

export type El = Pick<Elements[keyof Elements], 'Box' | 'Text' | 'Button'>

const COLOR: Record<Level, string> = { ok: 'success', warn: 'warning', alert: 'error' }
const TITLE_WIDTH = 13
const BAR = 8

/** Long-running thresholds: a tool past 2 min, a background task or an agent past 10 min. */
const TOOL_LONG = 120_000
const TASK_LONG = 600_000

/** One concern: dot, title, a one-line summary, then optional detail lines under the summary. */
function Card(E: El, title: string, level: Level, summary: RenderChildren, details: RenderChildren[] = []) {
  const { Box, Text } = E
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLOR[level]}>● </Text>
        <Box width={TITLE_WIDTH} flexShrink={0}>
          <Text bold>{title}</Text>
        </Box>
        <Box flexShrink={1}>{summary}</Box>
      </Box>
      {details.filter(Boolean).map(d => (
        <Box paddingLeft={2 + TITLE_WIDTH}>{d}</Box>
      ))}
    </Box>
  )
}

const ACTION_STATE: Record<Decision['action'], [Level, string]> = {
  switch: ['ok', 'basculé'],
  delegate: ['warn', 'délégué'],
  keep: ['ok', 'adapté'],
}

export function ModelCard(E: El, usage: Usage | null, d: Decision | null, pin: Pin | null, cache: CacheInfo | null, now: number, isAuto: boolean, onToggle: () => void) {
  const { Text, Button } = E
  const current = pin ? pin.tier : tierOf(usage?.model ?? 'opus')
  const [level, state] = !isAuto ? (['ok', 'auto coupé'] as [Level, string]) : d ? ACTION_STATE[d.action] : (['ok', 'auto'] as [Level, string])
  const expires = cache?.expiresAt ? cache.expiresAt * 1000 - now : null
  const cacheLine = cache
    ? `cache ${cache.warm ? 'chaud' : 'froid'}${expires && expires > 0 ? ` ${ageLabel(expires)}` : ''}${cache.hitRatio !== null ? ` · ${Math.round(cache.hitRatio * 100)} % lu` : ''}`
    : 'cache : règle des 1 h'
  return Card(E, 'Modèle', level, (
    <Text wrap="truncate-end">
      {TIER_LABEL[current]}
      {pin ? ` ${pin.effort}` : ''} <Text color={COLOR[level]}>{state}</Text>
    </Text>
  ), [
    <Text dimColor wrap="truncate-end">{cacheLine}</Text>,
    d && d.action !== 'keep' ? <Text dimColor wrap="truncate-end">{d.why}</Text> : null,
    <Button key="auto" plain dimColor hotkey="a" label={isAuto ? 'couper l’auto' : 'réactiver l’auto'} onPress={onToggle} />,
  ])
}

export function ContextCard(E: El, usage: Usage | null) {
  const { Text } = E
  if (!usage) return Card(E, 'Contexte', 'ok', <Text dimColor>après la 1re réponse</Text>)
  const level = levelOf(usage.contextPct)
  return Card(E, 'Contexte', level, (
    <Text wrap="truncate-end">
      <Text color={COLOR[level]}>{bar(usage.contextPct, BAR)}</Text> {Math.round(usage.contextPct)} %{' '}
      <Text dimColor>
        {Math.round(usage.contextTokens / 1000)}/{Math.round(usage.contextWindow / 1000)} k
      </Text>
    </Text>
  ), [level !== 'ok' ? <Text color="warning">nouveau sujet : /clear (gratuit)</Text> : null])
}

export function PlanCard(E: El, usage: Usage | null, samples: DailySamples, now: number) {
  const { Text } = E
  const limits = usage?.limits ?? []
  const week = limits.find(l => l.kind === 'seven_day')
  if (!week) return Card(E, 'Forfait', 'ok', <Text dimColor>après la 1re réponse</Text>)
  const level = levelOf(week.percentUsed)
  return Card(E, 'Forfait', level, (
    <Text wrap="truncate-end">
      <Text color={COLOR[level]}>7 j {Math.round(week.percentUsed)} %</Text> <Text color="suggestion">{sparkline(lastSevenDays(samples, now))}</Text>
    </Text>
  ), [level !== 'ok' ? <Text dimColor wrap="truncate-end">{resetLabel(week.resetsAt, now)}</Text> : null])
}

export function ProcessCard(E: El, now: number, running: RunningTool[], tasks: BackgroundTask[], agents: AgentRow[], waiting: Waiting | null, onStop: (id: string) => void, onView: (id: string) => void) {
  const { Box, Text, Button } = E
  const live = agents.filter(a => a.status !== 'completed' && a.status !== 'killed')
  const longTools = running.filter(t => now - t.start > TOOL_LONG)
  const oldTasks = tasks.filter(t => now - t.firstSeen > TASK_LONG)
  const stuck = live.filter(a => a.status === 'failed' || a.status === 'waiting' || now - a.firstSeen > TASK_LONG)
  const level: Level = waiting || live.some(a => a.status === 'failed') ? 'alert' : longTools.length + oldTasks.length + stuck.length > 0 ? 'warn' : 'ok'
  const counts = [running.length && `${running.length} outil${running.length > 1 ? 's' : ''}`, tasks.length && `${tasks.length} en fond`, live.length && `${live.length} agent${live.length > 1 ? 's' : ''}`].filter(Boolean).join(' · ')
  const summary = waiting ? 'attend ta réponse' : level === 'ok' ? counts || 'rien en cours' : `à vérifier · ${counts}`
  // Only what needs a look gets a line: the rest is in the count.
  return Card(E, 'Process', level, <Text color={level === 'ok' ? undefined : COLOR[level]} wrap="truncate-end">{summary}</Text>, [
    waiting ? <Text color="error" wrap="truncate-end">{waiting.message} · {ageLabel(now - waiting.at)}</Text> : null,
    ...longTools.map(t => <Text color="warning" wrap="truncate-end">{t.tool} {t.label} · {ageLabel(now - t.start)}</Text>),
    ...oldTasks.map(t => (
      <Box>
        <Text color="warning" wrap="truncate-end">{t.label} · {ageLabel(now - t.firstSeen)} </Text>
        <Button key={`stop-${t.id}`} plain dimColor label="arrêter" onPress={() => onStop(t.id)} />
      </Box>
    )),
    ...stuck.map(a => (
      <Box>
        <Text color={a.status === 'failed' ? 'error' : 'warning'} wrap="truncate-end">{a.label} {a.status} · {ageLabel(now - a.firstSeen)} </Text>
        <Button key={`view-${a.id}`} plain dimColor label="voir" onPress={() => onView(a.id)} />
      </Box>
    )),
  ])
}

export function ParallelCard(E: El, p: ParallelSummary | null) {
  const { Text } = E
  if (!p || p.total === 0) return Card(E, 'Parallélisme', 'ok', <Text dimColor>bilan en fin de tour</Text>)
  const level: Level = p.sequentialReads >= 6 ? 'alert' : p.sequentialReads >= 4 ? 'warn' : 'ok'
  return Card(E, 'Parallélisme', level, (
    <Text wrap="truncate-end">
      {p.overlapped}/{p.total} en parallèle{p.agents ? ` · ${p.agents} agents` : ''}
    </Text>
  ), [level !== 'ok' ? <Text color={COLOR[level]} wrap="truncate-end">{p.sequentialReads} lectures en série : grouper ou déléguer</Text> : null])
}

/** Repositories this session touched come first; the others wait behind a fold (`p`). */
export function ProjectsCard(E: El, all: RepoState[], used: string[], isOpen: boolean, onFold: () => void, onRefresh: () => void) {
  const { Box, Text, Button } = E
  const repos = all.filter(r => used.includes(r.dir))
  const idle = all.filter(r => !used.includes(r.dir))
  const level: Level = repos.some(r => r.behind > 0 || r.ahead > 0) ? 'warn' : 'ok'
  const row = (r: RepoState) => (
    <Text wrap="truncate-end">
      {r.name} <Text dimColor>{r.branch}</Text>
      {r.dirty > 0 && <Text dimColor> · {r.dirty} modif</Text>}
      {r.ahead > 0 && <Text color="warning"> ↑{r.ahead}</Text>}
      {r.behind > 0 && <Text color="error"> ↓{r.behind}</Text>}
    </Text>
  )
  const [first, ...rest] = repos
  return Card(E, 'Projets', level, (
    <Box>
      {first ? row(first) : <Text dimColor>{all.length ? 'aucun touché' : 'lecture…'}</Text>}
      <Text> </Text>
      <Button key="refresh" plain dimColor hotkey="r" label="maj" onPress={onRefresh} />
    </Box>
  ), [
    ...rest.map(row),
    ...(isOpen ? idle.map(r => <Text dimColor wrap="truncate-end">{r.name} {r.branch}</Text>) : []),
    idle.length > 0 ? <Button key="fold" plain dimColor hotkey="p" label={isOpen ? 'replier' : `+${idle.length} autres`} onPress={onFold} /> : null,
  ])
}
