// The pane's cards. Compact by default (user choice 2026-11-12): one row per subject, its key value, a symbol when it
// needs a look; `e` unfolds every card in full (bordered, title and value in the top border, detail inside). The keys sit
// on one legend line under the cards, not inside them.
import type { AdvisorStat, AgentRow, BackgroundTask, Collision, ErrorEntry, Goal, Handoff, RepoState, RunningTool, TaskRow, Usage, Waiting } from '../types'
import { ACCENT, Card, TONE, gauge, k, strongest, usd, type CardMode, type El, type Tone } from './card-frame'
import { activeAgents, ageLabel, elapsedLabel, errorSummary, goalProgress, lastSevenDays, levelOf, resetLabel, sparkline, type Activity, type DailySamples } from './logic'

/** Long-running thresholds: a tool past 2 min, a background task or an agent past 10 min. */
const TOOL_LONG = 120_000
const TASK_LONG = 600_000
const AGENT_STATUS: Record<string, string> = { running: 'running', waiting: 'waiting', failed: 'failed', pending: 'pending' }

/** `● working · 2m14` while a turn or an agent runs, `✓ done` a few seconds after, nothing otherwise (the status line, Process). */
export function ActivityText(E: El, a: Activity, now: number) {
  const { Text } = E
  if (!a) return null
  return a.state === 'working'
    ? <Text color={ACCENT} wrap="truncate-end">● working · {elapsedLabel(now - a.since)}</Text>
    : <Text wrap="truncate-end">✓ done</Text>
}

/** The one-line band above the prompt: the figures that decide whether to look at the pane. */
export function Band(E: El, label: string, adv: AdvisorStat, totalUsd: number, contextPct: number | null, liveAgents: number, errors = 0) {
  const { Text } = E
  const level = contextPct === null ? 'ok' : levelOf(contextPct)
  // ▲ marks the context that needs a look, as on the cards: the colour alone does not carry the state. ✕ N: the mod's own
  // errors this session, the count only (the Errors row and `/compagnon errors` say which).
  const parts = [label, adv.calls > 0 ? `advisor ${adv.calls}` : null, totalUsd > 0 ? usd(totalUsd) : null, contextPct === null ? null : `${TONE[level].mark}ctx ${Math.round(contextPct)}%`, liveAgents > 0 ? `agents ${liveAgents}` : null, errors > 0 ? `✕ ${errors}` : null]
  return <Text color={TONE[level].color} dimColor={level === 'ok'} wrap="truncate-end">{parts.filter(Boolean).join(' · ')}</Text>
}

export function ContextCard(E: El, width: number, usage: Usage | null, ho: Handoff | null, mode: CardMode) {
  const { Text } = E
  if (!usage) return Card(E, width, 'Context', '…', 'ok', [<Text dimColor>after the first reply</Text>], mode)
  const level = levelOf(usage.contextPct)
  return Card(E, width, 'Context', `${Math.round(usage.contextPct)}%`, level, [
    <Text wrap="truncate-end">
      <Text>{gauge(usage.contextPct)}</Text>
      <Text dimColor>  {k(usage.contextTokens)} / {k(usage.contextWindow)}</Text>
    </Text>,
    ho?.state === 'ready'
      ? <Text color={ACCENT}>● handoff ready: press c</Text>
      : ho?.state === 'writing'
        ? <Text dimColor>↳ handoff being written…</Text>
        : level !== 'ok' ? <Text color={TONE[level].color}>▲ nearly full: /clear or handoff (h)</Text> : null,
  ], { ...mode, note: ho?.state === 'ready' ? 'handoff ready (c)' : null })
}

export function PlanCard(E: El, width: number, usage: Usage | null, samples: DailySamples, now: number, mode: CardMode) {
  const { Text } = E
  const week = (usage?.limits ?? []).find(l => l.kind === 'seven_day')
  if (!week) return Card(E, width, '7-day plan', '…', 'ok', [<Text dimColor>after the first reply</Text>], mode)
  const level = levelOf(week.percentUsed)
  // Today counts at least what the status line reads now, sampled or not yet.
  const days = lastSevenDays(samples, now).map((v, i) => (i === 6 ? Math.max(v, week.percentUsed) : v))
  return Card(E, width, '7-day plan', `${Math.round(week.percentUsed)}%`, level, [
    <Text wrap="truncate-end">
      <Text>{sparkline(days)}</Text>
      <Text dimColor>  {resetLabel(week.resetsAt, now)}</Text>
    </Text>,
  ], mode)
}

