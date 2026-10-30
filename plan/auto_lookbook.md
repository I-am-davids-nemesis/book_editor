# Auto lookbook: a consistent world, and generating images from it

**Goal.** Build up a visual model of the book's world and its characters, then place characters in locations and generate images of story moments that keep the same look. Each request carries two kinds of context: reference images, so the generator keeps faces and places consistent, and text from the codex and manuscript, so the picture matches the story.

## Driving ChatGPT or Gemini with Playwright: no

It's technically possible (log in once in a persistent browser profile, attach images, paste a prompt, download the result), but we won't build it:
- **Terms.** OpenAI's terms forbid automatically or programmatically extracting output from its services. Google's consumer terms need checking, but the risk is the same. A ban could take a Google account that holds the writer's mail and documents.
- **Fragility.** These pages change often and detect bots. The automation would break in ways the writer can't fix.
- **Subscriptions don't cover APIs.** ChatGPT Plus and Google AI Pro raise the limits in the web apps only. API use is billed separately, per image.

Use the web apps by hand instead (the **handoff** provider below). It keeps their free and subscription quotas without automating them.

## The world model (in the book, as Markdown and images)

- **Style guide.** One codex note marked `style: true` covers the medium (for example "gouache illustration"), palette, period, light, framing habits, and what to avoid. It's added to every prompt so the whole book shares one look.
- **Character model.** The codex entry's `## Description` (PLAN.md §11), plus:
  - `### Fixed traits`: a short list of traits that must never drift (eye color, which cheek the scar is on, height relative to others, signature clothing).
  - A model sheet: lookbook images whose note says `use: reference` and `view: face | full | turnaround | expressions`.
  - Variants, for a character who changes over the book: `variant: winter coat` or `variant: age 12` on references and in the description, so a scene can ask for the right one.
- **Location model.** Its Description and Fixed traits (layout, materials, landmarks), plus reference images such as an establishing shot or a plan (`view: establishing | interior | map`).
- **Promotion.** A generated image becomes a reference only when the writer approves it. Approved images teach the model; candidates don't.

## Staging a shot

A **Stage** dialog (from a scene, a codex entry or the Lookbook) collects:
- the location,
- the characters, each with a variant,
- the moment (the current scene, or a selected passage),
- the framing (wide, medium, close; time of day),
- the provider and the number of images.

The editor then builds the request:
1. **Text.** Style guide, then the location's description, then each character's fixed traits and description, then what happens. Claude can optionally rewrite the passage into a visual shot brief as a normal panel run, so it stays reviewable.
2. **References.** Pick the best images per character and location (face and full body first, the matching variant first), up to the provider's limit. Name them in the prompt ("Image 1 is Tor's face, image 2 is Tor full-length, image 3 is the washing house…"), because that labeling is what makes multi-reference models keep identities apart.
3. **Preview.** Show the full prompt and the chosen references before sending. They can be edited.

## Providers

The interface lives in `server/imagegen/`: each provider has an `{id, label, maxRefs, limits, estimateCost(), generate({prompt, refs, size, n})}`. API keys live in the editor's config (or environment variables), never in a book. Prices and limits change often, so check them when each provider is built.

| Provider | Cost | References | Notes |
|---|---|---|---|
| **Handoff** (ChatGPT or Gemini web, by hand) | Free quota in each app; Plus / AI Pro raise it | Whatever the app accepts | Copies the prompt, shows the chosen references in Finder to drag in, and opens the site. Results come back by drag and drop. Works today. |
| **Local** (Draw Things or ComfyUI on this Mac) | Free, no limit except speed | FLUX.2 (several), Qwen-Image-Edit (several; heavy, needs quantizing), FLUX.1 Kontext (one) | This Mac has an M5 Max with 48 GB of memory, which is enough for quantized models. Both apps have a local HTTP API. Later: train a small LoRA per character, the strongest consistency there is. |
| **Gemini API** (Nano Banana 2 / Nano Banana Pro) | Pay per image, a few cents; reportedly no free API tier for image models now | Several; Pro takes the most | Probably the best consistency for the money. Rate limits grow with the billing tier. |
| **OpenAI API** (gpt-image-2) | Pay per image, a few cents plus input tokens for references | Up to 16 | Strong at following prompts. Older image models are being retired in December 2026. |
| **Aggregator** (fal.ai, Replicate or OpenRouter) | Pay per image | Per model | One key for many models, including hosted FLUX.2 and Qwen-Image-Edit, so they can be tried without a local install. |

