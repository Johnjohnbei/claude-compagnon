// The pane's cards. Compact by default (user choice 2026-11-12): one row per subject, its key value, a symbol when it
// needs a look; `e` unfolds every card in full (bordered, title and value in the top border, detail inside). The keys sit
// on one legend line under the cards, not inside them.
import type { AdvisorStat, Collision, ErrorEntry, Handoff, RepoState, Usage } from '../types'
import { Card, TONE, gauge, k, usd, type CardMode, type El, type Tone } from './card-frame'
import { ageLabel, errorSummary, lastSevenDays, levelOf, resetLabel, sparkline, type DailySamples } from './logic'

/** The one-line band above the prompt: the figures that decide whether to look at the pane. */
export function Band(E: El, label: string, adv: AdvisorStat, totalUsd: number, contextPct: number | null, liveAgents: number, errors = 0, isWaiting = false) {
  const { Text } = E
  const level = contextPct === null ? 'ok' : levelOf(contextPct)
  // ▲ marks the context that needs a look, as on the cards: the colour alone does not carry the state. ✕ N: the mod's own
  // errors this session, the count only (the Errors row and `/compagnon errors` say which).
  const parts = [label, adv.calls > 0 ? `advisor ${adv.calls}` : null, totalUsd > 0 ? usd(totalUsd) : null, contextPct === null ? null : `${TONE[level].mark}ctx ${Math.round(contextPct)}%`, isWaiting ? null : liveAgents > 0 ? `agents ${liveAgents}` : null, errors > 0 ? `✕ ${errors}` : null]
  // A session that waits for the person says so in amber, in place of the agents: the one thing the band must not hide.
  return (
    <Text wrap="truncate-end">
      <Text color={TONE[level].color} dimColor={level === 'ok'}>{parts.filter(Boolean).join(' · ')}</Text>
      {isWaiting ? <Text color={TONE.alert.color} bold>{parts.length > 0 ? ' · ' : ''}? waiting for you</Text> : null}
    </Text>
  )
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
    // A ready handoff and a nearly full window are asked of you in FOR YOU, not here.
    ho?.state === 'writing' ? <Text dimColor>↳ handoff being written…</Text> : null,
  ], { ...mode, note: `${k(usage.contextTokens)} / ${k(usage.contextWindow)}` })
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
  ], { ...mode, note: `${sparkline(days)} · ${resetLabel(week.resetsAt, now)}` })
}

/** The mod's own errors this session: the count, then the last message (`/compagnon errors` lists them all). */
export function ErrorsCard(E: El, width: number, errors: ErrorEntry[], mode: CardMode) {
  const { Text } = E
  if (errors.length === 0) return Card(E, width, 'Errors', 'none', 'ok', [<Text dimColor>nothing failed</Text>], mode)
  return Card(E, width, 'Errors', `${errors.length}`, 'error', [
    <Text color={TONE.error.color} wrap="truncate-end">{errorSummary(errors)}</Text>,
    <Text dimColor wrap="truncate-end">/compagnon errors lists them</Text>,
  ], { ...mode, note: errors[errors.length - 1]?.message ?? null })
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
  ], { ...mode, note: clash.length ? 'collision' : repos[0] ? `${repos[0].name} ${repos[0].branch}${repos[0].dirty > 0 ? ` · ${repos[0].dirty} changed` : ''}${repos[0].ahead > 0 ? ` ↑${repos[0].ahead}` : ''}${repos[0].behind > 0 ? ` ↓${repos[0].behind}` : ''}` : null })
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
