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

- Click a scene, plot file or codex entry in the sidebar to open it. **⌘S** or **Save** writes it to disk; switching to another file saves the current one first.
- If the file changed on disk since you opened it (another editor, Obsidian, an agent), saving shows a banner to load the disk version or overwrite it with yours.
- Word counts in the sidebar cover the manuscript only, not outline or codex files.

## Test

```sh
npm test
```