## Limits, cost and results

- **Queue.** A per-provider queue runs on the server, one job at a time per provider. It respects each provider's requests-per-minute and per-day limits, backs off on 429 responses, and shows what's left today.
- **Cost ledger.** An estimated cost is recorded for each job, with a monthly cap set in the editor config. The queue stops at the cap instead of overspending.
- **Candidates stay out of git.** Results land in `lookbook/.candidates/`, which is git-ignored so failed tries don't bloat the repo, and show under a **Candidates** filter in the Lookbook. **Keep** moves an image into `lookbook/` (committed) with a note; **Discard** deletes it.
- **Provenance.** The note records the provider, model, prompt, references (paths plus the commit they came from), seed, size, cost and date, so any image can be rerun or varied.
- **Consistency check.** A Claude run compares a candidate with the model sheets and fixed traits and lists any drift (for example "scar on the left, should be right; coat is blue, should be grey"). It then suggests prompt fixes. Real conflicts go to Open questions, as in PLAN.md §11.
- **Bootstrapping a model sheet.** Generate a turnaround and an expression sheet from the description with no references, keep the best, then generate the other views using it as the reference.

## Build order

1. **World model without generation.** Style guide, Fixed traits, `use: reference` / `view` / `variant` on lookbook notes, and the Lookbook UI to set them. A better handoff: **Prepare for ChatGPT/Gemini** builds the full prompt and shows the references in Finder.
2. **Stage dialog,** with handoff as its only provider at first.
3. **Provider interface, queue, cost ledger and candidates,** with the first paid API (Gemini).
4. **Local provider** (Draw Things or ComfyUI), for free, unlimited drafts.
5. **OpenAI and an aggregator.**
6. **Claude consistency check;** later, LoRA training for local characters.

## Detailed plan: steps 1, 2, 4 and 6

Step 4 needs part of step 3: the provider interface, the job queue and candidates. That part comes in with step 4. The paid APIs and the cost ledger stay in step 3.

### Step 1: the world model, and a better handoff

**Built.** Differences from the plan below: there's no `/model` route or `server/worldmodel.js`. The parsing lives in `public/js/worldmodel.js` (with `public/js/sections.js`), shared by browser and server, and the handoff dialog reads the entry's text from the open editor, so unsaved edits count. Template guidance in `visual-style.md` and `## Fixed traits` is written as HTML comments, which never reach a prompt. Ranking puts the wanted variant first, then the base look (no variant), then other variants. **Show in Finder** needs the page token, since it runs `open`.

**Data, all plain Markdown in the book:**
- **Visual style:** `codex/visual-style.md`, at a fixed path so people, agents and the editor all find it. Its sections are `## Medium`, `## Palette`, `## Period and setting`, `## Light`, `## Framing` and `## Avoid`. The Lookbook header gets **Visual style** (opens it, or creates it from a new `codex/_templates/visual-style.md`). An empty section adds nothing to prompts.
- **Fixed traits:** a `## Fixed traits` section in character and location entries (added to `_templates/character.md` and `location.md`), with one trait per bullet. It's kept separate from `## Description` on purpose: Gather rewrites the Description, but never touches Fixed traits. When the section is missing or empty, Gather proposes traits under Description's `### Open questions` as "Proposed fixed trait: …", and the writer moves the ones they agree with.
- **Reference metadata:** new front matter keys in lookbook notes:
  - `use: reference` marks approved model images.
  - `view:` is one of `face`, `full`, `turnaround`, `expressions`, `establishing`, `interior` or `map`.
  - `variant:` is free text, such as `winter coat` or `age 12`.
  - `parseNote` and `writeNote` handle any flat `key: value`, not only `of:`. Unknown keys are kept, as now. `listLookbook` items gain `use`, `view` and `variant`.
- **Variants on entries:** a character's `## Description` can include `### Variant: <name>` subsections. The variant names offered in the UI are the ones found there plus those already on references.

