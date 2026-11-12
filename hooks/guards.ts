// The pane's guards, extracted from register.tsx (over its size): collisions between open sessions, keep-warm
// pings and the handoff to a fresh session (the goal, from Goal Meter, is tracked in session-tracking.ts).
// Ported from inematds/5-mods (MIT): Collision Guard, Cache Keeper; rewritten to compagnon's state.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Ledger } from '../types'
import { asLedger, collisionFor, collisionsWith, continuationPrompt, handoffPrompt, keepWarmDue, pingMissed } from './logic'

type $ = EngineInterface

const keepWarm = atom({ plugin: 'compagnon', key: 'keepWarm' } as const, null, { shape: 'v1' })
const collisions = atom({ plugin: 'compagnon', key: 'collisions' } as const, [], { shape: 'v1' })
/** The collision questions open now, by file: when each was asked. The list of collisions is information, an open question is what waits. */
const collisionAsk = atom({ plugin: 'compagnon', key: 'collisionAsk' } as const, {}, { shape: 'v2' })
const handoff = atom({ plugin: 'compagnon', key: 'handoff' } as const, null, { shape: 'v1' })
const isWorking = atom({ plugin: 'compagnon', key: 'isWorking' } as const, false, { shape: 'v1' })

const MIN = 60_000
/** Another session's edit this recent counts; a ledger quiet this long belongs to a closed session. */
const WINDOW_MS = 30 * MIN
const LIVE_MS = 15 * MIN
/** Memory and mod data: many sessions write these on purpose. */
const IGNORED = ['/.claude/projects/', '/.claude/mods-data/']

let home = ''
/** Whether this session ever wrote its ledger: one that never edited leaves no file, not even an "ended" one. */
let wrote = false
/** A ping in flight: the next tick does not start another. */
let isPinging = false
/** An open collision question per file: parallel edits of one file wait for the same answer. */
const asking = new Map<string, Promise<{ deny: string } | null>>()
const me: Ledger = { id: '', title: '', updatedAt: 0, ended: false, files: {} }
/** "file|other session" -> that session's edit the person said Proceed to; a newer edit asks again. */
const allowed = new Map<string, number>()

const dataDir = (sub: string) => `${home}/.claude/mods-data/compagnon/${sub}`
/** Windows paths ignore case; elsewhere case is part of the name. */
const keyOf = (path: string) => {
  const p = path.replace(/\\/g, '/')
  return /^[a-z]:\//i.test(p) ? p.toLowerCase() : p
}

export async function initGuards($: $) {
  home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.').replace(/\\/g, '/')
  me.id = await $.session.id()
}

/** A new prompt names the session in other sessions' questions (the first one only). */
export const nameSession = (text: string) => {
  if (!me.title && text.trim() && !text.trim().startsWith('/')) me.title = text.trim().replace(/\s+/g, ' ').slice(0, 60)
}

/** /clear and /resume run on under a new session id: a fresh ledger. */
export async function renewSession($: $) {
  await writeLedger($, true)
  me.id = await $.session.id()
  me.title = ''
  me.files = {}
}

export async function writeLedger($: $, ended = false) {
  if (!me.id || !home) return
  me.updatedAt = await $.clock.now()
  me.files = Object.fromEntries(Object.entries(me.files).filter(([, f]) => me.updatedAt - f.at <= 2 * WINDOW_MS))
  if (Object.keys(me.files).length === 0 && !(ended && wrote)) return // a session that never edits leaves no file
  try {
    await $.fs.write(`${dataDir('edits')}/${me.id}.json`, JSON.stringify({ ...me, ended }))
    wrote = !ended
  } catch {
    // ponytail: a locked file; the next edit or tick writes it again
  }
}

async function readOthers($: $): Promise<Ledger[]> {
  const now = await $.clock.now()
  const entries = await $.fs.list(dataDir('edits')).catch(() => [])
  const rows = await Promise.all(
    entries
      .filter(f => f.name.endsWith('.json') && f.name !== `${me.id}.json`)
      .map(f => $.fs.read(`${dataDir('edits')}/${f.name}`).then(t => asLedger(JSON.parse(t))).catch(() => null)),
  )
  return rows.filter((r): r is Ledger => r !== null && !r.ended && now - r.updatedAt <= LIVE_MS)
}

/**
 * Before an edit: another open session changed this file in the last 30 min? Ask Proceed, worktree or Cancel.
 * Returns the refusal Claude reads, or null to let the edit run. Nobody to ask (a -p run): the edit runs.
 */
export async function guardEdit($: $, path: string): Promise<{ deny: string } | null> {
  const key = keyOf(path)
  if (!key || !me.id || IGNORED.some(s => key.toLowerCase().includes(s))) return null
  const open = asking.get(key)
  if (open) return open
  const answer = askAbout($, path, key)
  asking.set(key, answer)
  try {
    return await answer
  } finally {
    asking.delete(key)
  }
}

