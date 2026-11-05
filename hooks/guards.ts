// The pane's guards, extracted from register.tsx (over its size): collisions between open sessions, keep-warm
// pings, the handoff to a fresh session, and the goal measured on the native task list.
// Ported from inematds/5-mods (MIT): Collision Guard, Cache Keeper, Goal Meter; rewritten to compagnon's state.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Ledger } from '../types'
import { collisionFor, collisionsWith, continuationPrompt, handoffPrompt, keepWarmDue, pingMissed } from './logic'

type $ = EngineInterface

export const keepWarm = atom({ plugin: 'compagnon', key: 'keepWarm' } as const, null, { shape: 'v1' })
export const collisions = atom({ plugin: 'compagnon', key: 'collisions' } as const, [], { shape: 'v1' })
export const handoff = atom({ plugin: 'compagnon', key: 'handoff' } as const, null, { shape: 'v1' })
export const tasks = atom({ plugin: 'compagnon', key: 'tasks' } as const, [], { shape: 'v1' })
export const goal = atom({ plugin: 'compagnon', key: 'goal' } as const, null, { shape: 'v1' })
export const isWorking = atom({ plugin: 'compagnon', key: 'isWorking' } as const, false, { shape: 'v1' })

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
      .map(f => $.fs.read(`${dataDir('edits')}/${f.name}`).then(t => JSON.parse(t) as Ledger).catch(() => null)),
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
    const answer = await $.ui
      .ask(`La session « ${who} » a modifié ${file} il y a ${ago} min. Le modifier ici aussi ?`, {
        header: 'Collision',
        options: ['Continuer', ...(tracked ? ['Passer en worktree'] : []), 'Annuler'],
      })
      .catch(() => 'Annuler')
    const what = `une autre session Claude Code ouverte (« ${who} ») a modifié ${path} il y a ${ago} min`
    if (answer === 'Continuer') allowed.set(`${key}|${hit.other.id}`, hit.at)
    else if (answer === 'Passer en worktree') return { deny: `Non modifié : ${what}. L'utilisateur veut déplacer le travail de cette session dans un worktree git. Liste d'abord les fichiers déjà modifiés ici (ils restent), puis utilise EnterWorktree et refais ce changement dans le worktree.` }
    else if (answer === 'Annuler') return { deny: `Non modifié : ${what}, et l'utilisateur a annulé. Ne touche plus ce fichier ; dis ce que tu allais changer et demande comment continuer.` }
    else return { deny: `Non modifié : ${what}. Réponse de l'utilisateur : « ${answer.slice(0, 400)} ». Suis-la avant de retoucher ce fichier.` }
  }
  // Recorded before the edit runs, so a session editing at the same moment sees it.
  me.files[key] = { path, at: await $.clock.now() }
  await writeLedger($)
  return null
}

export async function refreshCollisions($: $) {
  if (Object.keys(me.files).length === 0) return update($, collisions, () => [])
  const list = collisionsWith(me.files, await readOthers($), await $.clock.now(), WINDOW_MS)
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
  if (due === 'stop') return update($, keepWarm, k => (k ? { ...k, stopped: 'durée atteinte' } : k))
  if (due !== 'ping') return
  isPinging = true
  try {
    // No effort named and a hasty prompt: nothing moves ahead of the prompt, so the cache is read on any model.
    const r = await $.model.fork({ prompt: 'Ping de maintien du cache. Pas d’outil, pas de réflexion : réponds seulement « ok ».' })
    const stopped = !r.isAnswered ? 'ping sans réponse, cache sans doute déjà froid' : pingMissed(r.usage) ? 'le ping a réécrit le cache au lieu de le lire' : null
    // Only a ping that read the cache keeps it warm: a failed one leaves `lastPingAt` alone, so the verdict stays honest.
    await update($, keepWarm, k => (k ? { ...k, pings: k.pings + 1, lastPingAt: stopped ? k.lastPingAt : now, stopped } : k))
    if (stopped) await $.ui.toast(`Maintien du cache arrêté : ${stopped}.`)
  } finally {
    isPinging = false
  }
}

/** Asks Claude for a handoff file; `pending` is a message the cold guard held back, resent after the restart. */
export async function askHandoff($: $, pending = '') {
  const now = await $.clock.now()
  const path = `${dataDir('handoffs')}/${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${me.id.slice(0, 8)}.md`
  await update($, handoff, () => ({ path, state: 'writing', askedAt: now, pending, turnStarted: false }))
  await $.prompt.submit({ text: handoffPrompt(path) }).catch(() => failHandoff($, 'la demande n’a pas pu être envoyée'))
}

/** The handoff did not come: say so, and send back the message the cold guard held, so nothing typed is lost. */
async function failHandoff($: $, why: string) {
  const h = await read($, handoff)
  await update($, handoff, () => null)
  await $.ui.toast(`Handoff non écrit : ${why}.${h?.pending ? ' Ton message est renvoyé tel quel.' : ''}`)
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
    if (h.turnStarted) await failHandoff($, 'le fichier n’a pas été écrit pendant le tour')
    return
  }
  await update($, handoff, x => (x ? { ...x, state: 'ready' as const } : x))
  await $.ui.toast('Handoff prêt. Touche c dans le panneau : effacer cette session et repartir de lui.')
}

/** /clear, then the handoff as the fresh session's first prompt. */
export async function continueFromHandoff($: $) {
  const h = await read($, handoff)
  if (!h || h.state !== 'ready') return
  if (await read($, isWorking)) return $.ui.toast('Claude travaille encore : repars du handoff à la fin du tour.')
  await update($, handoff, () => null)
  await $.command.run({ command: 'clear' })
  await $.prompt.submit({ text: continuationPrompt(h.path, h.pending) })
}