**Server:**
- `PATCH /books/:id/lookbook` accepts `use`, `view` and `variant`, with an empty value to clear one.
- `GET /books/:id/model?path=codex/...`: the model of one entry, so the client and Stage don't re-parse it: `{title, kind, fixedTraits[], description, imagePrompt, variants[], references:[{path, view, variant}]}`. The parsing lives in a new `server/worldmodel.js`, which shares its section code with `codexprompts.js`. That section reader moves to `public/js/markdown-sections.js`, which both import, so there's one parser.

**UI:**
- **Lookbook detail panel:**
  - A **Reference** toggle, a **View** select and a **Variant** field (with suggestions).
  - A ★ badge on reference cards, and a "References only" filter.
- **Entry strip:** reference images come first and get a ★. A **Model sheet** line under the strip names the missing views ("no face reference yet"), so the gaps are visible.
- **Prompt and Claude menus:**
  - `codexprompts.js`: Gather writes the Fixed-traits proposal as described above.
  - New **Claude ▾ → Draft fixed traits**: Claude reads the Description and its quotes and writes a `## Fixed traits` section only if none exists. The prompt is in `codexprompts.js`.
  - `imagePromptFrom` adds the entry's fixed traits and the visual style to the copied prompt.

**Handoff, improved:**
- **Image prompt ▾ → Prepare for ChatGPT / Gemini** opens a small dialog with:
  - the full prompt (visual style, fixed traits and image prompt), which can be edited and copied;
  - the entry's references as numbered, draggable thumbnails. Chrome lets you drag an image straight from one tab into the ChatGPT or Gemini tab;
  - **Show in Finder**: the server copies the references to a temporary folder as `1-tor-face.png`, `2-tor-full.png` and so on, then runs `open` on it. That's macOS only; elsewhere the button is hidden;
  - **Open ChatGPT / Gemini**.
- The numbering in the prompt ("Image 1 is …") matches the file names, so the generator knows which image is which.

**Tests:**
- `parseNote` and `writeNote` round-trip the new keys and keep unknown ones.
- `worldmodel.js` parses fixed traits, variants and references from sample entries.
- The PATCH route; the handoff copies the right files in the right order (with `open` stubbed).

### Step 2: the Stage dialog

**Built.** Differences from the plan below: the prompt is assembled in the browser by `assembleShot` in `public/js/worldmodel.js` (shared, tested in node), not in a `server/stage.js`; step 4's job API will take the assembled prompt and references. The brief uses a general read-only `ClaudeService.ask()` at `POST /books/:id/claude/ask` (token required, Read/Glob/Grep inside the book only, no session, no commit), with its prompt in `codexprompts.js` as `briefPrompt`. Entries with no description or traits are left out of the prompt rather than named bare. **Stage again** waits for step 4, since there are no stored shots before candidates exist. Contact sheets are still undecided.

**Opening it:**
- From a manuscript scene: **Stage ▾** in the pane toolbar uses the scene. A text selection, if there is one, becomes the moment.
- From a codex entry's Claude menu, with that entry preselected.
- From the Lookbook header, empty.
- From any generated image: **Stage again** loads that image's shot.

**The shot** is one object, used everywhere:
`{location, characters:[{path, variant}], moment:{text, source}, framing:{shot: wide|medium|close, time, notes}, n}`.

**The dialog has three columns:**
- **Left: what's in the shot.**
  - A location picker, and character chips, each with a variant select.
  - A moment box, filled from the selection or scene.
  - Framing controls.
  - Characters mentioned in the moment's text are suggested as chips; matching uses entry titles now, and aliases once they exist.
- **Middle: the assembled prompt,** built by `server/stage.js` → `assemble(root, shot, {maxRefs})`:
  1. Visual style.
  2. Location: fixed traits, then description.
  3. Each character: name as a label only, fixed traits, then description, using the chosen variant's subsection when there is one.
  4. The moment as a visual brief.
  5. Framing.
  6. Avoid.
  - Each part is a labeled block, so the writer can see where every line came from. Edits in the box are kept with the shot.
- **Right: the references.**
  - Chosen by rank: matching variant, then `face`, then `full`, then the location's `establishing` view. Each character gets at least one before anyone gets a second.
  - Capped at the provider's `maxRefs`. Every image can be swapped or removed.
  - Labeled in the prompt in order ("Image 1: Tor, face. Image 2: …").
  - If there are more characters than the cap allows, offer a contact sheet: one grid image of labeled face crops, made in the browser on a `<canvas>` and sent as a single reference.