async function askAbout($: $, path: string, key: string): Promise<{ deny: string } | null> {
  const now = await $.clock.now()
  const hit = collisionFor(key, await readOthers($), now, WINDOW_MS, allowed)
  if (hit && (await $.session.surfaces()).length > 0) {
    const file = path.split(/[\\/]/).pop() ?? path
    const who = hit.other.title || hit.other.id.slice(0, 8)
    const ago = Math.max(1, Math.round((now - hit.at) / MIN))
    const tracked = (await $.process.run(['git', '-C', path.replace(/[\\/][^\\/]*$/, ''), 'ls-files', '--error-unmatch', '--', path]).catch(() => null))?.exitCode === 0
    await update($, collisionAsk, open => ({ ...open, [key]: now }))
    const answer = await $.ui
      .ask(`Session "${who}" edited ${file} ${ago} min ago. Edit it here too?`, {
        header: 'Collision',
        options: ['Proceed', ...(tracked ? ['Move to a worktree'] : []), 'Cancel'],
      })
      .catch(() => 'Cancel')
    await update($, collisionAsk, open => Object.fromEntries(Object.entries(open).filter(([k]) => k !== key)))
    const what = `another open Claude Code session ("${who}") edited ${path} ${ago} min ago`
    if (answer === 'Proceed') allowed.set(`${key}|${hit.other.id}`, hit.at)
    else if (answer === 'Move to a worktree') return { deny: `Not edited: ${what}. The user wants to move this session's work into a git worktree. First list the files already changed here (they stay), then use EnterWorktree and redo this change in the worktree.` }
    else if (answer === 'Cancel') return { deny: `Not edited: ${what}, and the user cancelled. Do not touch this file again; say what you were about to change and ask how to carry on.` }
    else return { deny: `Not edited: ${what}. The user's answer: "${answer.slice(0, 400)}". Follow it before touching this file again.` }
  }
  // Recorded before the edit runs, so a session editing at the same moment sees it.
  me.files[key] = { path, at: await $.clock.now() }
  await writeLedger($)
  return null
}

export async function refreshCollisions($: $) {
  if (Object.keys(me.files).length === 0) return update($, collisions, () => [])
  const list = collisionsWith(me.files, await readOthers($), await $.clock.now(), WINDOW_MS, allowed)
  await update($, collisions, () => list)
}

/** Keep-warm on (for `hours`) or off. */
export async function setKeepWarm($: $, hours: number | null) {
  const now = await $.clock.now()
  await update($, keepWarm, () => (hours ? { until: now + hours * 3_600_000, pings: 0, lastPingAt: 0, stopped: null } : null))
}

/** One keep-warm step on the tick. Returns the moment the cache was last read (0 when no ping happened). */
export async function keepWarmTick($: $, lastActivity: number, ttl: number) {
  const kw = await read($, keepWarm)
  if (!kw || kw.stopped || isPinging) return
  const now = await $.clock.now()
  const due = keepWarmDue(now, Math.max(lastActivity, kw.lastPingAt), ttl, kw.until, await read($, isWorking))
  if (due === 'stop') return update($, keepWarm, k => (k ? { ...k, stopped: 'time limit reached' } : k))
  if (due !== 'ping') return
  isPinging = true
  try {
    // No effort named and a hasty prompt: nothing moves ahead of the prompt, so the cache is read on any model.
    const r = await $.model.fork({ prompt: 'Cache keep-warm ping. No tool, no thinking: answer only "ok".' })
    const stopped = !r.isAnswered ? 'the ping got no answer, the cache is probably cold already' : pingMissed(r.usage) ? 'the ping rewrote the cache instead of reading it' : null
    // Only a ping that read the cache keeps it warm: a failed one leaves `lastPingAt` alone, so the verdict stays honest.
    await update($, keepWarm, k => (k ? { ...k, pings: k.pings + 1, lastPingAt: stopped ? k.lastPingAt : now, stopped } : k))
    if (stopped) await $.ui.toast(`Cache keep-warm stopped: ${stopped}.`)
  } finally {
    isPinging = false
  }
}

/** Asks Claude for a handoff file; `pending` is a message the cold guard held back, resent after the restart. */
export async function askHandoff($: $, pending = '') {
  const now = await $.clock.now()
  const path = `${dataDir('handoffs')}/${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${me.id.slice(0, 8)}.md`
  await update($, handoff, () => ({ path, state: 'writing', askedAt: now, pending, turnStarted: false }))
  await $.prompt.submit({ text: handoffPrompt(path) }).catch(() => failHandoff($, 'the request could not be sent'))
}

/** The handoff did not come: say so, and send back the message the cold guard held, so nothing typed is lost. */
async function failHandoff($: $, why: string) {
  const h = await read($, handoff)
  await update($, handoff, () => null)
  await $.ui.toast(`Handoff not written: ${why}.${h?.pending ? ' Your message is sent as typed.' : ''}`)
  if (h?.pending) await $.prompt.submit({ text: h.pending, asUser: true }).catch(() => undefined)
}

/** A main turn started while a handoff is awaited: the next turn end decides whether it came. */
export async function noteTurnStart($: $) {
  const h = await read($, handoff)
  if (h?.state === 'writing' && !h.turnStarted) await update($, handoff, x => (x ? { ...x, turnStarted: true } : x))
}

/** After a turn: the handoff asked for is on disk? Then it is ready to continue from. */
export async function checkHandoff($: $) {
  const h = await read($, handoff)
  if (!h || h.state !== 'writing') return
  const text = await $.fs.read(h.path).catch(() => '')
  if (text.trim().length < 200) {
    // The turn that answered the request ended without the file (refused write, interrupted turn): give up cleanly.
    if (h.turnStarted) await failHandoff($, 'the file was not written during the turn')
    return
  }
  await update($, handoff, x => (x ? { ...x, state: 'ready' as const } : x))
  await $.ui.toast('Handoff ready. Press c in the pane: clear this session and restart from it.')
}

/** /clear, then the handoff as the fresh session's first prompt. */
export async function continueFromHandoff($: $) {
  const h = await read($, handoff)
  if (!h || h.state !== 'ready') return
  if (await read($, isWorking)) return $.ui.toast('Claude is still working: restart from the handoff once the turn ends.')
  await update($, handoff, () => null)
  await $.command.run({ command: 'clear' })
  await $.prompt.submit({ text: continuationPrompt(h.path, h.pending) })
}
