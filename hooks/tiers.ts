// The model tiers and what a model id says about them: rank, display name, version, release seen. No `$`.
import type { Effort, SeenModels, Tier } from '../types'

/**
 * The model tiers, weakest first: a tier's index is its rank. Everything about a tier derives from this table (ranks, display
 * names, detection in a model id, classifier labels and efforts), so a new tier is one row here plus its id in the `Tier`
 * union of types/index.d.ts (the contract file may not import, so the union cannot be derived; the typecheck ties the two).
 * `effort` is the effort a classifier answer (and the default route) gives; `label` carries the criteria the classifier reads.
 */
export const TIERS = [
  { id: 'haiku', name: 'Haiku', effort: 'low', label: 'simple lookup or reading question (where, list, show, how many)' },
  { id: 'sonnet', name: 'Sonnet', effort: 'medium', label: 'routine, precise edit (fix, add, rename, text, test, commit)' },
  { id: 'opus', name: 'Opus', effort: 'medium', label: 'debugging, new feature, refactor or work plan' },
  { id: 'fable', name: 'Fable', effort: 'xhigh', label: 'architecture decision, root cause or trade-off between approaches' },
] as const satisfies ReadonlyArray<{ id: Tier; name: string; effort: Effort; label: string }>

// A Tier of the contract with no row here fails the typecheck (an unknown id already fails the `satisfies` above).
const everyTierHasARow: [Exclude<Tier, (typeof TIERS)[number]['id']>] extends [never] ? true : never = true
void everyTierHasARow

/** The tier an unrecognised request or model id falls back on. */
export const DEFAULT_TIER: Tier = 'opus'

export const rankOf = (tier: Tier): number => TIERS.findIndex(t => t.id === tier)
export const byTier = <V>(pick: (t: (typeof TIERS)[number]) => V) => Object.fromEntries(TIERS.map(t => [t.id, pick(t)])) as Record<Tier, V>

/** Tier ids strongest first: the order a model id is searched in, and the order the card lists the releases seen. */
export const TIERS_STRONGEST_FIRST: Tier[] = TIERS.map(t => t.id).reverse()

// The pin sends the tier name itself through `turn.step` (`model: 'opus'`): the engine resolves the alias, and
// ANTHROPIC_DEFAULT_*_MODEL repoints it. No model id and no version is written in this mod, so a release changes nothing here.

/** Tier names as shown. A version is never written here: it is read from the id the engine reports (`modelLabel`). */
export const TIER_NAME: Record<Tier, string> = byTier(t => t.name)

/** "5.5" out of "claude-opus-5-5" or "claude-sonnet-4-5-20250929"; null for an alias or an id with no version. */
export const versionOf = (model: string): string | null =>
  model.match(/-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/)?.slice(1).filter(Boolean).join('.') || null

/**
 * "Opus 5.5" for a resolved id, "Opus" for an alias. An id that names no tier is shown as it is: dressing it as the default
 * tier would print "Opus 9.9" for a model that is not Opus.
 */
export const modelLabel = (model: string): string => {
  const tier = tierIn(model)
  if (!tier) return model || TIER_NAME[DEFAULT_TIER]
  const version = versionOf(model)
  return version ? `${TIER_NAME[tier]} ${version}` : TIER_NAME[tier]
}

/** The tier a model id names (`claude-opus-5-5`, `sonnet`), or undefined when it names none. */
const tierIn = (model: string): Tier | undefined => TIERS_STRONGEST_FIRST.find(t => model.toLowerCase().includes(t))

export const tierOf = (model: string): Tier => tierIn(model) ?? DEFAULT_TIER

/** Negative when `a` is an older release than `b`, 0 for the same release (a `[1m]` or dated spelling included). */
const compareVersions = (a: string, b: string): number => {
  const pa = (versionOf(a) ?? '').split('.').filter(Boolean).map(Number)
  const pb = (versionOf(b) ?? '').split('.').filter(Boolean).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * Learns the id behind a tier from a model id the engine reported. `changed` is set when that tier already had an
 * older release: the alias now resolves to a newer one. Releases only move forward, so an older id (the engine fell
 * back for a step, or another open window's alias still resolves to the previous release: both seen on 2026-11-07,
 * `opus` giving Opus 5 and Opus 5.5 in parallel sessions) or the same release spelled otherwise changes nothing and
 * the remembered id stands. An id that names no tier teaches nothing; an unseen tier is learned silently.
 */
export function releaseOf(seen: SeenModels, model: string): { seen: SeenModels; changed: { tier: Tier; from: string; to: string } | null } {
  const tier = tierIn(model)
  if (!tier || seen[tier] === model) return { seen, changed: null }
  const from = seen[tier]
  if (!from || !versionOf(from)) return { seen: { ...seen, [tier]: model }, changed: null }
  if (compareVersions(model, from) <= 0) return { seen, changed: null }
  return { seen: { ...seen, [tier]: model }, changed: { tier, from, to: model } }
}
