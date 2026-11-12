// The head of the pane: the companion on the left, beside it the state, the model and why, the goal, the cache.
import type { CacheVerdict, Decision, Goal, KeepWarm, Pin, RouteRecord, TaskRow, Usage } from '../types'
import { ACCENT, TONE, gauge, k, spin, type El } from './card-frame'
import { spriteRuns, SPRITE_COLUMNS } from './companion-sprite'
import { shownModel } from './chain-schema'
import { COLD_SOON_MS, ageLabel, clockLabel, elapsedLabel, goalProgress } from './logic'
import type { Activity, Mood } from './mood'
import { SOURCE_NAME } from './request-routing'
import { TIER_NAME } from './tiers'

/** Under this width the pane keeps its text and drops the drawing. */
export const SPRITE_MIN_COLUMNS = 40
const GAP = 2

export type HeadInput = {
  width: number; columns: number; isSpriteShown: boolean; mood: Mood; frame: number; now: number
  activity: Activity; waitAt: number | null; lastTurnEnd: number
  usage: Usage | null; pin: Pin | null; decision: Decision | null; routes: RouteRecord[]; isAuto: boolean
  goal: Goal | null; taskList: TaskRow[]; verdict: CacheVerdict; warmLeft: number | null; kw: KeepWarm | null
}

/** The companion: 9 rows of half blocks, one Text of a few styled runs per row. */
export function Sprite(E: El, mood: Mood, frame: number) {
  const { Box, Text } = E
  return (
    <Box flexDirection="column" width={SPRITE_COLUMNS} flexShrink={0}>
      {spriteRuns(mood, frame).map(row => (
        <Text>{row.map(run => <Text color={run.color} backgroundColor={run.backgroundColor}>{run.text}</Text>)}</Text>
      ))}
    </Box>
  )
}

/** The state in one line: the badge (the spinner moves while it works), the title, how long. */
function Title(E: El, hd: HeadInput) {
  const { Text } = E
  const { now } = hd
  switch (hd.mood) {
    case 'work':
      return <Text wrap="truncate-end"><Text color={ACCENT} bold>{spin(hd.frame)} Claude is working</Text>{hd.activity?.state === 'working' ? <Text> · {elapsedLabel(now - hd.activity.since)}</Text> : null}</Text>
    case 'wait':
      return <Text wrap="truncate-end"><Text color={TONE.alert.color} bold>{hd.frame % 4 < 3 ? '?' : ' '} Waiting for you</Text>{hd.waitAt !== null ? <Text> · {elapsedLabel(now - hd.waitAt)}</Text> : null}</Text>
    case 'done':
      return <Text wrap="truncate-end"><Text color={TONE.done.color} bold>✓ Turn done</Text>{hd.activity?.state === 'done' ? <Text dimColor> · {ageLabel(now - hd.activity.at)} ago</Text> : null}</Text>
    case 'error':
      // A turn that ended badly says how; otherwise a failed agent or an error of the mod.
      return <Text color={TONE.error.color} bold wrap="truncate-end">✕ {hd.activity?.state === 'ended' && hd.activity.reason === 'refusal' ? 'Turn ended: refused' : hd.activity?.state === 'ended' && hd.activity.reason === 'error' ? 'Turn ended: API error' : 'Something failed'}</Text>
    default:
      if (hd.activity?.state === 'ended') return <Text wrap="truncate-end"><Text dimColor>z </Text><Text bold>Interrupted</Text><Text dimColor> · {ageLabel(now - hd.activity.at)} ago</Text></Text>
      return <Text wrap="truncate-end"><Text dimColor>z </Text><Text bold>Resting</Text>{hd.lastTurnEnd > 0 ? <Text dimColor> · idle {ageLabel(now - hd.lastTurnEnd)}</Text> : null}</Text>
  }
}

/** The cache in one line: the countdown (amber and with its key when it ends soon), cold, or kept warm. */
function CacheLine(E: El, hd: HeadInput) {
  const { Text } = E
  const amber = TONE.alert.color
  if (hd.kw?.stopped) return <Text color={amber} wrap="truncate-end">▲ keep-warm stopped: {hd.kw.stopped}</Text>
  if (hd.verdict.isCold) return <Text color={amber} wrap="truncate-end">▲ cache cold · rereads {k(hd.verdict.recache)}</Text>
  const isKept = Boolean(hd.kw && !hd.kw.stopped)
  if (hd.warmLeft === null || hd.warmLeft <= 0) return <Text dimColor wrap="truncate-end">cache {hd.warmLeft === null ? 'estimated' : 'warm'} · {k(hd.verdict.recache)}{isKept ? ' · keep-warm on' : ''}</Text>
  if (!isKept && hd.warmLeft < COLD_SOON_MS)
    return <Text wrap="truncate-end"><Text color={amber}>▲ cache cold in </Text><Text color={amber} bold>{clockLabel(hd.warmLeft)}</Text><Text color={amber}>  </Text><Text color={amber} bold>k</Text><Text color={amber}> keep warm</Text></Text>
  return <Text wrap="truncate-end"><Text dimColor>cache warm </Text><Text bold>{clockLabel(hd.warmLeft)}</Text><Text dimColor>{isKept ? ' · keep-warm on' : ''}</Text></Text>
}

/** The head: the companion (when shown and there is room) and its text lines. */
export function Head(E: El, hd: HeadInput) {
  const { Box, Text } = E
  const isSprite = hd.isSpriteShown && hd.columns >= SPRITE_MIN_COLUMNS
  const { current, shown } = shownModel(hd.usage, hd.pin)
  const last = hd.routes[hd.routes.length - 1]
  const g = hd.goal || hd.taskList.length > 0 ? goalProgress(hd.taskList, hd.goal?.startedAt ?? hd.now, hd.now) : null
  const currentTask = hd.taskList.find(t => t.status === 'in_progress')
  const isGoalDone = g !== null && g.total > 0 && g.done === g.total
  const lines = [
    Title(E, hd),
    <Text wrap="truncate-end">
      <Text bold>{shown}</Text>
      {hd.decision && hd.decision.tier !== current ? <Text><Text dimColor> → </Text><Text color={ACCENT}>{TIER_NAME[hd.decision.tier]}</Text></Text> : null}
      <Text dimColor> · {hd.isAuto ? 'auto' : 'auto off'}</Text>
    </Text>,
    last ? <Text dimColor wrap="truncate-end">for “{last.head}” · {SOURCE_NAME[last.source]}</Text> : null,
    <Text> </Text>,
    g ? (
      <Text wrap="truncate-end">
        <Text dimColor>goal </Text><Text bold>{g.done}/{g.total} </Text><Text color={isGoalDone ? TONE.done.color : ACCENT}>{gauge(g.pct)}</Text>
        <Text dimColor>  {isGoalDone ? 'all done' : currentTask?.subject ?? hd.goal?.condition ?? ''}{g.etaMs !== null ? ` · ~${ageLabel(g.etaMs)}` : ''}</Text>
      </Text>
    ) : null,
    CacheLine(E, hd),
  ]
  const textWidth = hd.width - (isSprite ? SPRITE_COLUMNS + GAP : 0)
  return (
    <Box width={hd.width}>
      {isSprite ? <Box width={SPRITE_COLUMNS + GAP} flexShrink={0}>{Sprite(E, hd.mood, hd.frame)}</Box> : null}
      <Box flexDirection="column" width={textWidth} marginTop={isSprite ? 1 : 0}>{lines.filter(Boolean)}</Box>
    </Box>
  )
}
