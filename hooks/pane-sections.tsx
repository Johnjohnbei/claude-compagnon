// The pane's sections, by priority and each only when it has something to say: FOR YOU (amber, a gesture is asked), FAILED
// (red), RUNNING (blue, moving), DONE (green for 20 s, then one grey line). Colour semantics live in TONE (card-frame).
import type { RenderChildren } from 'claude-code'

import type { AgentRow, BackgroundTask, CacheVerdict, Collision, ErrorEntry, Handoff, RunningTool, Usage, Waiting } from '../types'
import { ACCENT, TONE, k, spin, type El } from './card-frame'
import { CACHE_KEEP_TOKENS, COLD_SOON_MS, ageLabel, clockLabel, elapsedLabel, levelOf } from './logic'
import { STUCK_MS, activeAgents, isLong, runStartOf, type Activity } from './mood'

/** Long-running thresholds: a tool past 2 min, a background task or an agent past 10 min. */
const TOOL_LONG = 120_000
const NAME_COL = 11
/** Under this width a row keeps its mark and its text on one line: no name column, no key hint (its action button stays). */
export const NARROW_COLUMNS = 44
const MAX_ROWS = 8

export type Work = {
  now: number; frame: number; width: number
  running: RunningTool[]; tasks: BackgroundTask[]; agents: AgentRow[]; waiting: Waiting | null
  clash: Collision[]; ho: Handoff | null; usage: Usage | null; verdict: CacheVerdict; warmLeft: number | null; isKeepWarm: boolean
  errors: ErrorEntry[]; isFreshError: boolean; activity: Activity
}
export type Actions = { onStop: (id: string) => void; onView: (id: string) => void }

/** `hint`: a key the keys line answers to or a time; `action`: a button that does something, kept at any width. */
type RowSpec = { mark: string; color?: string; name: string; text: RenderChildren; hint?: RenderChildren; action?: RenderChildren }

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** One line of a section: mark, name column, the text (which gives way first), then a hint or button held to the right. Every piece truncates: a row is one line at any width. */
function Row(E: El, width: number, r: RowSpec) {
  const { Box, Text } = E
  const isNarrow = width < NARROW_COLUMNS
  return (
    <Box width={width}>
      <Text color={r.color} bold wrap="truncate-end">{r.mark}</Text>
      {isNarrow ? null : <Text bold wrap="truncate-end">{cut(r.name, NAME_COL - 1).padEnd(NAME_COL)}</Text>}
      <Box flexGrow={1} flexShrink={1} minWidth={0}>{r.text}</Box>
      {r.action ? <Box flexShrink={0} marginLeft={1}>{r.action}</Box> : !isNarrow && r.hint ? <Box flexShrink={0} marginLeft={1}>{r.hint}</Box> : null}
    </Box>
  )
}

/** A key the keys line below answers to, named in the row that asks for it: `c restart`. */
const Hint = (E: El, key: string, label: string, color?: string) => {
  const { Text } = E
  return <Text color={color}><Text bold>{key}</Text> {label}</Text>
}

/** The section's title line, then its rows and a blank line; nothing at all when it has no row. */
function Section(E: El, title: string, color: string | undefined, suffix: string, rows: RenderChildren[], width: number) {
  const { Box, Text } = E
  if (rows.length === 0) return null
  const shown = rows.slice(0, MAX_ROWS)
  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate-end"><Text color={color} bold>{title}</Text>{suffix ? <Text dimColor>  {suffix}</Text> : null}</Text>
      {shown}
      {rows.length > shown.length ? <Text dimColor>  + {rows.length - shown.length} more</Text> : null}
      <Text> </Text>
    </Box>
  )
}

