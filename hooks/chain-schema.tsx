// The chain at the top of the pane: advisor, main session, decision layer, scouts, journal and status line, each block
// in its role's colour (README, the blocks table).
import type { RenderChildren } from 'claude-code'

import type { AdvisorStat, AgentRow, CacheInfo, CacheVerdict, CtxPart, Decision, ErrorEntry, KeepWarm, Level, LogEntry, LogKind, Pin, RouteRecord, SeenModels, TurnCost, Usage } from '../types'
import { COLOR, Card, gauge, k, plural, usd, type El } from './card-frame'
import { TIER_NAME, TIERS_STRONGEST_FIRST, modelLabel, tierOf } from './tiers'
import { SOURCE_NAME } from './request-routing'
import { ageLabel, costSummary, errorSummary } from './logic'

/** One colour per role in the chain, as in the reference video: lead, advisor, decisions, agents (ANSI names: a theme cannot hide them). */
const ROLE = { lead: 'yellow', advisor: 'magenta', decision: 'green', agents: 'blue' } as const
const hhmm = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const DAY = 86_400_000
const PART_NAME: Record<string, string> = { 'System prompt': 'prompt', 'System tools': 'tools', 'MCP server instructions': 'MCP', 'Custom agents': 'agents', Skills: 'skills', Messages: 'messages', 'Memory files': 'memory' }
const KIND_NAME: Record<LogKind, string> = { route: 'route', advisor: 'advisor', spawn: 'agent', release: 'model' }

export function ModelCard(E: El, width: number, usage: Usage | null, d: Decision | null, pin: Pin | null, cache: CacheInfo | null, verdict: CacheVerdict, kw: KeepWarm | null, warmLeft: number | null, ttl: number, isAuto: boolean, extra: RenderChildren[] = [], role?: string) {
  const { Text } = E
  const current = pin ? pin.tier : tierOf(usage?.model ?? '')
  // The version comes from the id the engine reports, and only while it names the tier shown: otherwise the tier alone.
  const shown = usage && tierOf(usage.model) === current ? modelLabel(usage.model) : TIER_NAME[current]
  const level: Level = verdict.isCold || kw?.stopped ? 'warn' : 'ok'
  const cacheLine = verdict.isCold ? (
    <Text color="warning" wrap="truncate-end">cold cache · rereads {k(verdict.recache)}</Text>
  ) : warmLeft !== null && warmLeft > 0 ? (
    <Text wrap="truncate-end">
      <Text dimColor>cache </Text>
      <Text color="success">{gauge((warmLeft / ttl) * 100)}</Text>
      <Text>  {ageLabel(warmLeft)}</Text>
      <Text dimColor> · {k(verdict.recache)}{kw && !kw.stopped ? ' · kept warm' : ''}</Text>
    </Text>
  ) : (
    <Text dimColor wrap="truncate-end">cache {cache ? 'warm' : 'estimated'} · {k(verdict.recache)}</Text>
  )
  const detail = kw?.stopped
    ? <Text color="warning" wrap="truncate-end">↳ keep-warm stopped: {kw.stopped}</Text>
    : !isAuto
      ? <Text dimColor>↳ automatic choice off</Text>
      : d && d.action !== 'keep'
        ? <Text dimColor wrap="truncate-end">↳ {d.action === 'switch' ? 'switched to' : 'handed to'} {TIER_NAME[d.tier]}</Text>
        : null
  return Card(E, width, 'Model', shown, level, [cacheLine, detail, ...extra], role)
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

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const ACTION_TEXT: Record<RouteRecord['action'], string> = { keep: 'keeps the model', switch: 'switches to this tier', delegate: 'hands to a subagent' }
/** The named scouts of ~/.claude/agents, and what each is for. */
const SCOUTS: Array<[string, string, string]> = [['search', 'maps the repository', 'map'], ['grep', 'call sites', 'calls'], ['audit', 'diff review, worktree', 'review']]
const FINISHED = ['completed', 'failed', 'killed']

/** One scout's state: running (and for how long), finished (and how long it ran), failed, or idle. The API gives no progress: no percentage. */
function scoutState(list: AgentRow[], type: string, now: number): { mark: string; time: string; level: Level; isRunning: boolean; isIdle: boolean } {
  const last = list.filter(a => a.type === type).sort((a, b) => b.firstSeen - a.firstSeen)[0]
  if (!last) return { mark: '·', time: 'idle', level: 'ok', isRunning: false, isIdle: true }
  if (!FINISHED.includes(last.status)) return { mark: '●', time: clock(now - last.firstSeen), level: 'ok', isRunning: true, isIdle: false }
  const time = clock((last.endedAt ?? now) - last.firstSeen)
  return last.status === 'completed' ? { mark: '✓', time, level: 'ok', isRunning: false, isIdle: false } : { mark: '✕', time, level: 'warn', isRunning: false, isIdle: false }
}

/** The advisor: how often it was consulted and what that costs. Its advice is encrypted by the API: the call is visible, never its text. */
export function AdvisorCard(E: El, width: number, adv: AdvisorStat, turns: TurnCost[], now: number) {
  const { Text } = E
  const s = costSummary(turns)
  const isHeavy = s.advisorTurns > 0 && s.advisorShare >= 0.5
  return Card(E, width, 'Advisor', adv.calls > 0 ? plural(adv.calls, 'call', 'calls') : 'no calls', isHeavy ? 'warn' : 'ok', adv.calls === 0
    ? [<Text dimColor wrap="truncate-end">consulted when Claude decides</Text>]
    : [
      <Text wrap="truncate-end">last <Text dimColor>{ageLabel(now - adv.lastAt)} ago</Text></Text>,
      <Text dimColor wrap="truncate-end">encrypted advice</Text>,
      s.advisorTurns > 0
        ? <Text color={isHeavy ? 'warning' : undefined} dimColor={!isHeavy} wrap="truncate-end">~{Math.round(s.advisorShare * 100)}% of the cost (advisor)</Text>
        : null,
    ], ROLE.advisor)
}

/** The decision layer: which tier the last request got, from which layer, and what was done about it. */
export function DecisionCard(E: El, width: number, routes: RouteRecord[], isAuto: boolean) {
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
    ], ROLE.decision)
}

