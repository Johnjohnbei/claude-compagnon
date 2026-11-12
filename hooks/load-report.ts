// What the session loads before the first word: the context categories and the `/compagnon load` report. No `$`.
import type { CtxPart } from '../types'

/** The categories the context really holds (what is loaded, not free space, the compaction buffer or deferred tools), largest first. */
export const contextParts = (categories: Array<{ name: string; tokens: number; kind?: string }>): CtxPart[] =>
  categories.filter(c => c.kind === 'used' && c.tokens > 0).map(c => ({ name: c.name, tokens: c.tokens })).sort((a, b) => b.tokens - a.tokens)

/** A memory file from this size, a plugin or MCP server from the smaller one, earns a pointer in the load report. */
const HEAVY_FILE = 8000
const HEAVY_SOURCE = 1500
const kTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
const sumTokens = (list: Array<{ tokens: number }>): number => list.reduce((s, x) => s + x.tokens, 0)
const asList = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [])
const withTokens = (list: Array<Record<string, unknown>>) => list.filter(x => typeof x.tokens === 'number' && x.tokens > 0) as Array<Record<string, unknown> & { tokens: number }>

/** Sums tokens by a label and sorts, largest first. */
function groupTokens(list: Array<Record<string, unknown> & { tokens: number }>, label: (x: Record<string, unknown>) => string): Array<{ label: string; tokens: number }> {
  const by = new Map<string, number>()
  for (const x of list) by.set(label(x), (by.get(label(x)) ?? 0) + x.tokens)
  return [...by].map(([l, tokens]) => ({ label: l, tokens })).sort((a, b) => b.tokens - a.tokens)
}

/**
 * What the session loads before the first word, source by source, from `$.session.usage({ breakdown: 'full' }).context.breakdown`:
 * memory files by path, skills by plugin, agents, slash commands, MCP tools by server. Shapes read on 2.1.318 (memoryFiles, agents,
 * skills.skillFrontmatter, slashCommands); mcpTools was empty there, so its entries are read tolerantly (server or name, tokens).
 */
export function chargeReport(breakdown: unknown): string {
  const b = (typeof breakdown === 'object' && breakdown !== null ? breakdown : {}) as Record<string, unknown>
  const cats = asList(b.categories) as Array<{ name?: string; tokens?: number; kind?: string }>
  const fixed = cats.filter(c => c.kind === 'used' && c.name !== 'Messages' && typeof c.tokens === 'number')
  const messages = cats.find(c => c.name === 'Messages')
  if (cats.length === 0) return 'No measure: the engine returned no context detail.'
  const lines: string[] = [`Startup load: ${kTokens(fixed.reduce((s, c) => s + (c.tokens ?? 0), 0))} tokens${messages?.tokens ? `, plus the conversation ${kTokens(messages.tokens)} tokens` : ''}.`]
  lines.push(`By category: ${fixed.map(c => `${c.name} ${kTokens(c.tokens ?? 0)}`).join(' · ')}.`)
  const memory = withTokens(asList(b.memoryFiles)).sort((a, c) => c.tokens - a.tokens)
  if (memory.length > 0) {
    lines.push('', `Memory (${memory.length} files, ${kTokens(sumTokens(memory))}):`)
    for (const m of memory.slice(0, 8)) lines.push(`  ${kTokens(m.tokens).padStart(7)}  ${String(m.type ?? '').padEnd(8)} ${String(m.path ?? '').slice(-70)}`)
  }
  const skills = (b.skills ?? {}) as { totalSkills?: number; tokens?: number; skillFrontmatter?: unknown }
  const skillRows = withTokens(asList(skills.skillFrontmatter))
  if (skillRows.length > 0) {
    const bySource = groupTokens(skillRows, x => String(x.pluginName ?? x.source ?? 'other'))
    lines.push('', `Skills (${skills.totalSkills ?? skillRows.length}, ${kTokens(skills.tokens ?? sumTokens(skillRows))}), by source: ${bySource.slice(0, 6).map(s => `${s.label} ${kTokens(s.tokens)}`).join(' · ')}.`)
  }
  const agents = withTokens(asList(b.agents))
  if (agents.length > 0) {
    const bySource = groupTokens(agents, x => String(x.source ?? 'other'))
    lines.push('', `Agents (${agents.length}, ${kTokens(sumTokens(agents))}), by source: ${bySource.map(s => `${s.label} ${kTokens(s.tokens)}`).join(' · ')}.`)
  }
  const mcp = withTokens(asList(b.mcpTools))
  const serverOf = (x: Record<string, unknown>) => String(x.server ?? x.serverName ?? x.name ?? 'unknown server')
  if (mcp.length > 0) {
    const byServer = groupTokens(mcp, serverOf)
    lines.push('', `MCP tools (${mcp.length}, ${kTokens(sumTokens(mcp))}), by server: ${byServer.slice(0, 8).map(s => `${s.label} ${kTokens(s.tokens)}`).join(' · ')}.`)
  }
  const commands = (b.slashCommands ?? {}) as { totalCommands?: number; tokens?: number }
  if (commands.tokens) lines.push('', `Commands: ${commands.totalCommands ?? '?'} (${kTokens(commands.tokens)}).`)
  // What to do about it: only sources heavy enough to matter, one line each.
  const hints: string[] = []
  for (const m of memory.filter(f => f.tokens >= HEAVY_FILE)) hints.push(`${String(m.path ?? '').split(/[\\/]/).slice(-2).join('/')} weighs ${kTokens(m.tokens)}: move its historical sections (post-mortems, origin, why) into a subfolder CLAUDE.md or a rule with \`paths:\`, both loaded on demand.`)
  for (const s of groupTokens(skillRows.filter(r => typeof r.pluginName === 'string'), x => String(x.pluginName)).filter(s => s.tokens >= HEAVY_SOURCE)) hints.push(`Plugin ${s.label}: ${kTokens(s.tokens)} of skills at startup; disable it (/plugin) if it is not used here.`)
  for (const s of groupTokens(agents.filter(a => a.source === 'plugin'), () => 'plugin agents').filter(s => s.tokens >= HEAVY_SOURCE)) hints.push(`${s.label[0]?.toUpperCase()}${s.label.slice(1)}: ${kTokens(s.tokens)}; disable them with their plugin if they are not used here.`)
  for (const s of groupTokens(mcp, serverOf).filter(s => s.tokens >= HEAVY_SOURCE)) hints.push(`MCP server ${s.label}: ${kTokens(s.tokens)}; disconnect it if it is not used in this project.`)
  if (hints.length > 0) lines.push('', 'Pointers:', ...hints.map(h => `  - ${h}`))
  return lines.join('\n')
}
