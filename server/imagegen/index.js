import os from 'node:os';
import path from 'node:path';
import { configPath } from '../config.js';
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
//     "comfyui": { "url": "http://127.0.0.1:8188", "app": "ComfyUI", "start": "~/start_comfy.sh",
//                  "unloadAfterMinutes": 10 },
//     "fake": true
//   }
// Without a url, ComfyUI is looked for on ports 8000 (Desktop) and 8188.
// `start` is a script Start runs instead of opening the app; its output goes
// to comfyui.log beside the config.

const expandHome = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

export function providersFrom(config) {
  const settings = config.imagegen ?? {};
  const comfy = settings.comfyui ?? {};
  const minutes = Number.isFinite(comfy.unloadAfterMinutes) ? comfy.unloadAfterMinutes : 10;
  const list = [new ComfyUIProvider({
    url: comfy.url || null,
    app: comfy.app || 'ComfyUI',
    startScript: typeof comfy.start === 'string' && comfy.start ? expandHome(comfy.start) : null,
    logFile: path.join(path.dirname(configPath()), 'comfyui.log'),
    unloadAfterMs: Math.max(0, minutes) * 60 * 1000,
  })];
  if (settings.fake) list.push(new FakeProvider());
  return list;
}
