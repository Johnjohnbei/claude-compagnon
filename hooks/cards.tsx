// The pane's cards: stacked rounded cards, the title and the key figure set in the top border, one or two lines
// inside, detail only when it needs a look (user choice 2026-11-05, "cards empilées"). The keys sit on one legend
// line under the cards, not inside them.
import type { Elements, RenderChildren } from 'claude-code'

import type { AdvisorStat, AgentRow, BackgroundTask, CacheInfo, CacheVerdict, Collision, CtxPart, Decision, Goal, Handoff, KeepWarm, Level, LogEntry, LogKind, ParallelSummary, Pin, RepoState, RunningTool, SeenModels, TaskRow, TurnCost, Usage, Waiting } from '../types'
import { TIER_NAME, ageLabel, costSummary, goalProgress, lastSevenDays, levelOf, modelLabel, resetLabel, sparkline, tierOf, type DailySamples } from './logic'

export type El = Pick<Elements[keyof Elements], 'Box' | 'Text' | 'Button'>

const COLOR: Record<Level, string> = { ok: 'success', warn: 'warning', alert: 'error' }
const GAUGE = 10

/** Long-running thresholds: a tool past 2 min, a background task or an agent past 10 min. */
const TOOL_LONG = 120_000
const TASK_LONG = 600_000

const k = (tokens: number) => `${Math.round(tokens / 1000)} k`
const usd = (n: number) => `${n.toFixed(2).replace('.', ',')} $`
const hhmm = (at: number) => new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
const DAY = 86_400_000
const PART_NAME: Record<string, string> = { 'System prompt': 'prompt', 'System tools': 'outils', 'MCP server instructions': 'MCP', 'Custom agents': 'agents', Skills: 'skills', Messages: 'messages', 'Memory files': 'mémoire' }
const KIND_NAME: Record<LogKind, string> = { route: 'route', advisor: 'advisor', spawn: 'agent', release: 'modèle' }
const AGENT_STATUS: Record<string, string> = { running: 'en cours', waiting: 'attend', failed: 'en échec', pending: 'en attente' }

/** `▰▰▰▰▰▰▱▱▱▱`: a thin gauge. */
export const gauge = (pct: number, width = GAUGE): string => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

/**
 * One card, `width` columns wide: `╭─ Title ──── value ─╮`, its lines between `│ … │`, then `╰───╯`.
 * The border stays quiet (dim) while all is well and takes the state's colour otherwise.
 */
function Card(E: El, width: number, title: string, value: string, level: Level, lines: RenderChildren[]) {
  const { Box, Text } = E
  const w = Math.max(24, width)
  const border = level === 'ok' ? undefined : COLOR[level]
  const fill = Math.max(1, w - title.length - value.length - 8)
  return (
    <Box flexDirection="column" width={w}>
      <Text wrap="truncate-end">
        <Text color={border} dimColor={!border}>╭─ </Text>
        <Text bold>{title}</Text>
        <Text color={border} dimColor={!border}> {'─'.repeat(fill)} </Text>
        <Text color={border} bold>{value}</Text>
        <Text color={border} dimColor={!border}> ─╮</Text>
      </Text>
      {lines.filter(Boolean).map(l => (
        <Box width={w}>
          <Text color={border} dimColor={!border}>│ </Text>
          <Box width={w - 4} flexShrink={0}>{l}</Box>
          <Text color={border} dimColor={!border}> │</Text>
        </Box>
      ))}
      <Text color={border} dimColor={!border}>╰{'─'.repeat(w - 2)}╯</Text>
    </Box>
  )
}

