# Book Editor — Implementation Plan

A local, browser-based editor for novels stored as plain Markdown in git. A small Node server runs on `127.0.0.1`, serves the UI, and handles the file system, git and file watching. The frontend is vanilla ES modules with no build step.

## 1. Decisions (settled)

| Topic | Decision |
| --- | --- |
| Runtime | Local Node server (`node server.js`), UI in any browser |
| Frontend | Vanilla ES modules, no build step; libraries served from `node_modules` via an import map |
| the_builder | Inspiration only; new layout, no migration |
| Plot/summary files | Separate `outline/` tree mirroring `manuscript/` |
| Variants | Not in v1; filenames reserve room (`01-opening.camera.md`) |
| Ordering | Number prefixes in file and folder names; reorder renumbers with `git mv` |
| Codex | Fixed `characters/` and `locations/` folders (from templates), plus free-form notes |
| Git | Autosave to disk ~1 s after typing stops (at least every 5 s while typing). Auto-commit of all changes in the book when you switch files or leave the book, 30 min after the first uncommitted change, and when the server stops. Manual Commit panel (named milestones), optional Push; history, diff and restore per file |
| Editor | CodeMirror 6 markdown, with a toggleable rendered preview |
| Library | Default root `~/workspace/books/`, plus books registered from any path |
| v1 extras | Scene and plot side by side; word counts; compile; live reload on external edits; git history and diff |
| Coexistence | Plain files only, no hidden database; new books get `AGENTS.md` and `CLAUDE.md` |
| Code | Books hold no code (prose, outlines, codex, notes, `book.json` settings). Every tool, including command-line ones for agents (`bin/`), lives in this project |
| Scene files | Pure prose, no front matter; metadata lives in the outline file |
| Delete | Removes the scene and its outline file after confirmation |
| Links | No `[[link]]` autocomplete in v1; wikilinks are left as plain text |
| Security | Bind to `127.0.0.1`; every path is resolved and checked to be inside the open book |

## 2. Book layout

```
my-book/
  .git/
  .gitignore              # compiled/, .DS_Store
  AGENTS.md  CLAUDE.md  README.md
  manuscript/
    01-the-washing-house/
      01-opening.md
      02-dorgal-arrives.md
  outline/
    01-the-washing-house/
      _chapter.md         # chapter summary
      01-opening.md       # scene plot: Summary / POV / Present / Reader learns / Hidden
      02-dorgal-arrives.md
  codex/
    characters/tor.md
    locations/washing-house.md
    canon-notes.md        # any other .md is a free-form note
    _templates/
      character.md        # based on the_builder codex/README.md profile template
      location.md         # "What it pressures / Who it tests"
      scene-outline.md
      chapter-outline.md
  compiled/               # compile output, gitignored
```

### Naming rules

