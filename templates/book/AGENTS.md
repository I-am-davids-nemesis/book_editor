# AGENTS.md — {{title}}

Guidance for any agent (Claude Code or otherwise) working in this book. The book is edited with a local browser editor, by hand, in Obsidian and by agents, so keep to the layout below; the editor relies on it.

## Layout

```
manuscript/
  01-chapter-slug/
    01-scene-slug.md      # prose only, no front matter
outline/
  01-chapter-slug/
    _chapter.md           # what the chapter must do
    01-scene-slug.md      # plot notes for the scene of the same name
codex/
  characters/             # one file per character
  locations/              # one file per location
  _templates/             # templates the editor uses for new entries
  *.md                    # free-form notes
lookbook/
  tor-at-the-well.jpg     # images (PNG, JPEG, GIF, WebP, AVIF)
  tor-at-the-well.md      # optional note: `of:` lists the codex entries it shows, then a caption
compiled/                 # generated; not committed
book.json                 # optional settings, e.g. {"compile": {"sceneSeparator": "⁂"}}
```

## Rules

- **Names:** chapters are folders named `NN-slug`, scenes are files named `NN-slug.md`. The number sets the order; slugs are lowercase words joined by hyphens.
- **Mirror:** every scene in `manuscript/` has a file with the same path in `outline/`, and every chapter has `outline/<chapter>/_chapter.md`. When you add, rename, move or delete one side, do the same to the other.
- **Reordering:** renumber with `git mv` so history follows the file.
- **Scene files hold prose only.** Plot, POV and who's present go in the outline file.
- **Codex before manuscript.** If a draft needs a fact not in the codex, add it to the codex in the same change. Each fact lives in one place; other files link to it.
- **Lookbook:** an image's note has front matter `of:` with a list of codex paths (`codex/characters/tor.md`), then an embed of the image, then a caption. When you rename or delete a codex entry outside the editor, update the `of:` lists that mention it.
- **Narration modes:** a middle segment in a scene name (`01-opening.camera.md`) marks that scene in one narration mode. Don't use it for anything else.
- **Compiling:** run `node ~/workspace/local_editor/bin/compile.mjs` from the book folder (every chapter and mode, plus the whole book), or pass a chapter (`03-the-courtyard` or `3`) and/or `--mode <mode>`. Output goes to `compiled/`. The editor's **Compile…** button does the same.
- **No code in the book.** The book holds prose, outlines, codex and notes only. Tools (compiling, checks, scripts of any kind) belong in the editor project at `~/workspace/local_editor`; add them there, not here.
