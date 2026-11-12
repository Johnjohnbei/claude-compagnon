# compagnon

<p align="left"><img src="assets/coeurdar-logo.png" alt="Coeurdar logo" width="96"></p>

Built by [Coeurdar](https://coeurdar.com).

A Claude Code mod that opens a side pane with every session, picks the model each request needs without throwing away the prompt cache, and warns you before an action wastes the cache, the context or another session's work.

## What you see

![The Compagnon pane: model chain, watch cards, keys and band](assets/diagrams/panel.svg)

The pane has three parts:

- **The model chain** at the top. `Advisor` counts the advisor's calls (its advice is encrypted, so only the call is visible). `Model` shows the main model, the cache countdown and the size Claude would reread if the cache went cold. `Decisions` shows the tier the last request got and which layer chose it. Three small cards follow the agents named `search`, `grep` and `audit`; other agents are counted below them. `Log` lists the last things the mod decided, and a status line sums up agents, advisor calls, decisions and cost.
- **The watch cards**: `Context` (how full the context window is), `7-day plan` (your weekly plan usage and a 7-day curve), `Goal` (progress of `/goal` on the task list, hidden when there is no goal and no task), `Process` (long tools, background tasks, stuck agents, permission prompts, with `stop` and `view` buttons), `Parallelism` (reads done one after the other in the last turn), `Projects` (branch, changed files, commits ahead or behind, and edit collisions).
- **The keys line** under the cards, and the **band**: one line above the prompt with the model, advisor calls, cost, context and running agents.

A card stays quiet while all is well. When it needs a look, its border turns orange or red and `▲` precedes its value, so the state reads without colour too.

When to act:

| You see | Do |
| --- | --- |
| `Context` at 70 % or more: `↳ nearly full: /clear or handoff (h)` | Press `h`, then `c` when the handoff is ready. |
| `Model`: `cold cache · rereads 120k` | Your next message rereads the whole context. Consider a handoff or a compaction first. |
| `Process`: a tool, task or agent marked `↳` | Check it. `stop` ends a background task, `view` opens an agent. |
| `Parallelism`: `4 reads in series` | Ask Claude to batch its reads or hand them to a subagent. |
| `Projects`: `▲ file · "session"` | Another open session edited the same file. Coordinate before going on. |
| Band or status line: `⚠ 2` | The mod hit an error. Run `/compagnon errors`. |

## Quick start

In a Claude Code session:

```
/plugin install compagnon --marketplace Johnjohnbei/claude-compagnon
```

Answer `y` to add the marketplace, then choose the scope (user scope means every session).

From a shell:

```
claude plugin install compagnon --marketplace Johnjohnbei/claude-compagnon
```

In the desktop app, where `/plugin` does not run: click `+` next to the prompt, then Plugins, Add marketplace with `Johnjohnbei/claude-compagnon`, then Add plugin.

The repository is public: you only need `git` installed.

The pane opens at session start. If you closed it, run:

```
/compagnon
```

## Workflows

### Model routing

![Model routing: keywords, classifier, default, then keep, switch or delegate](assets/diagrams/model-routing.svg)

Each request gets a tier: Haiku, Sonnet, Opus or Fable. Keyword rules decide first, in French and English: a request that starts with `where`, `list`, `find` (or `où est`, `liste`) goes to Haiku, `bug` or `crash` to Opus, `architecture` or `root cause` to Fable.
What no rule recognises goes to a Haiku classifier. If it fails or takes more than 3 s, the request stays on Opus.
The mod then switches the main model only when no warm cache is lost. Otherwise it keeps the model and asks Claude to hand the work to a subagent on the right tier.
Model switching needs Claude Code 2.1.309 or later. On an older or unreadable version, the mod always delegates.

### Cold cache guard

![Cold cache guard: the four answers](assets/diagrams/cold-cache-guard.svg)

When the cache is cold and the context is over the threshold (150k tokens by default, option `coldGuardTokens`), the mod asks before sending.
You choose: send, compact then send, handoff then fresh session (your message is sent again after the restart), or cancel.
With nobody to answer (`claude -p`), the message is sent as typed.

### Keep warm

![Keep warm: pings before each expiry until the limit](assets/diagrams/keep-warm.svg)

Use it before a break you know will outlast the cache. Press `k` (2 hours) or run `/compagnon keepwarm 3`.
A ping goes out a little before the cache expires (8 min before on a 1 h cache, 90 s on a 5 min cache), never during a turn.
It stops at the chosen time, when a ping gets no answer, or when a ping rewrites the cache instead of reading it. Each ping uses a little of your plan.

### Handoff

![Handoff: h, Claude writes the file, c restarts from it](assets/diagrams/handoff.svg)

Use it when the context is nearly full or the session drifted. Press `h` or run `/compagnon handoff`.
Claude writes the session state to a Markdown file. When the file is on disk, a toast says `Handoff ready` and the keys line shows `restart from handoff`.
Press `c`: the session is cleared and the fresh one starts by reading the file.

### Collision guard

![Collision guard: two sessions edit the same file](assets/diagrams/collision-guard.svg)

Every session running the mod keeps a list of the files it edited.
Before an edit, if another open session edited the same file in the last 30 minutes, the mod asks: `Proceed`, `Move to a worktree` (git-tracked files only) or `Cancel`.
Claude is told why the edit did not run: on `Cancel` it leaves the file alone and asks you how to go on; on `Move to a worktree` it redoes the change in a git worktree.

### Errors

![Errors: recorded, counted in the band, listed by a command](assets/diagrams/errors.svg)

When one of the mod's own hooks fails, your prompt or tool call still goes through, and the failure is recorded.
The band shows `⚠ 2`, the pane status line shows `⚠ 2 errors, last: <message>`.
Run `/compagnon errors` to read the list with dates and times.

## Commands

### `/compagnon`

Opens the pane. Use it after closing the pane.

```
/compagnon
```

Reply: `Compagnon pane open.`

### `/compagnon keepwarm [hours|off]`

Keeps the prompt cache warm for the given number of hours (2 when you give none), or stops it. Use it before a break longer than the cache lifetime.

```
/compagnon keepwarm 3
/compagnon keepwarm off
```

Reply: `Cache kept warm for 3 h: one ping before each expiry, stopped if a ping rewrites the cache instead of reading it.` While the cache is warm, the `Model` card adds `kept warm` to its cache line.

### `/compagnon handoff`

Asks Claude to write a handoff file. Use it when the context is nearly full or before a fresh start. Same as the `h` key.

```
/compagnon handoff
```

Reply: `Handoff requested: the pane then offers to restart from a fresh session (key c).`

### `/compagnon decisions`

Prints the routing decisions: the count per layer (keywords, classifier, default), then the last 20 with date, layer, tier, action and the first words of the request. Use it to check whether routing suits your requests.

```
/compagnon decisions
```

Reply, for example: `14 decisions: keywords 11, classifier 2, default 1.` followed by one line per decision.

### `/compagnon load`

Prints what the session loads before your first message, source by source: memory files with their path and tokens, skills by plugin, agents, commands, MCP tools by server. It ends with pointers for heavy sources (a memory file of 8k tokens or more, a plugin or MCP server of 1.5k or more). Run it before trimming your setup. `/compagnon charge` is kept as an alias.

```
/compagnon load
```

The reply starts like: `Startup load: 31.2k tokens, plus the conversation 55.0k tokens.`

### `/compagnon errors`

Prints the mod's recorded errors, newest last, with date and time. Use it when the band or the status line shows `⚠`.

```
/compagnon errors
```

Reply: `No error recorded.` or `2 errors (last 20 kept, newest last):` followed by one line per error.

## Keys in the panel

| Key | Label | Does |
| --- | --- | --- |
| `a` | `auto` / `auto off` | Turns automatic model choice off or on. Off returns the main loop to the session's own model. |
| `k` | `keep warm` / `stop warming` | Keeps the cache warm for 2 hours, or stops it. |
| `h` | `handoff` | Asks Claude for a handoff file. |
| `c` | `restart from handoff` | Shown once the handoff is ready, in place of `h`: clears the session and restarts from the file. Waits if Claude is still working. |
| `r` | `repos` | Reads the followed repositories again. |
| `p` | `others` / `fold` | Shows or hides the followed repositories this session has not touched. Shown only when there are some. |

## Settings

Options declared in `.claude-plugin/plugin.json` (`userConfig`):

| Option | Default | Effect |
| --- | --- | --- |
| `projects` | empty | Absolute paths of the git repositories the `Projects` card follows, separated by `;`. Empty: the session's project only. |
| `showBand` | `true` | The one-line band above the prompt. Off: the pane only. |
| `classify` | `true` | The Haiku classifier for requests the keywords do not recognise. Off: keywords only, the rest stays on Opus. |
| `coldGuardTokens` | `150000` | Context size above which a send on a cold cache asks first. Accepts `150000` or `150k`. `0` turns the guard off. |

## Where data lives

| What | Where |
| --- | --- |
| Automatic choice on or off (`auto`), daily peaks of the 7-day plan (`weekPeaks`), model ids seen per tier (`seenModels`), the last 200 routing decisions (`routeLog`: the first 80 characters of each request, never the full text), the last 20 errors (`errorLog`: the message only) | The engine's plugin store (`$.store`), kept across sessions. |
| Each session's list of edited files, for the collision guard | `~/.claude/mods-data/compagnon/edits/<session>.json` |
| Handoff files | `~/.claude/mods-data/compagnon/handoffs/` |
| The prompt cache itself | Anthropic's side. The mod never saves it. |

The mod API does not expose the cache state: only the status line receives it (`prompt_cache`). For the mod to read it, your status line script must write that field to `claude-ctx-<session_id>.json` in the temporary folder (`TEMP`, else `TMPDIR`, else `/tmp`):

```js
// in your status line script (Node), input = the JSON received on stdin
require('node:fs').writeFileSync(
  require('node:path').join(require('node:os').tmpdir(), `claude-ctx-${input.session_id}.json`),
  JSON.stringify({ prompt_cache: input.prompt_cache ?? null }),
)
```

Without this relay, the mod assumes the cache stays warm for 1 hour after the last turn.

## How the prompt cache works

Claude Code caches the start of the conversation so the next request reads it instead of processing it again. The cache lives 5 minutes or 1 hour after its last use. A cache belongs to one model: switching models starts from zero, and the next request processes the whole context again.

That is why the guards exist. Routing switches the model only when the cache is already cold, just rebuilt by a compaction, or small (under 40k tokens). The cold cache guard asks before a large reread. Keep warm pays for small pings to avoid one large reread.

## Limits

- Keyword routing is approximate. The classifier covers what keywords miss; without it (option off, 3 s timeout, failure), the request stays on Opus.
- The plan is published in percentages only. The 7-day curve counts only days when a session ran.
- The parallelism heuristic is the mod's own; no tool measures this.
- The collision guard only sees sessions where the mod runs.
- After a keep-warm ping, the status line's cache figures lag behind: the mod trusts the ping until the next expiry.
- The model switch sends the tier name (`haiku`, `sonnet`, `opus`, `fable`) and lets the engine pick the version. No model id is written in the mod.
- The agent cards show no percentage: the API gives none, so elapsed time stands in.

## Development

```
claude plugin validate .
claude plugin test .
```

Typecheck:

```
npx -y -p typescript@5.6.3 tsc -p .
```

No npm dependency: `validate` and `test` come with the CLI. The engine writes its API types and the base `tsconfig.json` to `.claude-plugin/types/` when an interactive session loads the mod from this folder (`claude --plugin-dir .`). That folder is generated and ignored by git.

## Credits and license

Built by [Coeurdar](https://coeurdar.com). The cold cache guard, keep warm and handoff are adapted from Cache Keeper, the collision guard from Collision Guard and the goal card from Goal Meter, all in [inematds/5-mods](https://github.com/inematds/5-mods) (MIT).

MIT license.
