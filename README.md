# Book Editor

A local, browser-based editor for novels kept as plain Markdown in git. Each book is a folder with its own git repository:

- `manuscript/`: chapters as folders, scenes as files (`01-the-washing-house/02-dorgal-arrives.md`)
- `outline/`: plot notes mirroring `manuscript/`, one per scene, plus `_chapter.md` per chapter
- `codex/`: characters, locations and free-form notes

Nothing is hidden in a database, so the same folder works in Obsidian, in a terminal, or with an agent at the same time. See `PLAN.md` for the design.

## Setup

You need:

- **Node.js 20 or newer** (`node --version`).
- **git**, with your name and email set, since the editor commits for you:
  ```sh
  git config --global user.name "Your Name"
  git config --global user.email you@example.com
  ```

Then, in this folder:

```sh
npm install
npm start            # then open http://localhost:4321
```

- `PORT=5000 npm start` uses another port.
- The server listens only on 127.0.0.1 and refuses requests from other sites.
- **Ctrl-C** stops it. Any uncommitted edits are committed first.

## Where books live

- **Library folder:** every subfolder of `~/workspace/books/` is listed as a book. **+ New book** creates one there with the folders above, an `AGENTS.md` / `CLAUDE.md` for agents, and a first commit. It can also add a git remote.
- **Other folders:** paste an absolute path (or `~/...`) into **Open folder** on the library screen. These are remembered, and **Remove from list** forgets one without touching the folder.

Both settings are in `~/.config/book-editor/config.json`:

```json
{
  "libraryRoot": "/Users/you/workspace/books",
  "registered": { "~my-book": "/Users/you/elsewhere/my-book" }
}
```

Set `BOOK_EDITOR_CONFIG=/path/to/config.json` to use a different config file.

## Writing

### Opening files

- Click a scene, plot file or codex entry in the sidebar, or press **⌘P** to find one by name.
- A scene opens with its plot file beside it, and a plot file opens with its scene. **Plot** / **Scene** in the header hides or shows that pane.
- Drag the divider to resize the panes; double-click it to reset. If a scene's partner file is missing, the pane offers **Create**.

### Structure

- **+ Chapter** adds a chapter, and **+ Scene** on a chapter adds a scene.
- Each row's ⋯ menu has Rename, Move up or down, Delete and History. You can also drag rows to reorder.
- File numbers are kept in order, and every change to `manuscript/` is mirrored in `outline/`.
- The Codex tab has **+ Character**, **+ Location** and **+ Note**. New entries start from the templates in `codex/_templates/`, which you can edit.

### Narration modes

A scene can exist in several modes as `01-opening.camera.md`, `01-opening.rotating-third.md`, and so on. The sidebar's **Mode** picker sets which mode you browse and count. The buttons in the editor header flip the open scene between its versions.

### In the editor

- Each pane has **Edit / Split / Preview**. The preview renders Markdown and drops anything that could run code.
- Word counts update as you type: in the status bar (file, plot, chapter) and the sidebar (scene, chapter, book).
- Sidebar word counts cover the manuscript only.

### Searching the book

- **⌘⇧F**, or **Search** in the top bar, searches every Markdown file in the book: scenes in every mode, plot files and the codex.
- Results are grouped by file, in book order, with each match shown in its sentence. Click one, or use ↑/↓ and Enter, to open the file with the match selected.
- **Match case**, **Whole words** and the scope menu (Whole book, Manuscript, Outline, Codex) narrow it. The search is plain text, and straight and curly quotes match each other, so `don't` finds `don’t`.
- `compiled/` and hidden folders such as `.obsidian` are skipped. The dialog remembers your last search until you reload the page.

## Lookbook

The lookbook holds pictures of your characters, places and things, each linked to the codex entries it shows. An image can show several entries, and an entry can have many images.