**Write the shot with Claude** turns the moment's prose into a visual brief: who stands where, what they're doing, the light. It's a one-turn, read-only Agent SDK call from the server (`POST /books/:id/stage/brief`), not a panel run, because the result goes back into the dialog rather than into a file. Its prompt is in `codexprompts.js`, and the call uses the existing auth and token checks from PLAN.md §9.

**Providers in Stage:** a select listing the providers that are set up. In step 2 that's only **Handoff** (the step 1 handoff dialog, given the assembled prompt and the references). Step 4 adds **Local**.

**Tests:**
- `assemble` orders sections and labels references, and the ranking and cap are right.
- A missing style or traits section leaves no empty heading.
- `brief` with a stubbed SDK.

### Step 4: local generation (with step 3's queue and candidates)

**Built** (tried against a fake ComfyUI and the fake provider; not yet against a real ComfyUI). Differences from the plan below:
- **Unused references:** `imagegen/workflows/flux2-klein-9b.json` follows ComfyUI's official *Flux.2 Klein 9B image edit (distilled)* template, with 4 reference chains. Unused reference nodes are removed and their dependents bypassed by type, using ComfyUI's `/object_info`, so one file covers 0–4 references.
- **Check:** `check()` also reports missing model files and unknown nodes per workflow. The provider interface is `check() → {ok, message, models}` rather than separate `models()` and `maxRefs()`.
- **Progress:** the websocket is used for progress when it opens; `/history` polling finds the result either way.
- **Limits:** `server/imagegen/limits.js` has the per-minute wait and the per-day count, saved in `imagegen-usage.json` beside the config. Nothing uses it yet; it's for step 3.
- **Candidates:** stored as planned, plus `count` and `size` in "How it was made", so **Vary** repeats the job. Every note rewrite keeps that section, and the caption leaves it out. Old jobs are pruned when a job starts, not on server startup.
- **Lookbook:** an **Images / Candidates** switch in the header rather than a separate tab. **Keep as reference** asks for the view from a menu. Kept images with a "How it was made" section get **Stage again** in their panel.
- **Turning on the fake provider:** `"imagegen": {"fake": true}` in the config.
- **ComfyUI stays a separate app** (decided after the first build). The editor looks for it on 8000 (Desktop's default) then 8188 unless `imagegen.comfyui.url` is set. **Start ComfyUI** runs `open -a ComfyUI` (token required) and waits up to 2 minutes for it to answer. After `unloadAfterMinutes` (default 10) with no jobs, the editor calls ComfyUI's `POST /free`, and **Unload the model** does the same at once.

**Engine: ComfyUI** (the ComfyUI Desktop app on the Mac). It has a documented local HTTP and WebSocket API: `POST /upload/image`, `POST /prompt`, `/ws` for progress, `/history/<id>` and `/view`. Draw Things is easier to install, but reportedly its HTTP API doesn't do edit mode or references (only its gRPC API does), so it isn't first.

**Models:**
- **FLUX.2 [klein] 9B** as the default: fast, takes several references, and fits easily in 48 GB.
- **Qwen-Image-Edit-2511** as an alternative: strong multi-person consistency, but heavier.
- The README gets setup steps: install ComfyUI Desktop, download the model files, then **Check connection**.

**Workflows are files, not code:**
- `imagegen/workflows/*.json` in local_editor holds workflows in ComfyUI's API format. The editor fills nodes whose title starts with `EDITOR:`: `EDITOR:prompt`, `EDITOR:negative`, `EDITOR:ref1`…`EDITOR:refN` (LoadImage nodes), `EDITOR:seed`, `EDITOR:size` and `EDITOR:save`.
- A workflow's `maxRefs` is its number of ref nodes. Unused ref nodes are bypassed by rewiring, or each workflow ships variants for 1–4 references; pick whichever is simpler once tried.
- A writer can export their own workflow from ComfyUI with those titles and drop it into the folder. `imagegen/workflows/README.md` explains how.

**Provider interface** (`server/imagegen/index.js`):
- Each provider has `{id, label, models(), maxRefs(model), limits, check(), generate({prompt, negative, refs:[abs paths], size, seed, n}, {signal, onProgress}) → [{bytes, seed}]}`.
- `server/imagegen/comfyui.js` implements it. Loopback URLs only (`127.0.0.1` or `localhost`), from `config.imagegen.comfyui.url`, which defaults to `http://127.0.0.1:8188`.
- `server/imagegen/fake.js` returns generated PNGs, for tests and for trying the UI without a model.

**Jobs** (`server/imagegen/jobs.js`):
- Per provider, a FIFO queue with concurrency 1, plus `limits` (requests per minute and per day) enforced from a small persisted counter. Local has no limit; the hook is for step 3's APIs.
- `POST /books/:id/imagegen/jobs {shot, prompt, refs, provider, model, n}` → `{id}`.
- `GET …/jobs/:id/events` streams SSE (queued, position, progress %, image ready, done, error), the same pattern as Claude runs.
- `POST …/jobs/:id/cancel` interrupts the job in ComfyUI.
- Jobs survive a page reload but not a server restart. That's fine for local.

**Candidates:**
- **Where they go:** each job writes to `lookbook/.candidates/<job-id>/<n>.png`, plus `<n>.md`.
  - The note has front matter: `of:` (the shot's entries) and `status: candidate`.
  - Then a `## How it was made` section with a fenced JSON block: provider, model, workflow, seed, size, prompt, references (path plus the commit hash they had), the shot, and the date.
- **Kept out of git without touching the book's files:** the server adds `lookbook/.candidates/` to `.git/info/exclude` the first time it writes one. `listLookbook` already skips dot folders. A new `listCandidates(root)` feeds `tree.candidates`, and the watcher reports them like other lookbook changes.
- **Lookbook:** a **Candidates** tab, grouped by job, newest first.
  - **Keep** moves the image into `lookbook/` with a slug from the shot (`tor-at-the-well-dawn.png`) and its note (provenance kept, `status` dropped). It goes through `structureRoute`, so it commits.
  - **Keep as reference** does the same and sets `use: reference` and `view`.
  - **Discard** deletes it, and **Discard job** deletes the whole job.
  - **Stage again** reopens the shot, and **Vary** reruns it with a new seed.
  - Candidates older than 30 days are pruned on startup (configurable).
- **In Stage:** **Generate** (with an *n* select, 1–4) shows the job's progress inline, and the results appear as they land.

**Tests:**
- A fake ComfyUI server, using express in the test, covering upload, prompt, history and view. The comfyui provider fills `EDITOR:` nodes correctly and handles errors and cancel.
- Queue order and the daily limit.
- Candidate files and exclude entries.
- Keep, Keep as reference and Discard moves.
- Provenance round-trip, and Stage again restoring the shot.

### Step 6: the Claude consistency check

**Run through the Claude panel,** like PLAN.md §11, so the reasoning shows and the result is undoable. The prompt is `checkPrompt({candidates, entries})` in `codexprompts.js`. For each candidate, Claude:
1. Reads the candidate image and, for each entry the shot shows, the reference images, `## Fixed traits` and the Description, plus `codex/visual-style.md`.
2. Writes a `## Consistency check` section in the candidate's note:
   - `verdict: consistent | drift | wrong`;
   - one bullet per problem, naming the entry and trait ("Tor: scar on the left cheek; Fixed traits say right");
   - style problems;
   - a **Prompt fix** subsection with replacement wording for the shot.

   It also sets `check:` in the front matter to the verdict.
3. Doesn't edit codex entries. If the candidate shows something better than the text, it's noted as "Consider for the description" and left for the writer, through Refine (PLAN.md §11) once the image is kept.

**UI:**
- **Check with Claude** on a candidate, and on a whole job (one run for all of its images).
- Candidate cards show the verdict as a badge, colored by result.
- **Apply prompt fix and regenerate** loads the shot in Stage with the fix applied.
- Optional, off by default: **auto-check** after a local job finishes, then regenerate up to *N* times while the verdict is `drift`. Local generation costs nothing, so this loop can run unattended. The Claude panel shows each check as its own run, and the job stops at *N*.

**Tests:**
- `checkPrompt` names every file it should read and forbids codex edits.
- Parsing `check:` into candidate items.
- Applying a prompt fix to a stored shot.

### Open decisions
- **Contact sheets** when there are too many references: decide after seeing how FLUX.2 klein handles 4 or more references on this Mac.
- **Aliases** (PLAN.md §11 "Later") would help character suggestions in Stage. They could come in with step 2.
