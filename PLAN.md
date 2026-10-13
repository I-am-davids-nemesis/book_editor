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
| Git | Save writes to disk only; manual Commit panel, optional Push; history, diff and restore per file |
| Editor | CodeMirror 6 markdown, with a toggleable rendered preview |
| Library | Default root `~/workspace/books/`, plus books registered from any path |
| v1 extras | Scene and plot side by side; word counts; compile; live reload on external edits; git history and diff |
| Coexistence | Plain files only, no hidden database; new books get `AGENTS.md` and `CLAUDE.md` |
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
    watch.js              # fs.watch(recursive) per open book → SSE events (debounced, ignores .git)
    compile.js            # join scenes into a chapter or book .md
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
      preview.js          # marked rendering, toggle
      panes.js            # single / split (scene + plot) layout
      gitpanel.js         # changed files, message, Commit, Push
      history.js          # per-file log, diff view, restore
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
| GET | `/:id/git/status` | Changed files |
| POST | `/:id/git/commit` | `{message, paths?}` (defaults to all changes) |
| POST | `/:id/git/push` | Push the current branch, if a remote exists |
| GET | `/:id/git/log?path=` | `git log --follow` for a file |
| GET | `/:id/git/show?path=&rev=` | File content at a commit |
| GET | `/:id/git/diff?path=&rev=` | Unified diff (rev vs. its parent, or working copy vs. HEAD) |
| POST | `/:id/git/restore` | `{path, rev}` → writes the old content to the working copy (uncommitted) |
| POST | `/:id/compile` | `{scope: book\|chapter, chapter?}` → writes `compiled/…md`, returns content |
| GET | `/api/events?book=` | SSE stream: `{type: changed\|added\|removed, path}` |

### Notes on the tricky parts

- **Reordering.** Moves go in two phases, all through `git mv`: first to temporary names (`.tmp-<n>-slug`), then to the final names, so swaps never collide. The same mapping is applied to `outline/`. For untracked files the server falls back to `fs.rename`. The watcher is paused during the operation, then one `tree-changed` event is sent.
- **Conflicts.** Every read returns a SHA-1 hash of the content. A save sends `baseHash`, and the server refuses with 409 if the disk changed underneath. The client then shows "Changed on disk: Reload / Keep mine (overwrite) / Show diff".
- **Live reload.** When the watcher reports a change to the open file and the editor is clean, the editor reloads silently, keeping the cursor position. When the editor is dirty, a banner offers the same choice as a conflict. Tree changes refresh the sidebar.
- **Git.** Calls use `execFile('git', args, {cwd: bookRoot})`, never a shell string. Commit errors (no `user.name`, nothing to commit, push rejected) are shown verbatim in the panel.
- **Word counts.** The server computes them for the tree. The client recounts the open file live and updates the scene, chapter and book totals in the sidebar.
- **Compile.** Chapter headings come from the folder titles (`# The Washing House`). Scenes are joined with `* * *`. Output goes to `compiled/book.md` or `compiled/<chapter>.md`, and can also be downloaded.

## 5. UI

- **Library screen:** book cards (title, path, last commit, word count), plus **New book** and **Open folder…**.
- **Book screen:** a sidebar with the tabs **Manuscript | Outline | Codex**, an editor area, and a status bar (word count, save state, branch, number of uncommitted files → opens the Git panel).
  - *Manuscript:* chapters, with their scenes, are collapsible. **+ Chapter**, plus **+ Scene** on each chapter. Drag to reorder scenes within a chapter and chapters within the book (moving scenes between chapters is v1.1). A context menu offers Rename, Delete, Open plot and History.
  - *Outline:* the same tree, opening plot files and `_chapter.md`. **+ Scene summary** and **+ Chapter summary** create the matching manuscript entries too, so the mirror stays intact.
  - *Codex:* groups for Characters, Locations and Notes, with **+ Character**, **+ Location** and **+ Note**.
- **Editor area:** opening a scene shows it with its plot file in a split pane (toggleable). Each pane has an Edit / Preview / Split toggle. Saving is Cmd+S, plus autosave after 2 s idle (it only writes to disk, since commits are manual). Dirty state shows in the tab and the tree, and there's a `beforeunload` guard.
- **Git panel (drawer):** changed files with status letters (click one to see its diff), a message box, **Commit**, and **Push** if a remote exists.
- **History view:** the commit list for a file, a diff of the selected commit, and **Restore this version**.

## 6. Build order

Each milestone ends with something usable, and gets tests before moving on.

1. ✅ **Skeleton.** Add `package.json`, Express, static files and the import map for CodeMirror. Then config and library listing, register-by-path, the tree endpoint, and file read/write with path guarding. On the frontend: library screen, sidebar tree and CodeMirror editor with Cmd+S. *Check:* open a hand-made book folder and edit a scene.
2. **Book creation and structure.** Add the scaffold templates, New book (with git init, initial commit and optional remote), add and rename chapters and scenes with the outline mirror, delete, and reorder with renumbering. Add the codex buttons with templates, and mismatch detection with "Create missing". *Tests:* reorder and renumber edge cases (swap, move to the end, width growth, untracked files), and path traversal attempts.
3. **Writing experience.** Add the scene + plot split pane, preview toggle, autosave, dirty-state handling, and word counts (server and live).
4. **Git.** Add the status, Commit panel and Push, then history, diff rendering and restore. *Tests:* commit and log flow in a temp repo; the no-identity error path.
5. **Live reload.** Add the watcher, SSE, the 409 conflict flow and banners. *Check:* edit the open scene from the terminal while it's clean, and again while it's dirty.
6. **Compile.** Compile a chapter or the whole book, then download.
7. **Polish.** Keyboard shortcuts, empty states, error toasts, a README with setup steps, and a check that a scaffolded book opens cleanly in Obsidian.

## 7. Testing

- `node --test` for the server modules, running against temp directories with real `git` (paths, tree parsing, structure operations, codex templates, git wrapper, compile, word count).
- A small API test per route group, using the Express app in-process.
- A manual end-to-end pass in the browser at the end of each milestone.

## 8. Later (not v1)

- Scene variants (`01-opening.camera.md`), with a switcher and side-by-side compare.
- Moving scenes between chapters by drag and drop.
- `[[wikilink]]` autocomplete and click-through to codex entries.
- Branches, tags and milestones in the git panel.
- Full-text search across the book.