/** A scout card's narrowest width: its longest title ("search") inside `╭─ … ─╮` with one dash of fill. */
const SCOUT_MIN = 13

/** The scouts (search, grep, audit), three small cards side by side, one under the other when the pane cannot hold three. Other agents are counted. */
export function SwarmCards(E: El, width: number, agents: AgentRow[], now: number, isWide: boolean) {
  const { Box, Text } = E
  const others = agents.filter(a => !SCOUTS.some(([name]) => name === a.type) && !FINISHED.includes(a.status)).length
  const note = others > 0 ? <Text dimColor wrap="truncate-end">+ {plural(others, 'other agent', 'other agents')} running</Text> : null
  const each = Math.floor((width - (SCOUTS.length - 1)) / SCOUTS.length)
  const isRow = each >= SCOUT_MIN
  return (
    <Box flexDirection="column">
      <Box flexDirection={isRow ? 'row' : 'column'} gap={isRow ? 1 : 0}>
        {SCOUTS.map(([name, role, short]) => {
          const s = scoutState(agents, name, now)
          return Card(E, isRow ? each : width, name, '', 'ok', [
            <Text color={s.level === 'ok' ? undefined : COLOR[s.level]} dimColor={s.isIdle} wrap="truncate-end">{s.mark} {s.time}</Text>,
            <Text dimColor wrap="truncate-end">{isWide ? role : short}</Text>,
          ], ROLE.agents)
        })}
      </Box>
      {note}
    </Box>
  )
}

/** A link between two blocks of the chain, one line: ▽ advice, ▼ work handed down, ▲ results coming back. */
function Link(E: El, width: number, kind: 'advice' | 'work' | 'back', label: string) {
  const { Text } = E
  const arrow = kind === 'advice' ? '▽' : kind === 'work' ? '▼' : '▲'
  return <Text dimColor wrap="truncate-end">{' '.repeat(Math.floor(width / 2))}{arrow} {label}</Text>
}

/** The bottom line: what is running, the advisor's calls, the decisions, the cost, and the mod's own errors when there are any. */
export function StatusFooter(E: El, agents: AgentRow[], adv: AdvisorStat, decisions: number, turns: TurnCost[], errors: ErrorEntry[] = []) {
  const { Text } = E
  const live = agents.filter(a => !FINISHED.includes(a.status)).length
  const failed = errorSummary(errors)
  return (
    <Text wrap="truncate-end">
      <Text dimColor>agents [{live} active] · advisor [{plural(adv.calls, 'call', 'calls')}] · decisions [{decisions}] · cost {usd(costSummary(turns).totalUsd)}</Text>
      {failed ? <Text color="warning"> · {failed}</Text> : null}
    </Text>
  )
}

export type SchemaInput = {
  width: number
  usage: Usage | null; decision: Decision | null; pin: Pin | null; cache: CacheInfo | null; verdict: CacheVerdict
  keepWarm: KeepWarm | null; warmLeft: number | null; ttl: number; isAuto: boolean
  advisor: AdvisorStat; turns: TurnCost[]; seen: SeenModels; parts: CtxPart[]
  routes: RouteRecord[]; agents: AgentRow[]; journal: LogEntry[]; errors: ErrorEntry[]; now: number
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
    release ? <Text color="warning" wrap="truncate-end">↳ new version: {release.text}</Text> : null,
    effort ? <Text wrap="truncate-end"><Text dimColor>effort </Text>{effort}</Text> : null,
    versions.length > 0 ? <Text dimColor wrap="truncate-end">seen: {versions.join(' · ')}</Text> : null,
    fixed.length > 0 ? <Text wrap="truncate-end"><Text dimColor>load </Text>{k(fixed.reduce((n, p) => n + p.tokens, 0))}<Text dimColor>{messages ? ` · conversation ${k(messages.tokens)}` : ''}</Text></Text> : null,
    fixed.length > 0 ? <Text dimColor wrap="truncate-end">{[...fixed].slice(0, 3).map(p => `${PART_NAME[p.name] ?? p.name.toLowerCase()} ${k(p.tokens)}`).join(' · ')}</Text> : null,
  ]
  const main = ModelCard(E, mainW, s.usage, s.decision, s.pin, s.cache, s.verdict, s.keepWarm, s.warmLeft, s.ttl, s.isAuto, extra, ROLE.lead)
  const advisor = AdvisorCard(E, isWide ? leftW : total, s.advisor, s.turns, s.now)
  const decisions = DecisionCard(E, mainW, s.routes, s.isAuto)
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
      {SwarmCards(E, total, s.agents, s.now, isWide)}
      {isWide ? null : Link(E, total, 'back', 'results')}
      {JournalCard(E, total, s.journal)}
      {StatusFooter(E, s.agents, s.advisor, s.routes.length, s.turns, s.errors)}
    </Box>
  )
}