/** `warmLeft`: time the cache stays warm, keep-warm pings included (the status line's figure goes stale after one). */
export function ModelCard(E: El, width: number, usage: Usage | null, d: Decision | null, pin: Pin | null, cache: CacheInfo | null, verdict: CacheVerdict, kw: KeepWarm | null, warmLeft: number | null, ttl: number, isAuto: boolean) {
  const { Text } = E
  const current = pin ? pin.tier : tierOf(usage?.model ?? 'opus')
  // The version comes from the id the engine reports, and only while it names the tier shown: otherwise the tier alone.
  const shown = usage && tierOf(usage.model) === current ? modelLabel(usage.model) : TIER_NAME[current]
  const level: Level = verdict.isCold || kw?.stopped ? 'warn' : 'ok'
  const cacheLine = verdict.isCold ? (
    <Text color="warning" wrap="truncate-end">cache froid · relit {k(verdict.recache)}</Text>
  ) : warmLeft !== null && warmLeft > 0 ? (
    <Text wrap="truncate-end">
      <Text dimColor>cache </Text>
      <Text color="success">{gauge((warmLeft / ttl) * 100)}</Text>
      <Text>  {ageLabel(warmLeft)}</Text>
      <Text dimColor> · {k(verdict.recache)}{kw && !kw.stopped ? ' · au chaud' : ''}</Text>
    </Text>
  ) : (
    <Text dimColor wrap="truncate-end">cache {cache ? 'chaud' : 'estimé'} · {k(verdict.recache)}</Text>
  )
  const detail = kw?.stopped
    ? <Text color="warning" wrap="truncate-end">↳ maintien arrêté : {kw.stopped}</Text>
    : !isAuto
      ? <Text dimColor>↳ choix automatique coupé</Text>
      : d && d.action !== 'keep'
        ? <Text dimColor wrap="truncate-end">↳ {d.action === 'switch' ? 'basculé sur' : 'confié à'} {TIER_NAME[d.tier]}</Text>
        : null
  return Card(E, width, 'Modèle', shown, level, [cacheLine, detail])
}

/** The model ids behind the tiers (read from what the engine reported), the advisor's calls, and a release when an alias moved. */
export function ModelsCard(E: El, width: number, seen: SeenModels, adv: AdvisorStat, journal: LogEntry[], now: number) {
  const { Text } = E
  const ids = (['fable', 'opus', 'sonnet', 'haiku'] as const).filter(t => seen[t]).map(t => modelLabel(seen[t] as string))
  const release = [...journal].reverse().find(l => l.kind === 'release' && now - l.at < DAY)
  return Card(E, width, 'Modèles', adv.calls > 0 ? `advisor ${adv.calls}` : '—', release ? 'warn' : 'ok', [
    ids.length > 0 ? <Text wrap="truncate-end">{ids.join(' · ')}</Text> : <Text dimColor>versions lues après le premier tour</Text>,
    adv.calls > 0 ? <Text dimColor wrap="truncate-end">↳ dernier appel il y a {ageLabel(now - adv.lastAt)} (conseil chiffré)</Text> : null,
    release ? <Text color="warning" wrap="truncate-end">↳ nouvelle version : {release.text}</Text> : null,
  ])
}

/** What the turns cost, and the share of the turns where the advisor was consulted: the figure that says whether it pays. */
export function CostCard(E: El, width: number, turns: TurnCost[]) {
  const { Text } = E
  if (turns.length === 0) return Card(E, width, 'Coût', '…', 'ok', [<Text dimColor>après le premier tour</Text>])
  const s = costSummary(turns)
  const isHeavy = s.advisorTurns > 0 && s.advisorShare >= 0.5
  return Card(E, width, 'Coût', usd(s.totalUsd), isHeavy ? 'warn' : 'ok', [
    <Text wrap="truncate-end">{s.turns} tours <Text dimColor>· moy. {usd(s.avgUsd)}</Text></Text>,
    s.advisorTurns > 0
      ? <Text color={isHeavy ? 'warning' : undefined} dimColor={!isHeavy} wrap="truncate-end">↳ advisor : {s.advisorTurns} tour{s.advisorTurns > 1 ? 's' : ''}, ~{usd(s.advisorUsd)} ({Math.round(s.advisorShare * 100)} %, estimation)</Text>
      : null,
  ])
}

