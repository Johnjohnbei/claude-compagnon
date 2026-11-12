/**
 * A model tier. The contract must stay self-contained (`claude plugin validate` refuses an import here), so the ids are
 * written here once and everything else about a tier lives in `TIERS` (hooks/tiers.ts); the typecheck refuses an id that
 * is in one and not the other.
 */
export type Tier = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export type Level = 'ok' | 'warn' | 'alert'

/** Which layer decided: a keyword rule, the model classifier, or the default (nothing recognised the request). */
export type Source = 'keywords' | 'classifier' | 'default'
export type Advice = { tier: Tier; effort: Effort; need: string; reason: string; source: Source }
/** One routing decision kept in $.store for review: the request's first words, never the whole text. */
export type RouteRecord = { at: number; source: Source; tier: Tier; effort: Effort; action: 'switch' | 'delegate' | 'keep'; head: string }
/** What the router did with the last request: switched the main loop, delegated to a subagent, or kept the model. */
export type Decision = { action: 'switch' | 'delegate' | 'keep'; tier: Tier; effort: Effort; why: string }
/** The model the main loop runs on since the last free switch; null = the session's own model. */
export type Pin = { tier: Tier; effort: Effort }
/** The status line's `prompt_cache`, relayed by ~/.claude/hooks/statusline.js. */
export type CacheInfo = { warm: boolean; caching: boolean; ttl?: string; expiresAt: number | null; recacheTokensIfCold: number | null; hitRatio: number | null }
/** `isCold`: the next request rewrites the whole context (TTL passed or cache already cold). */
export type CacheVerdict = { isFree: boolean; isCold: boolean; why: string; recache: number }

/** Keep-warm run: a ping through `$.model.fork` before the TTL ends, until `until`. */
export type KeepWarm = { until: number; pings: number; lastPingAt: number; stopped: string | null }
/** A file another open session edited recently, that this session edited too. */
export type Collision = { file: string; who: string; at: number }
/** One session's edit ledger, a file per session under ~/.claude/mods-data/compagnon/edits/. */
export type Ledger = { id: string; title: string; updatedAt: number; ended: boolean; files: Record<string, { path: string; at: number }> }
/** A handoff asked of Claude (`writing`), then found on disk (`ready`). */
export type Handoff = { path: string; state: 'writing' | 'ready'; askedAt: number; pending: string; turnStarted: boolean }
export type TaskRow = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed' | 'deleted' }
/** The session's goal (`/goal <condition>` or ProposeGoal), measured on the native task list. */
export type Goal = { condition: string; startedAt: number }

/** One failure of the mod's own bookkeeping, kept in $.store under `errorLog`: what failed, never the request it failed on. */
export type ErrorEntry = { at: number; session: string; message: string }

/** One line of the session journal: what the mod decided or saw, newest last. */
export type LogKind = 'route' | 'advisor' | 'spawn' | 'release'
export type LogEntry = { at: number; kind: LogKind; text: string }
/** One main-loop turn: the session cost figure moved by `usd` since the previous turn end (an estimate, subagents and advisor included). */
export type TurnCost = { at: number; usd: number; tier: Tier; advisorCalls: number }
/** Advisor consultations seen in the conversation; `pending` counts those of the turn in progress. The advice itself is encrypted. */
export type AdvisorStat = { calls: number; lastAt: number; pending: number }
/** One category of what the context holds, from `$.session.usage({ breakdown })`. */
export type CtxPart = { name: string; tokens: number }
/** The model id last seen for each tier, kept across sessions: an id that changes is a release. */
export type SeenModels = Partial<Record<Tier, string>>

export type RunningTool = { id: string; tool: string; label: string; start: number }

export type BackgroundTask = { id: string; type: string; label: string; firstSeen: number }
export type AgentRow = { id: string; label: string; type: string; status: string; firstSeen: number; endedAt?: number }
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
      background: Shaped<BackgroundTask[]>
      agents: Shaped<AgentRow[]>
      waiting: Shaped<Waiting | null>
      usage: Shaped<Usage | null>
      repos: Shaped<RepoState[]>
      usedRepos: Shaped<string[]>
      isProjectsOpen: Shaped<boolean>
      /** The pane unfolded by the `e` key; compact otherwise. */
      isExpanded: Shaped<boolean>
      tick: Shaped<number>
      keepWarm: Shaped<KeepWarm | null>
      collisions: Shaped<Collision[]>
      handoff: Shaped<Handoff | null>
      tasks: Shaped<TaskRow[]>
      goal: Shaped<Goal | null>
      isWorking: Shaped<boolean>
      /** When the main turn in flight began, 0 when none: the activity indicator. */
      turnStartedAt: Shaped<number>
      journal: Shaped<LogEntry[]>
      costs: Shaped<TurnCost[]>
      costMark: Shaped<number>
      advisor: Shaped<AdvisorStat>
      ctxParts: Shaped<CtxPart[]>
      seen: Shaped<SeenModels>
    }
  }
}
