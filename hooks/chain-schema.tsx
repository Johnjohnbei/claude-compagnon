// The chain, in the pane's Model slot: advisor, main session, decision layer, scouts, journal and status line (README).
// Folded by default to the Model row, the status line's figures in its note; `e` unfolds it.
import type { RenderChildren } from 'claude-code'

import type { AdvisorStat, AgentRow, CacheInfo, CacheVerdict, CtxPart, Decision, KeepWarm, Level, LogEntry, LogKind, Pin, RouteRecord, SeenModels, Tier, TurnCost, Usage } from '../types'
import { ACCENT, Card, TONE, gauge, k, plural, usd, type CardMode, type El, type Tone } from './card-frame'
import { TIER_NAME, TIERS_STRONGEST_FIRST, modelLabel, tierOf } from './tiers'
import { SOURCE_NAME } from './request-routing'
import { activeAgents, ageLabel, clockLabel, costSummary, isFinished } from './logic'

const hhmm = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const DAY = 86_400_000
const PART_NAME: Record<string, string> = { 'System prompt': 'prompt', 'System tools': 'tools', 'MCP server instructions': 'MCP', 'Custom agents': 'agents', Skills: 'skills', Messages: 'messages', 'Memory files': 'memory' }
const KIND_NAME: Record<LogKind, string> = { route: 'route', advisor: 'advisor', spawn: 'agent', release: 'model' }

/** The model the main loop runs on: the pin, else the session's own. The version comes from the id the engine reports, and only while it names the tier shown: otherwise the tier alone. */
export function shownModel(usage: Usage | null, pin: Pin | null): { current: Tier; shown: string } {
  const current = pin ? pin.tier : tierOf(usage?.model ?? '')
  return { current, shown: usage && tierOf(usage.model) === current ? modelLabel(usage.model) : TIER_NAME[current] }
}

export function ModelCard(E: El, width: number, usage: Usage | null, d: Decision | null, pin: Pin | null, cache: CacheInfo | null, verdict: CacheVerdict, kw: KeepWarm | null, warmLeft: number | null, ttl: number, isAuto: boolean, extra: RenderChildren[], mode: CardMode) {
  const { Text } = E
  const { shown } = shownModel(usage, pin)
  const level: Level = verdict.isCold || kw?.stopped ? 'warn' : 'ok'
  const cacheLine = verdict.isCold ? (
    <Text color={TONE.warn.color} wrap="truncate-end">▲ cold cache · rereads {k(verdict.recache)}</Text>
  ) : warmLeft !== null && warmLeft > 0 ? (
    <Text wrap="truncate-end">
      <Text dimColor>cache </Text>
      <Text>{gauge((warmLeft / ttl) * 100)}</Text>
      <Text>  {ageLabel(warmLeft)}</Text>
      <Text dimColor> · {k(verdict.recache)}</Text>
      {kw && !kw.stopped ? <Text color={ACCENT}> · ● kept warm</Text> : null}
    </Text>
  ) : (
    <Text dimColor wrap="truncate-end">cache {cache ? 'warm' : 'estimated'} · {k(verdict.recache)}</Text>
  )
  const detail = kw?.stopped
    ? <Text color={TONE.warn.color} wrap="truncate-end">▲ keep-warm stopped: {kw.stopped}</Text>
    : !isAuto
      ? <Text dimColor>↳ automatic choice off</Text>
      : d && d.action !== 'keep'
        ? <Text dimColor wrap="truncate-end">↳ {d.action === 'switch' ? 'switched to' : 'handed to'} {TIER_NAME[d.tier]}</Text>
        : null
  return Card(E, width, 'Model', shown, level, [cacheLine, detail, ...extra], mode)
}

/** The last things the mod decided or saw, newest last. */
export function JournalCard(E: El, width: number, list: LogEntry[]) {
  const { Text } = E
  return Card(E, width, 'Log', `${list.length}`, 'ok', list.length === 0
    ? [<Text dimColor>nothing yet</Text>]
    : list.slice(-6).map(l => (
      <Text wrap="truncate-end">
        <Text dimColor>{hhmm(l.at)} {KIND_NAME[l.kind].padEnd(8)}</Text>
        <Text>{l.text}</Text>
      </Text>
    )))
}

const ACTION_TEXT: Record<RouteRecord['action'], string> = { keep: 'keeps the model', switch: 'switches to this tier', delegate: 'hands to a subagent' }
/** The named scouts of ~/.claude/agents, and what each is for. */
const SCOUTS: Array<[string, string, string]> = [['search', 'maps the repository', 'map'], ['grep', 'call sites', 'calls'], ['audit', 'diff review, worktree', 'review']]

