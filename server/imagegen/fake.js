import zlib from 'node:zlib';

// A provider that makes test patterns instead of pictures: for the tests, and
// for trying the editor without a model. Turn it on with
// `"imagegen": { "fake": true }` in the config.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// A width × height RGB PNG: a diagonal gradient in a colour picked by `seed`.
export function patternPng(width, height, seed = 0) {
  const hue = (Number(seed) * 137) % 360;
  const [r, g, b] = [0, 120, 240].map((shift) => Math.round(127 + 100 * Math.cos(((hue + shift) * Math.PI) / 180)));
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const t = (x + y) / (width + height);
      row[1 + x * 3] = Math.round(r * (1 - t) + 255 * t * 0.3);
      row[2 + x * 3] = Math.round(g * (1 - t));
      row[3 + x * 3] = Math.round(b * (1 - t) + 60 * t);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export class FakeProvider {
  constructor({ stepMs = 250, steps = 4, limits = null } = {}) {
    this.id = 'fake';
    this.label = 'Test patterns (no model)';
    this.stepMs = stepMs;
    this.steps = steps;
    this.limits = limits;
  }

  async check() {
    return {
      ok: true,
      running: true,
      message: 'Makes coloured test patterns, for trying the editor without an image model.',
      models: [{ id: 'pattern', label: 'Test pattern', description: '', maxRefs: 16, ready: true, problem: '' }],
    };
  }

  async generate({ seed = 0, size = { width: 1024, height: 1024 } }, { signal, onProgress = () => {} } = {}) {
    for (let i = 1; i <= this.steps; i += 1) {
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const t = setTimeout(resolve, this.stepMs);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
      });
      onProgress({ fraction: i / this.steps });
    }
    // A quarter size keeps test images small.
    return [{ bytes: patternPng(Math.max(8, size.width >> 2), Math.max(8, size.height >> 2), seed), ext: 'png' }];
  }
}