/** What the session loads before the first word (tools, skills, agents, prompt): the figure a lighter CLAUDE.md moves. */
export function LoadCard(E: El, width: number, parts: CtxPart[]) {
  const { Text } = E
  if (parts.length === 0) return Card(E, width, 'Charge', '…', 'ok', [<Text dimColor>après le premier tour</Text>])
  const fixed = parts.filter(p => p.name !== 'Messages')
  const messages = parts.find(p => p.name === 'Messages')
  return Card(E, width, 'Charge', k(fixed.reduce((s, p) => s + p.tokens, 0)), 'ok', [
    <Text wrap="truncate-end">{fixed.map(p => `${PART_NAME[p.name] ?? p.name.toLowerCase()} ${k(p.tokens)}`).join(' · ')}</Text>,
    messages ? <Text dimColor>↳ conversation {k(messages.tokens)}</Text> : null,
  ])
}

/** The last things the mod decided or saw, newest last. */
export function JournalCard(E: El, width: number, list: LogEntry[]) {
  const { Text } = E
  return Card(E, width, 'Journal', `${list.length}`, 'ok', list.length === 0
    ? [<Text dimColor>rien pour l’instant</Text>]
    : list.slice(-6).map(l => (
      <Text wrap="truncate-end">
        <Text dimColor>{hhmm(l.at)} {KIND_NAME[l.kind].padEnd(7)}</Text>
        <Text>{l.text}</Text>
      </Text>
    )))
}

/** The one-line band above the prompt: the figures that decide whether to look at the pane. */
export function Band(E: El, label: string, adv: AdvisorStat, totalUsd: number, contextPct: number | null, liveAgents: number) {
  const { Text } = E
  const level = contextPct === null ? 'ok' : levelOf(contextPct)
  const parts = [label, adv.calls > 0 ? `advisor ${adv.calls}` : null, totalUsd > 0 ? usd(totalUsd) : null, contextPct === null ? null : `ctx ${Math.round(contextPct)} %`, liveAgents > 0 ? `agents ${liveAgents}` : null]
  return <Text color={level === 'ok' ? undefined : COLOR[level]} dimColor={level === 'ok'} wrap="truncate-end">{parts.filter(Boolean).join(' · ')}</Text>
}

export function ContextCard(E: El, width: number, usage: Usage | null, ho: Handoff | null) {
  const { Text } = E
  if (!usage) return Card(E, width, 'Contexte', '…', 'ok', [<Text dimColor>après la première réponse</Text>])
  const level = levelOf(usage.contextPct)
  return Card(E, width, 'Contexte', `${Math.round(usage.contextPct)} %`, level, [
    <Text wrap="truncate-end">
      <Text color={COLOR[level]}>{gauge(usage.contextPct)}</Text>
      <Text dimColor>  {k(usage.contextTokens)} / {k(usage.contextWindow)}</Text>
    </Text>,
    ho?.state === 'ready'
      ? <Text color="success">↳ handoff prêt : touche c</Text>
      : ho?.state === 'writing'
        ? <Text dimColor>↳ handoff en cours d’écriture…</Text>
        : level !== 'ok' ? <Text color={COLOR[level]}>↳ bientôt plein : /clear ou handoff (h)</Text> : null,
  ])
}

export function PlanCard(E: El, width: number, usage: Usage | null, samples: DailySamples, now: number) {
  const { Text } = E
  const week = (usage?.limits ?? []).find(l => l.kind === 'seven_day')
  if (!week) return Card(E, width, 'Forfait 7 j', '…', 'ok', [<Text dimColor>après la première réponse</Text>])
  const level = levelOf(week.percentUsed)
  // Today counts at least what the status line reads now, sampled or not yet.
  const days = lastSevenDays(samples, now).map((v, i) => (i === 6 ? Math.max(v, week.percentUsed) : v))
  return Card(E, width, 'Forfait 7 j', `${Math.round(week.percentUsed)} %`, level, [
    <Text wrap="truncate-end">
      <Text color="suggestion">{sparkline(days)}</Text>
      <Text dimColor>  {resetLabel(week.resetsAt, now)}</Text>
    </Text>,
  ])
}

