# Book Editor

A local, browser-based editor for novels kept as plain Markdown in git. Each book is a folder (its own git repo) with `manuscript/` (chapters as folders, scenes as files), a mirrored `outline/` of plot summaries, and a `codex/` of characters, locations and notes. See `PLAN.md` for the design and roadmap.

## Run

```sh
npm install
npm start            # http://localhost:4321
```

`PORT=5000 npm start` uses another port. The server listens only on 127.0.0.1.

## Where books live

- **Library folder:** every subfolder of `~/workspace/books/` is listed as a book.
- **Other folders:** use *Open folder* on the library screen with an absolute path (or `~/...`). These are remembered.

Both settings are in `~/.config/book-editor/config.json`:

```json
{
  "libraryRoot": "/Users/you/workspace/books",
  "registered": { "~my-book": "/Users/you/elsewhere/my-book" }
}
```

Set `BOOK_EDITOR_CONFIG=/path/to/config.json` to use a different config file.

## Editing

- Click a scene, plot file or codex entry in the sidebar to open it. Edits save to disk by themselves about a second after you stop typing (and at least every 5 seconds while you keep typing); **⌘S** or **Save** saves at once.
- Every change in the book is committed to git automatically (`Autosave: …` commits): when you switch to another file, when you leave the book, 30 minutes after the first uncommitted change, and when you stop the server with Ctrl-C. Changes made outside the editor (an agent, Obsidian) are included. Set `AUTOCOMMIT_MINUTES` to change the 30 minutes (`0` turns the timer off).
- A scene opens with its plot file beside it, and a plot file with its scene (in the sidebar's narration mode, with buttons to flip modes). **Plot** / **Scene** in the header shows or hides that pane; drag the divider to resize it (double-click resets). Missing partners get a **Create** button.
- Each pane has **Edit / Split / Preview**. The preview renders Markdown and drops anything that could run code.
- Word counts update as you type: the status bar (file, plot, chapter) and the sidebar (scene, chapter, book).
- If the file changed on disk since you opened it (another editor, Obsidian, an agent), saving shows a banner to load the disk version or overwrite it with yours.
- Word counts in the sidebar cover the manuscript only, not outline or codex files.

## Test

```sh
npm test
```
