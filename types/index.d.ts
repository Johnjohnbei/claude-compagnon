export type Tier = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export type Level = 'ok' | 'warn' | 'alert'

export type Advice = { tier: Tier; effort: Effort; need: string; reason: string }
/** What the router did with the last request: switched the main loop, delegated to a subagent, or kept the model. */
export type Decision = { action: 'switch' | 'delegate' | 'keep'; tier: Tier; effort: Effort; why: string }
/** The model the main loop runs on since the last free switch; null = the session's own model. */
export type Pin = { tier: Tier; effort: Effort }
/** The status line's `prompt_cache`, relayed by ~/.claude/hooks/statusline.js. */
export type CacheInfo = { warm: boolean; caching: boolean; ttl?: string; expiresAt: number | null; recacheTokensIfCold: number | null; hitRatio: number | null }
export type CacheVerdict = { isFree: boolean; why: string; recache: number }

export type ToolSpan = { tool: string; start: number; end: number }
export type RunningTool = { id: string; tool: string; label: string; start: number }
export type ParallelSummary = { total: number; overlapped: number; sequentialReads: number; agents: number }

export type BackgroundTask = { id: string; type: string; label: string; firstSeen: number }
export type AgentRow = { id: string; label: string; type: string; status: string; firstSeen: number }
export type Waiting = { kind: string; message: string; at: number }

export type Usage = {
  model: string
  contextPct: number
  contextTokens: number
  contextWindow: number
  limits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>
  costUsd: number
}

/** `dir` is normPath'd: the key that ties a tool call to its repository. */
export type RepoState = { dir: string; name: string; branch: string; ahead: number; behind: number; dirty: number; hasUpstream: boolean; lastCommit?: string }

declare module 'claude-code' {
  interface PluginState {
    compagnon: {
      pin: Shaped<Pin | null>
      decision: Shaped<Decision | null>
      cache: Shaped<CacheInfo | null>
      lastTurnEnd: Shaped<number>
      running: Shaped<RunningTool[]>
      spans: Shaped<ToolSpan[]>
      parallel: Shaped<ParallelSummary | null>
      background: Shaped<BackgroundTask[]>
      agents: Shaped<AgentRow[]>
      waiting: Shaped<Waiting | null>
      usage: Shaped<Usage | null>
      repos: Shaped<RepoState[]>
      usedRepos: Shaped<string[]>
      isProjectsOpen: Shaped<boolean>
      tick: Shaped<number>
    }
  }
}