/** One scout's state: running (and for how long), finished (and how long it ran), failed, or idle. The API gives no progress: no percentage. */
function scoutState(list: AgentRow[], type: string, now: number): { mark: string; time: string; tone: Tone; isIdle: boolean } {
  const last = list.filter(a => a.type === type).sort((a, b) => b.firstSeen - a.firstSeen)[0]
  if (!last) return { mark: '·', time: 'idle', tone: 'ok', isIdle: true }
  if (!isFinished(last.status)) return { mark: '●', time: clockLabel(now - last.firstSeen), tone: 'active', isIdle: false }
  const time = clockLabel((last.endedAt ?? now) - last.firstSeen)
  return last.status === 'completed' ? { mark: '✓', time, tone: 'ok', isIdle: false } : { mark: '✕', time, tone: 'error', isIdle: false }
}

/** The advisor: how often it was consulted and what that costs. Its advice is encrypted by the API: the call is visible, never its text. */
export function AdvisorCard(E: El, width: number, adv: AdvisorStat, turns: TurnCost[], now: number, mode: CardMode) {
  const { Text } = E
  const s = costSummary(turns)
  const isHeavy = s.advisorTurns > 0 && s.advisorShare >= 0.5
  return Card(E, width, 'Advisor', adv.calls > 0 ? plural(adv.calls, 'call', 'calls') : 'no calls', isHeavy ? 'warn' : 'ok', adv.calls === 0
    ? [<Text dimColor wrap="truncate-end">consulted when Claude decides</Text>]
    : [
      <Text wrap="truncate-end">last <Text dimColor>{ageLabel(now - adv.lastAt)} ago</Text></Text>,
      <Text dimColor wrap="truncate-end">encrypted advice</Text>,
      s.advisorTurns > 0
        ? <Text color={isHeavy ? TONE.warn.color : undefined} dimColor={!isHeavy} wrap="truncate-end">{isHeavy ? '▲ ' : ''}~{Math.round(s.advisorShare * 100)}% of the cost (advisor)</Text>
        : null,
    ], mode)
}

/** The decision layer: which tier the last request got, from which layer, and what was done about it. */
export function DecisionCard(E: El, width: number, routes: RouteRecord[], isAuto: boolean, mode: CardMode) {
  const { Text } = E
  const last = routes[routes.length - 1]
  const count = (src: RouteRecord['source']) => routes.filter(r => r.source === src).length
  return Card(E, width, 'Decisions', `${routes.length}`, 'ok', !last
    ? [<Text dimColor wrap="truncate-end">no decision yet</Text>, !isAuto ? <Text dimColor>↳ automatic choice off</Text> : null]
    : [
      <Text wrap="truncate-end"><Text dimColor>tier </Text>{TIER_NAME[last.tier]} <Text dimColor>· {SOURCE_NAME[last.source]} · effort {last.effort}</Text></Text>,
      <Text wrap="truncate-end"><Text dimColor>action </Text>{ACTION_TEXT[last.action]}</Text>,
      <Text dimColor wrap="truncate-end">keywords {count('keywords')} · classifier {count('classifier')} · default {count('default')}</Text>,
      !isAuto ? <Text dimColor>↳ automatic choice off</Text> : null,
    ], mode)
}

/** The scouts (search, grep, audit) in one card, a line each: three small cards became one. Other agents are counted. */
export function ScoutsCard(E: El, width: number, agents: AgentRow[], now: number, isWide: boolean, mode: CardMode) {
  const { Text } = E
  const others = activeAgents(agents).filter(a => !SCOUTS.some(([name]) => name === a.type)).length
  const states = SCOUTS.map(([name, role, short]) => ({ name, what: isWide ? role : short, ...scoutState(agents, name, now) }))
  const running = states.filter(s => s.tone === 'active').length
  const tone: Tone = states.some(s => s.tone === 'error') ? 'error' : running > 0 ? 'active' : 'ok'
  return Card(E, width, 'Scouts', running > 0 ? `${running} running` : 'idle', tone, [
    ...states.map(s => (
      <Text color={TONE[s.tone].color} dimColor={s.isIdle} wrap="truncate-end">{s.mark} {s.name.padEnd(6)} {s.time}<Text dimColor> · {s.what}</Text></Text>
    )),
    others > 0 ? <Text dimColor wrap="truncate-end">+ {plural(others, 'other agent', 'other agents')} running</Text> : null,
  ], mode)
}

/** A link between two blocks of the chain, one line: ▽ advice, ▼ work handed down, ▲ results coming back. */
function Link(E: El, width: number, kind: 'advice' | 'work' | 'back', label: string) {
  const { Text } = E
  const arrow = kind === 'advice' ? '▽' : kind === 'work' ? '▼' : '▲'
  return <Text dimColor wrap="truncate-end">{' '.repeat(Math.floor(width / 2))}{arrow} {label}</Text>
}

