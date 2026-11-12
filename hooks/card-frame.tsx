// The bordered card every block of the pane is drawn in, its one-row compact form, its gauge, its tones, and the figure
// formats the cards share.
import type { Elements, RenderChildren } from 'claude-code'

import type { Level } from '../types'

export type El = Pick<Elements[keyof Elements], 'Box' | 'Text' | 'Button'>

/**
 * What a value or a line says beyond "all is well": `active` (something runs), the levels that need a look, `error` (something
 * failed, `done` just finished). Each tone has its symbol, so it reads without colour: one neutral, one accent, one amber, red
 * for failures only, green for what just finished.
 */
export type Tone = Level | 'active' | 'error' | 'done'
export const ACCENT = 'suggestion'
export const TONE: Record<Tone, { mark: string; color?: string }> = {
  ok: { mark: '' },
  active: { mark: '● ', color: ACCENT },
  warn: { mark: '▲ ', color: 'warning' },
  alert: { mark: '▲ ', color: 'warning' },
  error: { mark: '✕ ', color: 'error' },
  done: { mark: '✓ ', color: 'success' },
}
/** Stronger tone first: a card shows the strongest of its parts. */
const RANK: Tone[] = ['error', 'alert', 'warn', 'active', 'done', 'ok']
export const strongest = (...tones: Tone[]): Tone => RANK.find(t => tones.includes(t)) ?? 'ok'

/** The braille spinner: one frame per refresh of the animation. */
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
export const spin = (frame: number): string => SPIN[((frame % SPIN.length) + SPIN.length) % SPIN.length] ?? '⠋'

const GAUGE = 10
/** The compact row's title column: the longest title ("7-day plan") and one space. */
const TITLE_COL = 11

export const k = (tokens: number) => `${Math.round(tokens / 1000)}k`
export const usd = (n: number) => `$${n.toFixed(2)}`
export const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`

/** `▰▰▰▰▰▰▱▱▱▱`: a thin gauge. */
export const gauge = (pct: number, width = GAUGE): string => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

export type CardMode = { isCompact?: boolean; note?: string | null }

/**
 * One card, `width` columns wide: `╭─ Title ──── value ─╮`, its lines between `│ … │`, then `╰───╯`. Compact, the same
 * card is one row, `Title      value · note`, its lines folded away (the `e` key unfolds them).
 * The border stays neutral; a tone shows on the value only, with its symbol.
 * Never wider than `width`: a floor wider than the pane spilled past its edge on a narrow terminal.
 */
export function Card(E: El, width: number, title: string, value: string, tone: Tone, lines: RenderChildren[], mode: CardMode = {}) {
  const { Box, Text } = E
  const w = Math.max(8, width)
  const t = TONE[tone]
  const shown = `${t.mark}${value}`
  if (mode.isCompact)
    return (
      <Box width={w}>
        <Text wrap="truncate-end">
          <Text>{title.padEnd(TITLE_COL)}</Text>
          <Text color={t.color} bold>{shown}</Text>
          {mode.note ? <Text dimColor> · {mode.note}</Text> : null}
        </Text>
      </Box>
    )
  // Too narrow for both: the title gives way, never the value (a cut line would lose the figure and the corner).
  const room = w - (shown === '' ? 7 : shown.length + 9)
  const label = title.length <= room ? title : `${title.slice(0, Math.max(0, room - 1))}…`
  const fill = Math.max(1, w - label.length - (shown === '' ? 6 : shown.length + 8))
  return (
    <Box flexDirection="column" width={w}>
      <Text wrap="truncate-end">
        <Text dimColor>╭─ </Text>
        <Text bold>{label}</Text>
        <Text dimColor> {'─'.repeat(fill)}{shown === '' ? '' : ' '}</Text>
        {shown === '' ? null : <Text color={t.color} bold>{shown}</Text>}
        <Text dimColor>{shown === '' ? '─╮' : ' ─╮'}</Text>
      </Text>
      {lines.filter(Boolean).map(l => (
        <Box width={w}>
          <Text dimColor>│ </Text>
          <Box width={w - 4} flexShrink={0}>{l}</Box>
          <Text dimColor> │</Text>
        </Box>
      ))}
      <Text dimColor>╰{'─'.repeat(w - 2)}╯</Text>
    </Box>
  )
}