/** What asks for you: a permission prompt, a collision, a handoff ready, a cache about to go cold, a context nearly full. */
export function ForYou(E: El, w: Work) {
  const { Text } = E
  const amber = TONE.alert.color
  const rows: RenderChildren[] = []
  const add = (r: RowSpec) => rows.push(Row(E, w.width, r))
  if (w.waiting)
    add({ mark: ' ? ', color: amber, name: w.waiting.kind === 'permission_prompt' ? 'permission' : 'waiting', text: <Text color={amber} wrap="truncate-end">{w.waiting.message} · asked {elapsedLabel(w.now - w.waiting.at)}</Text>, hint: <Text color={amber}>answer in chat</Text> })
  for (const c of w.clash.slice(0, 2))
    add({ mark: ' ▲ ', color: amber, name: 'collision', text: <Text color={amber} wrap="truncate-end">{c.file} also edited in "{c.who}"</Text>, hint: <Text dimColor>{ageLabel(w.now - c.at)} ago</Text> })
  if (w.ho?.state === 'ready')
    add({ mark: ' ● ', color: amber, name: 'handoff', text: <Text color={amber} wrap="truncate-end">ready, written to {w.ho.path.split(/[\\/]/).slice(-2).join('/')}</Text>, hint: Hint(E, 'c', 'restart', amber) })
  const isCostly = w.verdict.recache >= CACHE_KEEP_TOKENS
  const isSoon = !w.isKeepWarm && w.warmLeft !== null && w.warmLeft > 0 && w.warmLeft < COLD_SOON_MS
  if (isCostly && (w.verdict.isCold || isSoon))
    add({ mark: ' ▲ ', color: amber, name: 'cache', text: <Text color={amber} wrap="truncate-end">{w.verdict.isCold ? '' : `cold in ${clockLabel(w.warmLeft ?? 0)}, `}next send rereads {k(w.verdict.recache)} tokens</Text>, hint: Hint(E, 'k', 'keep warm', amber) })
  if (w.usage && levelOf(w.usage.contextPct) !== 'ok' && w.ho?.state !== 'ready')
    add({ mark: ' ▲ ', color: amber, name: 'context', text: <Text color={amber} wrap="truncate-end">{Math.round(w.usage.contextPct)}% full, /clear or handoff</Text>, hint: w.ho?.state === 'writing' ? <Text dimColor>writing…</Text> : Hint(E, 'h', 'handoff', amber) })
  return Section(E, 'FOR YOU', amber, '', rows, w.width)
}

/** What failed: agents that ended in failure (`view` opens them) and the mod's own error of this turn. */
export function Failed(E: El, w: Work, on: Actions) {
  const { Button, Text } = E
  const red = TONE.error.color
  const rows: RenderChildren[] = w.agents.filter(a => a.status === 'failed').map(a =>
    Row(E, w.width, { mark: ' ✕ ', color: red, name: a.type, text: <Text color={red} wrap="truncate-end">{a.label} · agent failed · {ageLabel(w.now - a.firstSeen)}</Text>, action: <Button key={`view-${a.id}`} plain label="view" onPress={() => on.onView(a.id)} /> }),
  )
  const last = w.errors[w.errors.length - 1]
  if (w.isFreshError && last)
    rows.push(Row(E, w.width, { mark: ' ✕ ', color: red, name: 'mod', text: <Text color={red} wrap="truncate-end">{last.message}</Text>, hint: <Text dimColor>/compagnon errors</Text> }))
  return Section(E, 'FAILED', red, '', rows, w.width)
}

/** A moving bar for an agent: the API gives no progress, so a short stretch sweeps back and forth to say it is alive. */
function Sweep(E: El, frame: number, width = 8) {
  const { Text } = E
  const span = width - 3
  const at = frame % (2 * span)
  const start = at <= span ? at : 2 * span - at
  return <Text><Text dimColor>{'━'.repeat(start)}</Text><Text color={ACCENT}>━━━</Text><Text dimColor>{'━'.repeat(span - start)}</Text></Text>
}