export type Work = {
  running: RunningTool[]; tasks: BackgroundTask[]; agents: AgentRow[]; waiting: Waiting | null
  goal: Goal | null; taskList: TaskRow[]; activity: Activity
}

/**
 * Process: what runs now (tools, background tasks, agents, a permission prompt), with the goal (from Goal Meter: `/goal`
 * measured on the native task list) folded in: two cards became one.
 */
export function ProcessCard(E: El, width: number, now: number, w: Work, onStop: (id: string) => void, onView: (id: string) => void, mode: CardMode) {
  const { Box, Text, Button } = E
  // A failed agent is ended, not running: it raises the card and keeps its line, but is no longer counted as running.
  const live = activeAgents(w.agents)
  const failed = w.agents.filter(a => a.status === 'failed')
  const longTools = w.running.filter(t => now - t.start > TOOL_LONG)
  const oldTasks = w.tasks.filter(t => now - t.firstSeen > TASK_LONG)
  const stuck = [...failed, ...live.filter(a => a.status === 'waiting' || now - a.firstSeen > TASK_LONG)]
  const busy = w.running.length + w.tasks.length + live.length
  const tone = strongest(
    failed.length > 0 ? 'error' : 'ok',
    w.waiting ? 'alert' : 'ok',
    longTools.length + oldTasks.length + stuck.length > 0 ? 'warn' : 'ok',
    busy > 0 ? 'active' : 'ok',
  )
  const others = [live.length && `${live.length} agent${live.length > 1 ? 's' : ''}`, w.tasks.length && `${w.tasks.length} in background`].filter(Boolean).join(' · ')
  const summary = w.running[0] ? `${w.running[0].tool} ${ageLabel(now - w.running[0].start)}${others ? ` · ${others}` : ''}` : others || 'nothing running'
  const hasGoal = Boolean(w.goal) || w.taskList.length > 0
  const g = hasGoal ? goalProgress(w.taskList, w.goal?.startedAt ?? now, now) : null
  const current = w.taskList.find(t => t.status === 'in_progress')
  const note = g ? `goal ${g.done}/${g.total}` : null
  // Only what needs a look gets its own line; the rest is in the summary.
  return Card(E, width, 'Process', w.waiting ? 'waiting' : busy ? `${busy} running` : 'idle', tone, [
    ActivityText(E, w.activity, now),
    w.waiting ? <Text color={TONE.alert.color} wrap="truncate-end">▲ {w.waiting.message} · {ageLabel(now - w.waiting.at)}</Text> : <Text dimColor={busy === 0} wrap="truncate-end">{summary}</Text>,
    ...longTools.slice(0, 2).map(t => <Text color={TONE.warn.color} wrap="truncate-end">▲ {t.tool} {t.label} · {ageLabel(now - t.start)}</Text>),
    ...oldTasks.slice(0, 2).map(t => (
      <Box>
        <Text color={TONE.warn.color} wrap="truncate-end">▲ {t.label} · {ageLabel(now - t.firstSeen)} </Text>
        <Button key={`stop-${t.id}`} plain dimColor label="stop" onPress={() => onStop(t.id)} />
      </Box>
    )),
    ...stuck.slice(0, 2).map(a => (
      <Box>
        <Text color={a.status === 'failed' ? TONE.error.color : TONE.warn.color} wrap="truncate-end">{a.status === 'failed' ? '✕' : '▲'} {a.label} · {AGENT_STATUS[a.status] ?? a.status} · {ageLabel(now - a.firstSeen)} </Text>
        <Button key={`view-${a.id}`} plain dimColor label="view" onPress={() => onView(a.id)} />
      </Box>
    )),
    g ? (
      <Text wrap="truncate-end">
        <Text dimColor>goal </Text>{g.done}/{g.total} {gauge(g.pct)}
        <Text>  {current?.subject ?? w.goal?.condition ?? ''}</Text>
        {g.etaMs !== null ? <Text dimColor> · ~{ageLabel(g.etaMs)}</Text> : ''}
      </Text>
    ) : null,
  ], { ...mode, note })
}