- Chapter folder: `^(\d{2,})-([a-z0-9-]+)$`. Scene file: `^(\d{2,})-([a-z0-9-]+)(?:\.([a-z0-9-]+))?\.md$`. The optional middle segment is reserved for variants and is ignored in v1 (files that use it are listed with a badge but aren't treated as separate scenes).
- Display title comes from the slug (`the-washing-house` → "The Washing House"). Slugs are generated from the user's title (lowercase, ASCII, hyphens).
- Prefix width is 2 digits, and grows to 3 if a book passes 99 chapters (or a chapter passes 99 scenes). Renumbering normalizes the width.
- Files or folders without a prefix are shown in an "Unordered" group at the end, with a "Give it a position" action.
- `outline/` mirrors `manuscript/` exactly. The tree flags mismatches (a scene without a plot file, or a plot file without a scene) and offers "Create missing", because agents or Obsidian may add files outside the editor.

## 3. Project layout (this repo)

```
local_editor/
  package.json            # deps: express, @codemirror/*, marked
  server.js               # entry: listens on 127.0.0.1
  server/
    app.js                # Express app: local-only guard, routes, static files, import map
    importmap.js          # builds the browser import map from node_modules
    names.js              # chapter/scene name parsing, titles, slugs, ordering
    errors.js             # HttpError
    config.js             # ~/.config/book-editor/config.json: libraryRoot, registered books
    paths.js              # safe path resolution inside a book (rejects .., symlinks out, absolute)
    books.js              # list, register, create (scaffold + git init)
    tree.js               # read manuscript/outline/codex into a typed tree with word counts
    structure.js          # add, rename, delete, reorder chapters/scenes (mirrors outline)
    codex.js              # add character, location, note from templates
    files.js              # read/write with content hash for conflict detection
    git.js                # execFile wrapper: status, commit, push, log, show, diff, restore
    autocommit.js         # checkpoint commits: on file switch, 30-min timer, shutdown
    history.js            # status, named commit, push, graph, compare/word diff, restore, drafts
    queue.js              # one job at a time per book (structure changes, commits)
    watch.js              # fs.watch(recursive) per open book → SSE events (debounced, ignores .git)
    compile.js            # join scenes into a chapter or book .md, per mode; book.json settings
    claude.js             # Claude Code runs via the Agent SDK: permission policy, events, before/after commits
  bin/compile.mjs         # command-line compile for agents (same rules as the dialog)
  templates/book/         # scaffold copied into every new book
  public/
    index.html            # import map pointing at /vendor/... (served from node_modules)
    styles.css
    js/
      main.js             # app state, hash router (#/book/<id>/<area>/<path>)
      api.js              # fetch wrappers
      events.js           # EventSource client
      library.js          # book list, New book / Open path dialogs
      tree.js             # sidebar: Manuscript | Outline | Codex tabs, + buttons, drag reorder
      editor.js           # CodeMirror 6 setup (markdown, line wrap, Cmd+S)
      pane.js             # one open file: editor, Edit/Split/Preview, autosave, conflict banner
      gitpanel.js         # Save revision panel: changed files, message, Push
      history.js          # History view: commit graph, details, word diffs, compare, restore
      claude.js           # Claude panel: transcript, prompt, context chips, approval cards
      graph.js            # autosave folding and lane layout for the graph (pure, tested)
      dialogs.js          # prompt/confirm modals
      wordcount.js        # shared with the server, so both count the same way
      ui.js               # DOM helper, toast, hash routes
  test/                   # node:test, using temp dirs with real git
```

## 4. Server API

All book routes are under `/api/books/:id`, where `:id` is the key from the config's registered books. Paths are relative to the book root.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/books` | Library listing: books in the root folder plus registered books |
| POST | `/api/books` | New book `{title, remote?}`: scaffold, `git init -b main`, initial commit, optional `remote add` |
| POST | `/api/books/register` | Register an existing folder by path |
| GET | `/:id/tree` | Manuscript, outline and codex tree, with word counts and mismatch flags |
| GET | `/:id/file?path=` | `{content, hash}` |
| PUT | `/:id/file` | `{path, content, baseHash}` → 409 with the disk content if the hash differs |
| POST | `/:id/chapters` | `{title, position?}` → creates manuscript folder, outline folder and `_chapter.md` |
| POST | `/:id/scenes` | `{chapter, title, position?}` → creates scene file and outline file |
| PATCH | `/:id/chapters/:ch` / `/:id/scenes` | Rename (slug only; prefix kept) |
| POST | `/:id/reorder` | `{chapter?, order: [names]}` → renumber with `git mv` (manuscript and outline) |
| DELETE | `/:id/chapters/:ch`, `/:id/scenes` | Delete manuscript and outline entries |
| POST | `/:id/codex` | `{kind: character\|location\|note, name}` → file from template |
| GET | `/:id/git/status` | Branch, upstream ahead/behind, remotes, changed files |
| POST | `/:id/git/commit` | `{message, paths?}` (defaults to all changes) |
| POST | `/:id/git/push` | Push the current branch, if a remote exists |
| GET | `/:id/git/log?path=` | `git log --follow` for a file |
| GET | `/:id/git/show?path=&rev=` | File content at a commit |
| GET | `/:id/git/diff?path=&rev=` | Unified diff (rev vs. its parent, or working copy vs. HEAD) |
| POST | `/:id/git/restore` | `{path, rev}` → writes the old content to the working copy (uncommitted) |
| GET | `/:id/git/graph?limit=&before=` | Commits across all branches, newest first: `{hash, parents, subject, body, author, date, refs, files, auto}` |
| GET | `/:id/git/compare?from=&to=&path=` | Changed files between two commits, or one file's diff |
| POST | `/:id/git/branch` | `{name, from}` → create a branch (a "draft") and switch to it, after a checkpoint commit |
| POST | `/:id/git/switch` | `{branch}` → checkpoint, then switch; open panes reload |
| GET | `/:id/compile` | The book's scene separator (from `book.json`) and the default |
| POST | `/:id/compile` | `{scope: book\|chapter, chapter?, mode, separator?, remember?}` → writes `compiled/<book\|chapter>[.<mode>].md`, returns content, counts and warnings |
| GET | `/:id/events` | SSE stream of batches: `{files: [{path, hash, exists}], tree, git}` (debounced; waits for structure changes to finish) |

### Notes on the tricky parts

- **Reordering.** Moves go in two phases, all through `git mv`: first to temporary names (`.tmp-<n>-slug`), then to the final names, so swaps never collide. The same mapping is applied to `outline/`. For untracked files the server falls back to `fs.rename`. The watcher is paused during the operation, then one `tree-changed` event is sent.
- **Conflicts.** Every read returns a SHA-1 hash of the content. A save sends `baseHash`, and the server refuses with 409 if the disk changed underneath. The client then shows "Changed on disk: Reload / Keep mine (overwrite) / Show diff".
- **Live reload.** When the watcher reports a change to the open file and the editor is clean, the editor reloads silently, keeping the cursor position. When the editor is dirty, a banner offers the same choice as a conflict. Tree changes refresh the sidebar.
- **Git.** Calls use `execFile('git', args, {cwd: bookRoot})`, never a shell string. Commit errors (no `user.name`, nothing to commit, push rejected) are shown verbatim in the panel.
- **Word counts.** The server computes them for the tree. The client recounts the open file live and updates the scene, chapter and book totals in the sidebar.
- **Compile.** Chapter headings come from the folder titles (`# The Washing House`). Scenes are joined with the book's separator (`book.json` → `compile.sceneSeparator`, default `* * *`). Each mode uses the scene's variant, falling back to the plain file. Output goes to `compiled/book[.<mode>].md` or `compiled/<chapter>[.<mode>].md`, and can also be downloaded. The rules match the_builder's `scripts/compile.mjs`, so both produce identical files.

## 5. UI

- **Library screen:** book cards (title, path, last commit, word count), plus **New book** and **Open folder…**.
- **Book screen:** a sidebar with the tabs **Manuscript | Outline | Codex**, an editor area, and a status bar (word count, save state, branch, number of uncommitted files → opens the Git panel).
  - *Manuscript:* chapters, with their scenes, are collapsible. **+ Chapter**, plus **+ Scene** on each chapter. Drag to reorder scenes within a chapter and chapters within the book (moving scenes between chapters is v1.1). A context menu offers Rename, Delete, Open plot and History.
  - *Outline:* the same tree, opening plot files and `_chapter.md`. **+ Scene summary** and **+ Chapter summary** create the matching manuscript entries too, so the mirror stays intact.
  - *Codex:* groups for Characters, Locations and Notes, with **+ Character**, **+ Location** and **+ Note**.
- **Editor area:** opening a scene shows it with its plot file in a split pane (toggleable). Each pane has an Edit / Preview / Split toggle. Saving is Cmd+S, plus autosave after 1 s idle (done early, see Git above). Dirty state shows in the tab and the tree, and there's a `beforeunload` guard.
- **Git panel (drawer):** changed files with status letters (click one to see its diff), a message box, **Commit**, and **Push** if a remote exists.
- **History view:** see §10. The ⋯ menu's History item opens it filtered to one file.

## 6. Build order

Each milestone ends with something usable, and gets tests before moving on.

1. ✅ **Skeleton.** Add `package.json`, Express, static files and the import map for CodeMirror. Then config and library listing, register-by-path, the tree endpoint, and file read/write with path guarding. On the frontend: library screen, sidebar tree and CodeMirror editor with Cmd+S. *Check:* open a hand-made book folder and edit a scene.
2. ✅ **Book creation and structure.** Add the scaffold templates, New book (with git init, initial commit and optional remote), add and rename chapters and scenes with the outline mirror, delete, and reorder with renumbering. Add the codex buttons with templates, and mismatch detection with "Create missing". *Tests:* reorder and renumber edge cases (swap, move to the end, width growth, untracked files), and path traversal attempts.
3. ✅ **Writing experience.** Add the scene + plot split pane, preview toggle, autosave, dirty-state handling, and word counts (server and live).
4. ✅ **Git**, in three parts, each checked before the next:
   - ✅ **4a. Status, Save revision, Push.** Status bar shows the draft (branch) and the number of uncommitted files; clicking it opens the Save revision panel (changed files, a message, **Save revision**, **Push** when there's a remote). *Tests:* status parsing, named commit, nothing-to-commit and no-identity errors, push to a local bare remote.
   - ✅ **4b. History view** (§10): the commit graph with autosave runs folded, commit and two-point compare with word-level diffs, restore a file or the whole book, view an old version beside the current one. *Tests:* graph lane layout for merges and several branches; grouping of autosave runs; compare and word counts; restore.
   - ✅ **4c. Drafts.** Start a draft from any commit, switch drafts, current draft in the top bar's Draft menu and the graph. *Tests:* create/switch with checkpoint commits; invalid names.
5. ✅ **Live reload.** Add the watcher, SSE, the 409 conflict flow and banners. *Check:* edit the open scene from the terminal while it's clean, and again while it's dirty.
6. ✅ **Compile.** Compile a chapter or the whole book, per narration mode, then download.
7. ✅ **Polish.** Keyboard shortcuts, empty states, error toasts, a README with setup steps, and a check that a scaffolded book opens cleanly in Obsidian.
8. ✅ **Claude Code.** Run Claude Code from the browser in the book's folder and stream its work back into a Claude panel (design in §9). This comes after live reload (step 5), so edits it makes show up in the open panes, and after git (step 4), so each run's changes can be reviewed as a diff. *Tests:* a fake agent stream (no real model calls) for streaming, approval round-trips, stop, and the before/after commits; a path check refusing writes outside the book. *Check:* ask it to draft a scene from its plot file while the plot is open, and watch the scene fill in.

## 7. Testing

- `node --test` for the server modules, running against temp directories with real `git` (paths, tree parsing, structure operations, codex templates, git wrapper, compile, word count).
- A small API test per route group, using the Express app in-process.
- A manual end-to-end pass in the browser at the end of each milestone.

## 8. Later (not v1)

- Side-by-side compare of a scene's narration modes (the modes themselves are built).
- Moving scenes between chapters by drag and drop.
- `[[wikilink]]` autocomplete and click-through to codex entries.
- Tags, and merging one branch's changes into another from the History view.
- Search and replace across the book (full-text search is built: `server/search.js`, ⌘⇧F).

## 9. Claude Code integration (step 8)

**Backend.** `server/claude.js` drives Claude Code through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which uses your existing Claude Code login. The SDK is preferred over spawning `claude -p --output-format stream-json`, because its permission callback lets the browser approve tool calls. Each run:

- runs with `cwd` set to the book root and loads project settings, so the book's `CLAUDE.md` / `AGENTS.md` apply;
- gets the editor's context with the prompt: the open file and its companion, the narration mode, and the selected text if any;
- streams SDK messages to the browser over SSE (text as it arrives, short tool-call summaries, approval requests, and the final result with its cost);
- resumes the book's previous session for follow-ups, unless you start a new conversation. Session ids are kept in the editor's config directory, not in the book.

**Permissions.**
- Read, Glob and Grep are allowed.
- Edit and Write are allowed only for paths inside the book. Anything else is refused in the permission callback, whatever the model asks.
- Bash and web tools are off by default. A per-book setting can switch them to "ask". The setting lives in the editor's config directory (with the session), not in `book.json`, so an agent can't change it.
- In "ask" mode, each request shows in the panel as an Allow / Deny card.
- Reads outside the book also get a card, rather than being refused.
- Only project settings are loaded (`settingSources: ['project']`). The rules are enforced twice: once in the permission callback, and again in a `PreToolUse` hook. The hook runs even when a settings file allows a tool, so no settings file can widen what a run may do.

**Git and saving.**
- Before a run, the editor saves both panes and takes a checkpoint commit, so the agent's changes are separate from yours.
- After the run, the server commits them as `Claude: <first line of the prompt>`, with the run's file list in the body.
- The panel lists the changed files, each linking to its diff (step 4). Reverting a run is a restore to the checkpoint.
- Files changed during a run reload in the panes through live reload (step 5). A pane with unsaved typing gets the usual conflict banner instead.

**Routes.**

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/:id/claude/runs` | `{prompt, context, newSession?}` → `{runId}`; one run per book at a time |
| GET | `/:id/claude/runs/:run/events` | SSE: `text`, `tool`, `permission`, `files`, `result`, `error` |
| POST | `/:id/claude/runs/:run/permission` | `{requestId, allow}` |
| POST | `/:id/claude/runs/:run/stop` | Abort the run (changes so far are still committed) |
| GET | `/:id/claude/session` | The current conversation's transcript, to restore the panel on reload, plus the running run's id |
| DELETE | `/:id/claude/session` | New conversation: forget the session id and transcript |
| PUT | `/:id/claude/settings` | `{extraTools: off\|ask}` |

**UI.**
- A **Claude** drawer docks to the right of the panes. It has the transcript, a prompt box, chips for what's attached (scene, plot, selection; each can be removed), **Stop**, **New conversation** and approval cards.
- Optional quick prompts: "Draft this scene from its plot", "Write the other mode's version", "Check this scene against the codex".

**Security.** These are the most powerful routes the server has. They keep the existing localhost Host/Origin check and the JSON-only bodies. They also require a per-server random token, which is embedded in the page and sent as a header, so no other local page can start a run.

## 10. History view (part of step 4)

The model is the revision tree in [prose-graph](https://prose-graph.lovable.app/project/p1): the book's history shown as save points on a graph, in a writer's words rather than git's. Unlike that design, it shows real branch lines, since books here can branch.

**Opening it.** A **History** button in the top bar, and the commit count in the status bar, open it as a full-width view over the panes. Esc or **Back to writing** closes it. The address is `#/book/<id>/history[/<commit>]`, so a commit can be linked to. It opens filtered to one file from a scene's ⋯ menu.

**The graph (left column).**
- Commits from newest to oldest, one row each, with the lanes drawn as an SVG strip: a dot per commit and a colored line per branch. Merges and forks curve between lanes.
- The server returns parents; the client lays out the lanes, a straightforward pass over the topologically ordered list.
- Each row shows the subject (or a friendlier label), the relative date, branch and tag chips (the current branch is marked "you are here"), and the file count.
- **Autosave runs collapse.** Consecutive `Autosave:` commits on one branch fold into one row, such as "14 autosaves · 2:10–4:35 pm · 3 scenes". It expands on click. Named commits (manual "Save revision", `Claude: …` runs, structure changes) always show on their own, bolder.
- A filter box (subject or file path) and a toggle for "named save points only". History is paged with *Load older*.

**The details (right column).**
- *One commit selected:* its message, time, and changed files grouped by Manuscript / Outline / Codex, with words added or removed per scene. Clicking a file shows its diff. The diff is word-level for prose (changed words highlighted inside wrapped paragraphs), with a line diff for other files.
- *Two commits selected* (shift-click, or the **Compare** button and then a second click): the same, for everything between them. This answers "what changed in chapter 2 since the editor pass?"
- Actions:
  - **Restore this file**, which writes that version to the working copy.
  - **Restore whole book to here**, which takes a checkpoint commit first and then makes a new commit with that snapshot, so nothing is lost.
  - **Open as read-only**, which shows that version of the file in the side pane next to the current text.
  - **Start a draft from here**, which creates a branch.

**Drafts (branches).**
- A branch is presented as a "draft": a named line of work, such as "stormier opening".
- Creating or switching a draft first takes a checkpoint commit, then runs `git switch`. Open panes reload, and the sidebar shows the draft's name.
- Auto-commits go to whichever draft is current.
- Merging drafts is left for later. Until then, you bring a draft's changes back by restoring individual files.

## 11. Lookbook

**Built.** Images live in `lookbook/`. Each linked or captioned image has a note with the same base name: front matter `of:` lists the codex paths it shows, then an embed of the image (so the note shows its picture in Obsidian), then the caption. Other front matter keys are kept when the editor rewrites the note. Two images can't share a base name, because they would share a note.

- Server: `server/lookbook.js` lists images (they're in the tree as `tree.lookbook`), adds them (base64 JSON, since bodies must be JSON; the format is detected from the bytes and sets the extension), updates links, caption and name, and deletes them. Renaming or deleting a codex entry rewrites the notes that link to it. `GET /books/:id/image?path=[&rev=]` serves images, including as they were at a commit. SVG isn't accepted, because it can carry script.
- UI: a full-width Lookbook view (like History) at `#/book/<id>/lookbook[/<image>]`, a thumbnail strip above an open codex entry, and thumbnails in the sidebar. History shows images before and after instead of a word diff, and restores them byte for byte.

**Descriptions (built).** A loop between prose, codex and pictures, run through the Claude panel (§9), so each step is a reviewable, undoable run. The prompts are in `public/js/codexprompts.js`. They all work on one `## Description` section of the entry (prose, `### Image prompt`, `### From the manuscript`, `### Open questions`), so reruns replace it.

1. ✅ **Gather a description from the manuscript.** From the entry's **Claude ▾** menu.
2. ✅ **Generate an image, by hand.** **Image prompt ▾** copies the prompt and opens ChatGPT or Gemini. The image comes back by dropping it on the entry's strip, which links it.
3. ✅ **Refine from images.** Claude reads the image files with its Read tool (it sees images) and adds what they settle to the description. Conflicts with the manuscript go to Open questions, not into the text.
4. ✅ **Back to the manuscript.** Claude suggests numbered edits without making them; the writer says which to apply.

**Later.**
- Generate images from the editor: see §12.
- Aliases for entries (a front-matter list), so gathering and search find every name a character goes by.

## 12. A consistent world and image generation

Planned in [plan/auto_lookbook.md](plan/auto_lookbook.md): a model of the world and its characters, a Stage dialog for shots, local and paid image generation, and a Claude consistency check.
