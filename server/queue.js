// Runs async jobs one at a time per key (here, per book root): structure
// changes rename many files, and a commit must not land halfway through one.
const queues = new Map();

export function serialized(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

// Resolves once the jobs queued so far for `key` have finished.
export async function whenIdle(key) {
  while (queues.has(key)) await queues.get(key);
}