- **Lookbook** in the top bar (or in the Codex tab) opens it: every image as a grid. The menu at the top filters it to one entry's images, to references, or to images not linked to anything.
- **+ Add images**, or drop image files anywhere on the page. If the view is filtered to an entry, new images are linked to it. PNG, JPEG, GIF, WebP and AVIF work, up to 14 MB each.
- Click an image to see it large, link or unlink codex entries, write a caption, rename it or delete it. Esc closes it.
- An open codex entry shows its images in a strip above the text. Drop images on the strip, or use **+**, to add images already linked to that entry. The sidebar shows each entry's first image beside its name.
- Renaming a codex entry keeps its images linked. Deleting one leaves its images in the lookbook, unlinked.
- History shows changed images side by side (before and after), and **Restore this version** works for them too.

### Descriptions and images with Claude

An open codex entry has two menus above its text:

- **Claude ▾ → Gather a description from the manuscript.** Claude finds every passage that describes the entry (in every chapter and mode) and writes a `## Description` section into it. The section has the consolidated description, an **Image prompt**, the quotes it used with their scene files, and open questions such as contradictions. Running it again replaces the section.
- **Claude ▾ → Draft fixed traits from the description.** Claude writes a `## Fixed traits` section: the few visual facts that must be the same in every picture (which cheek the scar is on, eye color, height next to others). Fixed traits are yours: Gather and Refine never change them, they only propose additions under Open questions.
- **Image prompt ▾ → Prepare for ChatGPT / Gemini…** opens the full prompt (the image prompt, the fixed traits, the numbered reference images and the book's visual style) beside the entry's references. **Copy and open ChatGPT** copies the prompt and opens the site. Attach the numbered images in order: drag them from the dialog into the other tab, or use **Show in Finder**, which copies them to a temporary folder as `1-…`, `2-…`. Download the picture you like and drop it on the entry's image strip; it's added to the lookbook already linked to the entry. **Copy image prompt only** copies the prompt without references.
- **Claude ▾ → Refine the description from its images.** Claude looks at the entry's images and adds the details they settle (colors, materials, wear, expression) to the description. Where a picture contradicts the manuscript, Claude lists the conflict under Open questions instead of changing anything, and it updates the image prompt to match. In the Lookbook, **Refine descriptions from this image** does the same for one image and every entry it's linked to.
- **Claude ▾ → Suggest manuscript edits from the description.** Claude lists numbered suggestions (file, original sentence, revised sentence) without changing anything. Reply in the panel with the ones to apply.

### A consistent look: visual style and references

- **Visual style.** **Visual style** in the Lookbook opens `codex/visual-style.md` (creating it the first time): medium, palette, period and setting, light, framing, and what to avoid. It's added to every prompt the editor prepares, so all the book's pictures share one look. Empty sections are left out.
- **References.** In the Lookbook, tick **★ Reference** on the images that show a character or place the way it should look, and pick the view (face, full length, turnaround, expressions; establishing shot, interior, map) and, if it's a variant, its name (`winter coat`, `age 12`). References are sent with prompts, come first in an entry's strip with a ★, and the strip says which views the model sheet still lacks. Link a reference only to the entry it's a reference of.
- **Variants.** A `### Variant: winter coat` subsection in an entry's Description describes a look the character has for part of the book. The Lookbook suggests those names for references.

### Staging a shot

**Stage a shot** puts characters in a place and builds one prompt for a picture of a moment. Open it with **Stage** above a manuscript scene (it uses the selected passage, or the whole scene), with **Image prompt ▾ → Stage a shot with …** on a codex entry, or from the Lookbook.

- **Left: what's in the shot.** The setting, the people (each with its usual look or a variant), the moment, an optional brief, and the framing (wide, medium or close; time of day; camera notes). People and places named in a selected passage start in the shot; names in a whole scene are offered under **Mentioned**.
- **Write it with Claude** reads the scene and writes a brief: a few sentences on what the picture shows (who is where, doing what, the light and mood). It's a quick read-only question, not a panel run, so nothing in the book changes. A brief, when there is one, is used instead of the moment.
- **Middle: the prompt.** The moment or brief, the framing, the setting's and each person's description and fixed traits, the numbered reference images, and the visual style. Edit it freely; **Rebuild it** goes back to the generated one. An entry with no description yet is left out, and the dialog says so.
- **Right: the references.** Each person's best reference first, then the setting's, then everyone's second, up to the limit you choose. Tick or untick any image of the shot's entries.
- **Copy and open ChatGPT / Gemini** and **Show in Finder** work as in Prepare. Drop the picture you get back in the Lookbook.

The **Claude ▾** actions are ordinary Claude runs: the panel opens and shows what Claude does, the changes are committed as one `Claude: …` commit, and **Undo run** puts everything back. Claude can look at PNG, JPEG, GIF and WebP images, but not AVIF.

On disk, images live in `lookbook/`. Each linked or captioned image has a note beside it with the same name (`lookbook/tor-at-the-well.md`), which lists the entries it shows under `of:` and holds the caption. The note also embeds the image, so it reads well in Obsidian:

```markdown
---
of:
  - codex/characters/tor.md
use: reference
view: face
---

![Tor at the Well](tor-at-the-well.jpg)

Dawn, before the washing starts.
```

Images are committed to git like everything else, so large ones make the repository grow.

## Saving and versions

- **Saving.** Edits save to disk about a second after you stop typing, and at least every 5 seconds while you keep typing. **⌘S** saves at once.
- **Automatic commits.** Everything in the book is committed to git automatically, as `Autosave: …` commits:
  - when you switch files or leave the book,
  - 30 minutes after the first uncommitted change,
  - when the server stops.

  Changes made outside the editor are included. `AUTOCOMMIT_MINUTES` changes the 30 minutes, and `0` turns the timer off.
- **Save revision (⌘⇧S),** or the git button in the status bar, makes a named commit you can find again in History, such as "Editor pass: softer cadence". **Push** appears when the book has a remote. The editor never waits for a password, so use an SSH key or a credential helper. If a push fails, git's own error is shown.
- **History (⌘⌥H)** shows every commit as a graph, newest first, with each draft as a colored line.
  - Runs of autosaves fold into one row; **expand** shows them one by one.
  - Click a row to see what it changed, with words added and removed per file. Click a file for a word-level diff.
  - **Compare** (or shift-click) a second row to see everything between two points.
  - **View beside current** opens an old version read-only next to today's text, and **Restore this version** puts it back.
  - **Restore whole book to here** commits your current state first, then commits the restore on top, so nothing is lost.
- **Drafts** are git branches with friendlier names, such as "stormy opening".
  - The **Draft** menu in the top bar switches drafts or starts a new one. In History, **Start a draft from here…** starts one from any earlier point.
  - Pending work is committed before every switch, and open files reload.
  - Merging drafts isn't built yet. To bring a change across, restore single files.

## Working alongside other tools

- **Live reload.** Changes made elsewhere (Obsidian, a terminal, an agent) show up as they happen.
  - An open file with no unsaved edits reloads in place.
  - If you had unsaved edits, autosave pauses and a banner asks whether to **Discard mine, load disk version** or **Overwrite with mine**.
  - New and deleted files refresh the sidebar.
  - Commits and branch switches made in a terminal update the status bar and History.
  - Reloading clears that file's undo history.
  - If the connection to the server drops, the status bar says so, and the editor rechecks open files when it reconnects.
- **Obsidian.** A book folder opens as an Obsidian vault as it is. Obsidian's own `.obsidian/` state is gitignored in new books, so it never gets committed. For older books, add `.obsidian/` to `.gitignore`.
- **Agents.** New books get an `AGENTS.md` with the conventions (and a `CLAUDE.md` pointing to it).
- **Books hold no code.** Every tool lives in this project. To compile from a terminal or an agent:
  ```sh
  node ~/workspace/local_editor/bin/compile.mjs [book] [chapter] [--mode <mode>]
  ```
  This uses exactly the same rules as the **Compile…** dialog. Run it from the book folder, or pass the book's path first; `--help` lists the options.

## Compile

**Compile…**, in the Manuscript toolbar or a chapter's ⋯ menu, joins the scenes of the whole book or of one chapter into a single Markdown file, in one narration mode.

- Each scene uses its version in that mode, or its plain file if it has none.
- Each chapter starts with its title as a heading.
- Scenes are separated by `* * *`, or by the book's own separator. Tick **Remember for this book** to save it in `book.json`, for example `{"compile": {"sceneSeparator": "⁂"}}`.
- Output goes to `compiled/`, for example `book.camera.md` or `02-the-courtyard.md`, which is gitignored.
- The dialog shows a preview with **Download .md** and **Copy**, and lists any scenes missing in that mode.

## Claude

**Claude** in the top bar (or **⌘⌥C**) opens a panel on the right that runs Claude Code in the book's folder, using your existing Claude Code login. You need Claude Code installed and logged in (run `claude` once in a terminal).

- **Context.** Chips above the prompt show what's sent with it: the open file, the file beside it, and any selected text. Click a chip to leave it out. When the prompt is empty, buttons offer common starting points, such as "Draft this scene from its plot".
- **Live edits.** Files Claude changes reload in your panes as it works. If you have unsaved typing in a pane it changes, you get the usual "changed on disk" banner.
- **Commits.** Your work is committed before each run. Claude's changes are committed after it as `Claude: <first line of the prompt>`. After a run, the panel lists the changed files, with **Review changes** (opens History at that commit) and **Undo this run** (puts the whole book back as it was before the run, as a new commit).
- **Limits.** Claude can read and search the book, and create or edit files inside it, never outside it or in `.git`. Bash and web tools are off. The ⋯ menu can switch them to "ask each time", which shows an **Allow / Deny** card for each request.
- **Conversation.** Follow-up prompts continue the same conversation, even after a reload or a restart. **New conversation** starts fresh. Session ids and transcripts are kept in `~/.config/book-editor/claude/`, not in the book.
- **Stop** ends a run. Anything it changed by then is still committed.

## Keyboard shortcuts

Press **?** (or **⌘/**) in the editor for this list. On Windows and Linux, ⌘ is Ctrl and ⌥ is Alt.

| Keys | Does |
| --- | --- |
| ⌘S | Save now |
| ⌘⇧S | Save revision |
| ⌘P | Find and open a file |
| ⌘⇧F | Search the whole book |
| ⌘⌥↑ / ⌘⌥↓ | Previous / next scene (in the same mode, or plot to plot) |
| ⌘⌥P | Show or hide the plot (or scene) beside the file |
| ⌘E | Edit → Split → Preview, in the pane you are in |
| ⌘⌥H | History |
| ⌘⌥C | Show or hide the Claude panel |
| ⌘F | Find in the file |
| Esc | Close History, a dialog or a menu |

## Troubleshooting

- **"Can't reach the editor server."** The server stopped. Run `npm start` again. Your typing is still in the page and saves once the server is back.
- **"Port 4321 is in use."** Another copy is running, or something else uses the port. Stop it, or use `PORT=5000 npm start`.
- **"Auto-commit failed"** in the status bar. Hover over it to see git's message. Usually git's name or email isn't set (see Setup).
- **Claude says it could not sign in.** Run `claude` in a terminal and log in. The editor ignores any `ANTHROPIC_API_KEY` in your shell, so a stale key can't get in the way of your login. To bill an API key instead, start the editor with `BOOK_EDITOR_API_KEY=1 npm start`.
- **Push fails asking for a password.** Set up an SSH key, or a credential helper for HTTPS remotes.

## Test

```sh
npm test
```