/** The status line under the unfolded chain: the agents running, the advisor's calls, the decisions, the cost. What runs now is in the head and the sections above. */
export function StatusFooter(E: El, agents: AgentRow[], adv: AdvisorStat, decisions: number, turns: TurnCost[]) {
  const { Text } = E
  return <Text dimColor wrap="truncate-end">agents [{activeAgents(agents).length} active] · advisor [{plural(adv.calls, 'call', 'calls')}] · decisions [{decisions}] · cost {usd(costSummary(turns).totalUsd)}</Text>
}

export type SchemaInput = {
  width: number
  usage: Usage | null; decision: Decision | null; pin: Pin | null; cache: CacheInfo | null; verdict: CacheVerdict
  keepWarm: KeepWarm | null; warmLeft: number | null; ttl: number; isAuto: boolean
  advisor: AdvisorStat; turns: TurnCost[]; seen: SeenModels; parts: CtxPart[]
  routes: RouteRecord[]; agents: AgentRow[]; journal: LogEntry[]; isExpanded: boolean; now: number
}

/** The chain at a glance: advisor beside the main session, the decision layer under it, the scouts, the journal, the status line. */
export function Schema(E: El, s: SchemaInput) {
  const { Box, Text } = E
  const isWide = s.width >= 84
  const total = isWide ? Math.min(s.width, 100) : Math.min(64, s.width)
  const leftW = 30
  const rightW = total - leftW - 2
  const mainW = isWide ? rightW : total
  const effort = s.pin?.effort ?? s.decision?.effort
  const fixed = s.parts.filter(p => p.name !== 'Messages')
  const messages = s.parts.find(p => p.name === 'Messages')
  const versions = TIERS_STRONGEST_FIRST.filter(t => s.seen[t]).map(t => modelLabel(s.seen[t] as string))
  const release = [...s.journal].reverse().find(l => l.kind === 'release' && s.now - l.at < DAY)
  const extra = [
    release ? <Text wrap="truncate-end">↳ new version: {release.text}</Text> : null,
    effort ? <Text wrap="truncate-end"><Text dimColor>effort </Text>{effort}</Text> : null,
    versions.length > 0 ? <Text dimColor wrap="truncate-end">seen: {versions.join(' · ')}</Text> : null,
    fixed.length > 0 ? <Text wrap="truncate-end"><Text dimColor>load </Text>{k(fixed.reduce((n, p) => n + p.tokens, 0))}<Text dimColor>{messages ? ` · conversation ${k(messages.tokens)}` : ''}</Text></Text> : null,
    fixed.length > 0 ? <Text dimColor wrap="truncate-end">{[...fixed].slice(0, 3).map(p => `${PART_NAME[p.name] ?? p.name.toLowerCase()} ${k(p.tokens)}`).join(' · ')}</Text> : null,
  ]
  const footer = StatusFooter(E, s.agents, s.advisor, s.routes.length, s.turns)
  // Folded: the Model row alone, the figures of the status line in its note.
  if (!s.isExpanded) {
    const cost = costSummary(s.turns).totalUsd
    const note = [s.verdict.isCold ? 'cold cache' : s.keepWarm?.stopped ? 'keep-warm stopped' : null, s.isAuto ? 'auto' : 'auto off', s.routes.length > 0 ? plural(s.routes.length, 'decision', 'decisions') : null, s.advisor.calls > 0 ? `advisor ${plural(s.advisor.calls, 'call', 'calls')}` : null, cost > 0 ? usd(cost) : null].filter(Boolean).join(' · ')
    return ModelCard(E, Math.min(64, s.width), s.usage, s.decision, s.pin, s.cache, s.verdict, s.keepWarm, s.warmLeft, s.ttl, s.isAuto, [], { isCompact: true, note })
  }
  const open: CardMode = {}
  const main = ModelCard(E, mainW, s.usage, s.decision, s.pin, s.cache, s.verdict, s.keepWarm, s.warmLeft, s.ttl, s.isAuto, extra, open)
  const advisor = AdvisorCard(E, isWide ? leftW : total, s.advisor, s.turns, s.now, open)
  const decisions = DecisionCard(E, mainW, s.routes, s.isAuto, open)
  return (
    <Box flexDirection="column">
      {isWide ? (
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="column" width={leftW}>{advisor}</Box>
          <Box flexDirection="column" width={rightW}>{main}{decisions}</Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {advisor}
          {Link(E, total, 'advice', 'advice')}
          {main}
          {Link(E, total, 'work', 'decides')}
          {decisions}
          {Link(E, total, 'work', 'delegates')}
        </Box>
      )}
      {isWide ? <Text dimColor>  ↓ subagents</Text> : null}
      {ScoutsCard(E, total, s.agents, s.now, isWide, open)}
      {isWide ? null : Link(E, total, 'back', 'results')}
      {JournalCard(E, total, s.journal)}
      {footer}
    </Box>
  )
}
