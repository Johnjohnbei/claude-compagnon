// The bordered card every block of the pane is drawn in, its gauge, its colours, and the figure formats the cards share.
import type { Elements, RenderChildren } from 'claude-code'

import type { Level } from '../types'

export type El = Pick<Elements[keyof Elements], 'Box' | 'Text' | 'Button'>

export const COLOR: Record<Level, string> = { ok: 'success', warn: 'warning', alert: 'error' }
const GAUGE = 10

export const k = (tokens: number) => `${Math.round(tokens / 1000)} k`
export const usd = (n: number) => `${n.toFixed(2).replace('.', ',')} $`
export const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`

/** `▰▰▰▰▰▰▱▱▱▱`: a thin gauge. */
export const gauge = (pct: number, width = GAUGE): string => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

/**
 * One card, `width` columns wide: `╭─ Title ──── value ─╮`, its lines between `│ … │`, then `╰───╯`.
 * The chain's blocks (role set) are drawn in their role's colour; the others stay quiet until a state needs a look.
 * Never wider than `width`: a floor wider than the pane spilled past its edge on a narrow terminal.
 */
export function Card(E: El, width: number, title: string, value: string, level: Level, lines: RenderChildren[], role?: string) {
  const { Box, Text } = E
  const w = Math.max(8, width)
  // The border carries the role's colour (the chain's blocks) or stays quiet and takes the state's colour (the other cards).
  // A state that needs a look adds ▲ before the value, in the state's colour: it reads without the colour, and on a role card
  // whose border keeps the role's colour.
  const border = role ?? (level === 'ok' ? undefined : COLOR[level])
  const isMarked = level !== 'ok'
  const shown = `${isMarked ? '▲ ' : ''}${value}`
  const valueColor = isMarked ? COLOR[level] : border
  // Too narrow for both: the title gives way, never the value (a cut line would lose the figure and the corner).
  const room = w - (shown === '' ? 7 : shown.length + 9)
  const label = title.length <= room ? title : `${title.slice(0, Math.max(0, room - 1))}…`
  const fill = Math.max(1, w - label.length - (shown === '' ? 6 : shown.length + 8))
  return (
    <Box flexDirection="column" width={w}>
      <Text wrap="truncate-end">
        <Text color={border} dimColor={!border}>╭─ </Text>
        <Text bold>{label}</Text>
        <Text color={border} dimColor={!border}> {'─'.repeat(fill)}{shown === '' ? '' : ' '}</Text>
        {shown === '' ? null : <Text color={valueColor} bold>{shown}</Text>}
        <Text color={border} dimColor={!border}>{shown === '' ? '─╮' : ' ─╮'}</Text>
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