/** What runs now: tools, agents (a child under the agent that spawned it), background tasks (`stop`). Slow ones turn amber. */
export function Running(E: El, w: Work, on: Actions) {
  const { Button, Text } = E
  const amber = TONE.warn.color
  const live = activeAgents(w.agents)
  const isPaused = Boolean(w.waiting)
  const mark = (i: number) => (isPaused ? ' ‖ ' : ` ${spin(w.frame + i * 3)} `)
  const rows: RenderChildren[] = w.running.map((t, i) => {
    const isLong = w.now - t.start > TOOL_LONG
    return Row(E, w.width, { mark: isLong ? ' ▲ ' : mark(i), color: isLong ? amber : isPaused ? undefined : ACCENT, name: t.tool, text: <Text color={isLong ? amber : undefined} dimColor={!isLong} wrap="truncate-end">{t.label}</Text>, hint: <Text color={isLong ? amber : undefined} dimColor={!isLong}>{elapsedLabel(w.now - t.start)}</Text> })
  })
  const agentRows = (a: AgentRow, depth: number, i: number): RenderChildren[] => {
    const isHeld = a.status === 'waiting' || isLong(a, w.now)
    const lead = depth > 0 ? `${'  '.repeat(depth)}└` : ''
    const own = isHeld
      ? Row(E, w.width, { mark: ` ${lead}▲ `, color: amber, name: a.type, text: <Text color={amber} wrap="truncate-end">{a.label} · {a.status === 'waiting' ? 'waiting' : `running ${elapsedLabel(w.now - runStartOf(a))}, may be stuck`}</Text>, action: <Button key={`view-${a.id}`} plain label="view" onPress={() => on.onView(a.id)} /> })
      : Row(E, w.width, { mark: ` ${lead}${isPaused ? '‖' : spin(w.frame + (i + depth) * 3)} `, color: isPaused ? undefined : ACCENT, name: a.type, text: <Text dimColor wrap="truncate-end">{a.label}</Text>, hint: <Text>{isPaused ? null : Sweep(E, w.frame + i * 2)}<Text dimColor> {elapsedLabel(w.now - runStartOf(a))}</Text></Text> })
    const kids = depth < 3 ? live.filter(c => c.parentId === a.id) : []
    return [own, ...kids.flatMap((c, j) => agentRows(c, depth + 1, j))]
  }
  const roots = live.filter(a => !a.parentId || !live.some(p => p.id === a.parentId))
  rows.push(...roots.flatMap((a, i) => agentRows(a, 0, i)))
  for (const t of w.tasks) {
    const isOld = w.now - t.firstSeen > STUCK_MS
    rows.push(Row(E, w.width, { mark: isOld ? ' ▲ ' : ' ● ', color: isOld ? amber : ACCENT, name: 'background', text: <Text color={isOld ? amber : undefined} dimColor={!isOld} wrap="truncate-end">{t.label} · {isOld ? 'in background ' : ''}{ageLabel(w.now - t.firstSeen)}</Text>, action: <Button key={`stop-${t.id}`} plain label="stop" onPress={() => on.onStop(t.id)} /> }))
  }
  const counts = [w.running.length && `${w.running.length} tool${w.running.length > 1 ? 's' : ''}`, live.length && `${live.length} agent${live.length > 1 ? 's' : ''}`, w.tasks.length && `${w.tasks.length} in background`].filter(Boolean).join(' · ')
  return Section(E, 'RUNNING', ACCENT, isPaused ? 'paused on you' : counts, rows, w.width)
}

/** What just ended: green while the turn is fresh (20 s), then one grey line of the agents that finished; teammates idle or pending, between runs, on a line of their own. */
export function Done(E: El, w: Work) {
  const { Box, Text } = E
  const finished = w.agents.filter(a => a.status === 'completed').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 3)
  const text = finished.map(a => `✓ ${a.type} ${elapsedLabel((a.endedAt ?? w.now) - runStartOf(a))}`).join(' · ')
  const resting = w.agents.filter(a => a.status === 'idle' || a.status === 'pending').map(a => a.label || a.type)
  const isFresh = w.activity?.state === 'done'
  if (!isFresh && !text && resting.length === 0) return null
  return (
    <Box flexDirection="column" width={w.width}>
      {isFresh ? <Text color={TONE.done.color} wrap="truncate-end"><Text bold>DONE</Text>  {text || '✓ turn'}</Text> : text ? <Text dimColor wrap="truncate-end">done  {text}</Text> : null}
      {resting.length > 0 ? <Text dimColor wrap="truncate-end">idle  {resting.join(', ')}</Text> : null}
      <Text> </Text>
    </Box>
  )
}
