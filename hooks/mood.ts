// What the session is doing, as one state: which agents are in flight, the activity (working, done, ended badly), the
// companion's mood and whether the pane must move. Pure: no `$`, so the tests run it directly.

/** An agent loop that ended (AgentStatus: completed, failed or killed). */
const FINISHED_AGENT = new Set(['completed', 'failed', 'killed'])
export const isFinished = (status: string): boolean => FINISHED_AGENT.has(status)
/** An agent that is doing something now: a turn running, or held on its own work. `pending` has not started and `idle` (a teammate between turns) waits for a message: neither is in flight. */
export const isInFlight = (status: string): boolean => status === 'running' || status === 'waiting'
/** The agents the band and the sections count as active. */
export const activeAgents = <A extends { status: string }>(list: A[]): A[] => list.filter(a => isInFlight(a.status))

/** In flight for this long: worth a look (amber, `view`). */
export const STUCK_MS = 600_000
type Run = { status: string; firstSeen: number; runStart?: number; isTeammate?: boolean }
/** When the agent's current run began: it entered `running` or `waiting` then, not when it was first seen (a teammate idle for 40 min and woken is not 40 min in). */
export const runStartOf = (a: Run): number => a.runStart ?? a.firstSeen
export const isLong = (a: Run, now: number): boolean => isInFlight(a.status) && now - runStartOf(a) > STUCK_MS
/**
 * Possibly stuck: a teammate in flight that long. A teammate's status is read from its team's roster, and a pane that dies
 * leaves `running` standing (AgentInfo.status); a subagent has a real loop here, so a long run is work, not a doubt.
 */
export const isStuck = (a: Run, now: number): boolean => a.isTeammate === true && isLong(a, now)
/** The agents that make the session busy: in flight and not stuck. A stuck teammate is listed in amber and keeps nothing alive. */
export const busyAgents = <A extends Run>(list: A[], now: number): A[] => list.filter(a => isInFlight(a.status) && !isStuck(a, now))

/** How long `✓ done` (or an interruption) stays once the last turn or agent ended: gone by the next 15 s refresh or the one after. */
export const DONE_MS = 20_000
/** A failure is read for the turn in flight, or for two minutes when none runs; after that the mood follows the rest. */
export const FRESH_FAILURE_MS = 120_000

/** Why the main turn ended (`turn.complete`'s `reason`). */
export type TurnReason = 'answer' | 'aborted' | 'refusal' | 'error'
export type Activity =
  | { state: 'working'; since: number }
  | { state: 'done'; at: number }
  | { state: 'ended'; at: number; reason: Exclude<TurnReason, 'answer'> }
  | null
/**
 * Whether Claude is busy: a main turn in flight (`turnStartedAt`, 0 when none) or an agent in flight; `since` is the earliest
 * of their run starts (an agent that is stuck counts for nothing). Nothing in flight: `done` for DONE_MS after the last end, or `ended` when the turn did not end in an answer
 * (interrupted for DONE_MS, refused or an API error for FRESH_FAILURE_MS), then nothing.
 */
export function activityOf(turnStartedAt: number, lastTurnEnd: number, agents: Array<Run & { endedAt?: number }>, now: number, reason: TurnReason = 'answer'): Activity {
  if (turnStartedAt > 0) return { state: 'working', since: Math.min(turnStartedAt, ...busyAgents(agents, now).map(runStartOf)) }
  // The main turn's reason holds for its own window whatever the agents do after it (they keep the pane moving, not the face).
  if (reason !== 'answer' && lastTurnEnd > 0 && now - lastTurnEnd < (reason === 'aborted' ? DONE_MS : FRESH_FAILURE_MS)) return { state: 'ended', at: lastTurnEnd, reason }
  const busy = busyAgents(agents, now)
  if (busy.length > 0) return { state: 'working', since: Math.min(...busy.map(runStartOf)) }
  const ended = Math.max(lastTurnEnd, ...agents.map(a => a.endedAt ?? 0))
  return ended > 0 && now - ended < DONE_MS ? { state: 'done', at: ended } : null
}

/** What the companion shows: the one state that sums the session up, by priority (see `moodOf`). */
export type Mood = 'work' | 'wait' | 'done' | 'error' | 'idle'
/** Whether a failure happened in the turn in flight, or in the last two minutes when none runs. `times`: when each failed. */
export const hasFreshFailure = (times: number[], turnStartedAt: number, now: number): boolean =>
  times.some(t => t >= (turnStartedAt > 0 ? turnStartedAt : now - FRESH_FAILURE_MS))
/**
 * The mood: a failure first (a failed agent or an error of the mod, fresh; a turn ended in a refusal or an API error), then a
 * session that waits for the person (a permission prompt, an open collision question), then work in flight, then a turn just
 * done, else idle. An interrupted turn is idle.
 */
export function moodOf(s: { isFailed: boolean; isWaiting: boolean; activity: Activity }): Mood {
  if (s.isFailed || (s.activity?.state === 'ended' && s.activity.reason !== 'aborted')) return 'error'
  if (s.isWaiting) return 'wait'
  return s.activity?.state === 'working' ? 'work' : s.activity?.state === 'done' ? 'done' : 'idle'
}
/** Whether something is in flight: a main turn, or an agent that is running and not stuck. */
export const isBusy = (turnStartedAt: number, agents: Run[], now: number): boolean => turnStartedAt > 0 || busyAgents(agents, now).length > 0
/** Whether the pane must be redrawn every frame: something is in flight or a prompt waits, whatever the mood says. */
export const isMoving = (s: { isWaiting: boolean; isBusy: boolean }): boolean => s.isWaiting || s.isBusy
