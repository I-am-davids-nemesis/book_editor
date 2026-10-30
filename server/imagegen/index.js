import { ComfyUIProvider } from './comfyui.js';
import { FakeProvider } from './fake.js';

// Image generators. Each provider has:
//   id, label, limits ({ perMinute, perDay } or null)
//   check() → { ok, running, message, models: [{ id, label, description, maxRefs, ready, problem }] }
//   optional: canStart, start() → check(); free(); unloadAfterMs (free() after that long idle)
//   generate({ model, prompt, negative, refs: [abs paths], seed, size: { width, height } },
//            { signal, onProgress({ fraction }) }) → [{ bytes, ext }]
//
// Config (in config.json):
//   "imagegen": {
//     "comfyui": { "url": "http://127.0.0.1:8188", "app": "ComfyUI", "unloadAfterMinutes": 10 },
//     "fake": true
//   }
// Without a url, ComfyUI is looked for on ports 8000 (Desktop) and 8188.

export function providersFrom(config) {
  const settings = config.imagegen ?? {};
  const comfy = settings.comfyui ?? {};
  const minutes = Number.isFinite(comfy.unloadAfterMinutes) ? comfy.unloadAfterMinutes : 10;
  const list = [new ComfyUIProvider({ url: comfy.url || null, app: comfy.app || 'ComfyUI', unloadAfterMs: Math.max(0, minutes) * 60 * 1000 })];
  if (settings.fake) list.push(new FakeProvider());
  return list;
}