/** Goal (from Goal Meter): `/goal` measured on the native task list; no card while there is neither goal nor task. */
export function GoalCard(E: El, width: number, g: Goal | null, list: TaskRow[], now: number) {
  const { Text } = E
  if (!g && list.length === 0) return null
  const p = goalProgress(list, g?.startedAt ?? now, now)
  const current = list.find(t => t.status === 'in_progress')
  return Card(E, width, 'Objectif', `${p.done}/${p.total}`, 'ok', [
    <Text wrap="truncate-end">
      <Text color="suggestion">{gauge(p.pct)}</Text>
      <Text>  {current?.subject ?? g?.condition ?? ''}</Text>
      {p.etaMs !== null ? <Text dimColor> · ~{ageLabel(p.etaMs)}</Text> : ''}
    </Text>,
  ])
}

export function ProcessCard(E: El, width: number, now: number, running: RunningTool[], tasks: BackgroundTask[], agents: AgentRow[], waiting: Waiting | null, onStop: (id: string) => void, onView: (id: string) => void) {
  const { Box, Text, Button } = E
  const live = agents.filter(a => a.status !== 'completed' && a.status !== 'killed')
  const longTools = running.filter(t => now - t.start > TOOL_LONG)
  const oldTasks = tasks.filter(t => now - t.firstSeen > TASK_LONG)
  const stuck = live.filter(a => a.status === 'failed' || a.status === 'waiting' || now - a.firstSeen > TASK_LONG)
  const level: Level = waiting || live.some(a => a.status === 'failed') ? 'alert' : longTools.length + oldTasks.length + stuck.length > 0 ? 'warn' : 'ok'
  const busy = running.length + tasks.length + live.length
  const others = [live.length && `${live.length} agent${live.length > 1 ? 's' : ''}`, tasks.length && `${tasks.length} en fond`].filter(Boolean).join(' · ')
  const summary = running[0] ? `${running[0].tool} ${ageLabel(now - running[0].start)}${others ? ` · ${others}` : ''}` : others || 'rien en cours'
  // Only what needs a look gets its own line; the rest is in the summary.
  return Card(E, width, 'Process', waiting ? 'attend' : busy ? `${busy} en cours` : 'calme', level, [
    waiting ? <Text color="error" wrap="truncate-end">{waiting.message} · {ageLabel(now - waiting.at)}</Text> : <Text dimColor={level === 'ok'} wrap="truncate-end">{summary}</Text>,
    ...longTools.slice(0, 2).map(t => <Text color="warning" wrap="truncate-end">↳ {t.tool} {t.label} · {ageLabel(now - t.start)}</Text>),
    ...oldTasks.slice(0, 2).map(t => (
      <Box>
        <Text color="warning" wrap="truncate-end">↳ {t.label} · {ageLabel(now - t.firstSeen)} </Text>
        <Button key={`stop-${t.id}`} plain dimColor label="arrêter" onPress={() => onStop(t.id)} />
      </Box>
    )),
    ...stuck.slice(0, 2).map(a => (
      <Box>
        <Text color={a.status === 'failed' ? 'error' : 'warning'} wrap="truncate-end">↳ {a.label} · {AGENT_STATUS[a.status] ?? a.status} · {ageLabel(now - a.firstSeen)} </Text>
        <Button key={`view-${a.id}`} plain dimColor label="voir" onPress={() => onView(a.id)} />
      </Box>
    )),
  ])
}

