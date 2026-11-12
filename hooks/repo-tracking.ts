// The followed repositories, extracted from register.tsx (over its size): which ones, their state read from git, and when to
// read it again.
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { normPath, parseStatus } from './logic'

// Declared again in each module that touches them: the state scan reads each module alone.
const repos = atom({ plugin: 'compagnon', key: 'repos' } as const, [], { shape: 'v1' })
const usedRepos = atom({ plugin: 'compagnon', key: 'usedRepos' } as const, [], { shape: 'v1' })

type $ = EngineInterface

const REPOS_MS = 60_000
let reposAt = 0
/** Repositories the Projects card follows: the `projects` option, or the session's own project. */
let projects: string[] = []
/** The directories the card follows, once read: what a tool call is matched against. */
let followed: string[] = []

/** The `projects` option, paths separated by ";". */
export const setProjects = (option: string) => {
  projects = option.split(';').map(p => p.trim()).filter(Boolean)
}
export const followedDirs = (): string[] => followed

export async function refreshRepos($: $) {
  reposAt = await $.clock.now()
  const root = await $.session.root()
  const dirs = projects.length > 0 ? projects : [root]
  followed = dirs
  // The session's own project counts as used from the start.
  await update($, usedRepos, list => [...new Set([...list, ...dirs.filter(d => normPath(d) === normPath(root)).map(normPath)])])
  const rows = await Promise.all(
    dirs.map(async dir => {
      const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir
      const status = await $.process.run(['git', '-C', dir, 'status', '--porcelain=v2', '--branch'])
      if (status.exitCode !== 0) return null
      const log = await $.process.run(['git', '-C', dir, 'log', '-1', '--format=%cr · %s'])
      return { ...parseStatus(name, status.stdout), dir: normPath(dir), lastCommit: log.stdout.trim() || undefined }
    }),
  )
  await update($, repos, () => rows.filter(r => r !== null))
}

/** After a main turn: read the repositories again when the last read is over a minute old. */
export async function refreshReposIfStale($: $) {
  if ((await $.clock.now()) - reposAt > REPOS_MS) await refreshRepos($)
}