/** The mod's own errors this session: the count, then the last message (`/compagnon errors` lists them all). */
export function ErrorsCard(E: El, width: number, errors: ErrorEntry[], mode: CardMode) {
  const { Text } = E
  if (errors.length === 0) return Card(E, width, 'Errors', 'none', 'ok', [<Text dimColor>nothing failed</Text>], mode)
  return Card(E, width, 'Errors', `${errors.length}`, 'error', [
    <Text color={TONE.error.color} wrap="truncate-end">{errorSummary(errors)}</Text>,
    <Text dimColor wrap="truncate-end">/compagnon errors lists them</Text>,
  ], mode)
}

/** Repositories this session touched; the others wait behind a fold (`p`). Collisions come first. */
export function ProjectsCard(E: El, width: number, all: RepoState[], used: string[], clash: Collision[], now: number, isOpen: boolean, mode: CardMode) {
  const { Text } = E
  const repos = all.filter(r => used.includes(r.dir))
  const idle = all.filter(r => !used.includes(r.dir))
  const tone: Tone = clash.length > 0 ? 'alert' : repos.some(r => r.behind > 0 || r.ahead > 0) ? 'warn' : 'ok'
  // The card adds ▲ to any value that needs a look; a collision shows its count in place of the repositories'.
  const value = clash.length ? `${clash.length}` : `${repos.length}${idle.length ? ` +${idle.length}` : ''}`
  const row = (r: RepoState) => (
    <Text wrap="truncate-end">
      <Text bold>{r.name}</Text> <Text dimColor>{r.branch}</Text>
      <Text dimColor>{r.dirty > 0 ? ` · ${r.dirty} changed` : ' · clean'}</Text>
      {r.ahead > 0 && <Text color={TONE.warn.color}> · ↑{r.ahead}</Text>}
      {r.behind > 0 && <Text color={TONE.warn.color}> · ↓{r.behind}</Text>}
    </Text>
  )
  return Card(E, width, 'Projects', value, tone, [
    // Collisions (from Collision Guard): a file this session edited that another open session edited too.
    ...clash.slice(0, 2).map(c => <Text color={TONE.alert.color} wrap="truncate-end">▲ {c.file} · "{c.who}" {ageLabel(now - c.at)}</Text>),
    ...(repos.length ? repos.map(row) : [<Text dimColor>{all.length ? 'no repository touched' : 'reading…'}</Text>]),
    ...(isOpen ? idle.map(r => <Text dimColor wrap="truncate-end">{r.name} {r.branch}</Text>) : []),
  ], { ...mode, note: clash.length ? 'collision' : null })
}

export type Keys = { isAuto: boolean; isKeepWarm: boolean; ho: Handoff | null; hasIdle: boolean; isOpen: boolean; isExpanded: boolean }
export type KeyActions = { expand: () => void; auto: () => void; keepWarm: () => void; handoff: () => void; resume: () => void; refresh: () => void; fold: () => void }

/** The one legend line of keys, under the cards. `p` folds repositories only the unfolded Projects card lists. */
export function KeysLine(E: El, keys: Keys, on: KeyActions) {
  const { Box, Text, Button } = E
  const sep = (n: string) => <Text key={n} dimColor> · </Text>
  const hasFold = keys.hasIdle && keys.isExpanded
  return (
    <Box flexWrap="wrap">
      <Button key="expand" plain dimColor hotkey="e" label={keys.isExpanded ? 'collapse' : 'expand'} onPress={on.expand} />
      {sep('s0')}
      <Button key="auto" plain dimColor hotkey="a" label={keys.isAuto ? 'auto' : 'auto off'} onPress={on.auto} />
      {sep('s1')}
      <Button key="keepwarm" plain dimColor hotkey="k" label={keys.isKeepWarm ? 'stop warming' : 'keep warm'} onPress={on.keepWarm} />
      {sep('s2')}
      {keys.ho?.state === 'ready'
        ? <Button key="continue" plain hotkey="c" label="restart from handoff" onPress={on.resume} />
        : <Button key="handoff" plain dimColor hotkey="h" label="handoff" onPress={on.handoff} />}
      {sep('s3')}
      <Button key="refresh" plain dimColor hotkey="r" label="repos" onPress={on.refresh} />
      {hasFold ? sep('s4') : null}
      {hasFold ? <Button key="fold" plain dimColor hotkey="p" label={keys.isOpen ? 'fold' : 'others'} onPress={on.fold} /> : null}
    </Box>
  )
}