export function ParallelCard(E: El, width: number, p: ParallelSummary | null) {
  const { Text } = E
  if (!p || p.total === 0) return Card(E, width, 'Parallélisme', '…', 'ok', [<Text dimColor>bilan en fin de tour</Text>])
  const level: Level = p.sequentialReads >= 6 ? 'alert' : p.sequentialReads >= 4 ? 'warn' : 'ok'
  return Card(E, width, 'Parallélisme', `${p.overlapped}/${p.total}`, level, [
    <Text wrap="truncate-end">
      <Text color={COLOR[level]}>{gauge((p.overlapped / p.total) * 100)}</Text>
      <Text dimColor>  {level === 'ok' ? 'en même temps' : `${p.sequentialReads} lectures en série`}</Text>
    </Text>,
  ])
}

/** Repositories this session touched; the others wait behind a fold (`p`). Collisions come first. */
export function ProjectsCard(E: El, width: number, all: RepoState[], used: string[], clash: Collision[], now: number, isOpen: boolean) {
  const { Text } = E
  const repos = all.filter(r => used.includes(r.dir))
  const idle = all.filter(r => !used.includes(r.dir))
  const level: Level = clash.length > 0 ? 'alert' : repos.some(r => r.behind > 0 || r.ahead > 0) ? 'warn' : 'ok'
  const value = clash.length ? `▲ ${clash.length}` : `${repos.length}${idle.length ? ` +${idle.length}` : ''}`
  const row = (r: RepoState) => (
    <Text wrap="truncate-end">
      <Text bold>{r.name}</Text> <Text color="suggestion">{r.branch}</Text>
      <Text dimColor>{r.dirty > 0 ? ` · ${r.dirty} modif` : ' · propre'}</Text>
      {r.ahead > 0 && <Text color="warning"> · ↑{r.ahead}</Text>}
      {r.behind > 0 && <Text color="error"> · ↓{r.behind}</Text>}
    </Text>
  )
  return Card(E, width, 'Projets', value, level, [
    // Collisions (from Collision Guard): a file this session edited that another open session edited too.
    ...clash.slice(0, 2).map(c => <Text color="error" wrap="truncate-end">▲ {c.file} · « {c.who} » {ageLabel(now - c.at)}</Text>),
    ...(repos.length ? repos.map(row) : [<Text dimColor>{all.length ? 'aucun dépôt touché' : 'lecture…'}</Text>]),
    ...(isOpen ? idle.map(r => <Text dimColor wrap="truncate-end">{r.name} {r.branch}</Text>) : []),
  ])
}

export type Keys = { isAuto: boolean; isKeepWarm: boolean; ho: Handoff | null; hasIdle: boolean; isOpen: boolean }
export type KeyActions = { auto: () => void; keepWarm: () => void; handoff: () => void; resume: () => void; refresh: () => void; fold: () => void }

/** The one legend line of keys, under the cards. */
export function KeysLine(E: El, keys: Keys, on: KeyActions) {
  const { Box, Text, Button } = E
  const sep = (n: string) => <Text key={n} dimColor> · </Text>
  return (
    <Box flexWrap="wrap">
      <Button key="auto" plain dimColor hotkey="a" label={keys.isAuto ? 'auto' : 'auto coupé'} onPress={on.auto} />
      {sep('s1')}
      <Button key="keepwarm" plain dimColor hotkey="k" label={keys.isKeepWarm ? 'arrêter le chaud' : 'garder au chaud'} onPress={on.keepWarm} />
      {sep('s2')}
      {keys.ho?.state === 'ready'
        ? <Button key="continue" plain hotkey="c" label="repartir du handoff" onPress={on.resume} />
        : <Button key="handoff" plain dimColor hotkey="h" label="handoff" onPress={on.handoff} />}
      {sep('s3')}
      <Button key="refresh" plain dimColor hotkey="r" label="dépôts" onPress={on.refresh} />
      {keys.hasIdle ? sep('s4') : null}
      {keys.hasIdle ? <Button key="fold" plain dimColor hotkey="p" label={keys.isOpen ? 'replier' : 'autres'} onPress={on.fold} /> : null}
    </Box>
  )
}
