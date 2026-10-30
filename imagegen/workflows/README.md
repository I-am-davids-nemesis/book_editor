# Image workflows

Each `.json` file here is a [ComfyUI](https://www.comfy.org/) workflow the editor can run from **Stage a shot → Generate here**. The file name is its id, and the model list shows its label.

## Adding your own

1. Build or open the workflow in ComfyUI and check it works there.
2. Give these nodes a **title** (right-click → Title) so the editor knows what to fill in:

   | Title | Node | What the editor sets |
   |---|---|---|
   | `EDITOR:prompt` | a text encode node | `text`: the prompt |
   | `EDITOR:negative` | a text encode node (optional) | `text`: the negative prompt |
   | `EDITOR:ref1`, `EDITOR:ref2`, … | Load Image | `image`: each reference, in prompt order |
   | `EDITOR:seed` | the noise or sampler node | `noise_seed` or `seed` |
   | `EDITOR:size` | latent and scheduler nodes (any number) | `width` and `height` |
   | `EDITOR:save` | the one Save Image node | where the result comes from |

3. Save it with **Workflow → Export (API)** into this folder. The normal (UI) save format won't work.
4. Optionally add a label and description at the top of the file:

   ```json
   "_editor": { "label": "My model", "description": "Slow but sharp; up to 3 references." },
   ```

The number of `EDITOR:refN` nodes is how many references the workflow takes. When a shot has fewer, the editor removes the unused Load Image nodes and bypasses whatever depended on them, the way ComfyUI's Bypass does (each node's output is replaced by its input of the same type). So build the workflow with the most references you want; one file covers fewer, or none.

**Check again** in the Stage dialog says when ComfyUI is missing a model file or a node the workflow uses.

`flux2-klein-9b.json` follows ComfyUI's *Flux.2 Klein 9B image edit (distilled)* template: each reference is scaled to about a megapixel, encoded, and attached with Reference Latent nodes; 4 steps; CFG 1.
