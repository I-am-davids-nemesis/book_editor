import fs from 'node:fs/promises';
import path from 'node:path';
import { configPath } from '../config.js';
import { HttpError } from '../errors.js';

// Rate limits for a provider: { perMinute, perDay } images (either may be
// left out). Local generation has none; the hook is for paid or free APIs.
// The day's count is saved beside the config, so a restart doesn't reset it.

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export class UsageFile {
  constructor(file = path.join(path.dirname(configPath()), 'imagegen-usage.json')) {
    this.file = file;
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  async write(data) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2) + '\n');
  }
}

export class Limiter {
  constructor(providerId, limits, { store = new UsageFile(), now = () => Date.now() } = {}) {
    this.providerId = providerId;
    this.limits = limits ?? {};
    this.store = store;
    this.now = now;
    this.recent = []; // times of the last minute's images
  }

  async usedToday() {
    const entry = (await this.store.read())[this.providerId];
    return entry?.day === dayOf(this.now()) ? entry.count : 0;
  }

  // Waits for a slot this minute, then counts one image against today.
  // Throws a 429 once today's limit is used up.
  async take(signal) {
    const { perMinute, perDay } = this.limits;
    if (perDay && (await this.usedToday()) >= perDay) {
      throw new HttpError(429, `Today’s limit of ${perDay} images is used up; it resets at midnight UTC`);
    }
    if (perMinute) {
      for (;;) {
        this.recent = this.recent.filter((t) => this.now() - t < 60000);
        if (this.recent.length < perMinute) break;
        const wait = 60000 - (this.now() - this.recent[0]);
        await new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          const t = setTimeout(resolve, Math.max(10, wait));
          signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
        });
      }
      this.recent.push(this.now());
    }
    if (perDay) {
      const data = await this.store.read();
      const day = dayOf(this.now());
      const count = data[this.providerId]?.day === day ? data[this.providerId].count : 0;
      data[this.providerId] = { day, count: count + 1 };
      await this.store.write(data);
    }
  }
}
