import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { agentEnv, buildPrompt, ClaudeService, compact, modelsFrom } from '../server/claude.js';
import { saveConfig } from '../server/config.js';
import { gitBook, gitIn, SAMPLE_BOOK, tempDir } from './helpers.js';

const quiet = { error() {} };

// A stand-in for the SDK's query(): `script(options, prompt)` is an async
// generator that yields SDK-shaped messages and may call the permission
// callback or hooks, like the real agent would.
function fakeQuery(script) {
  const calls = [];
  const query = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return script(options, prompt);
  };
  return { query, calls };
}

async function service(script) {
  const fake = fakeQuery(script);
  const claude = new ClaudeService({ query: fake.query, storeDir: await tempDir(), log: quiet });
  return { claude, calls: fake.calls };
}

test('ask answers a one-off question, reading only inside the book', async () => {
  const root = await tempDir();
  const outside = await tempDir();
  const decisions = [];
  const { claude, calls } = await service(async function* (options) {
    for (const [tool, input] of [
      ['Read', { file_path: path.join(root, 'codex/tor.md') }],
      ['Read', { file_path: path.join(outside, 'secret.md') }],
      ['Edit', { file_path: path.join(root, 'codex/tor.md') }],
      ['Bash', { command: 'ls' }],
    ]) {
      decisions.push([tool, (await options.canUseTool(tool, input, {})).behavior]);
    }
    const hook = await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, 'x.md') } });
    decisions.push(['Write hook', hook.hookSpecificOutput.permissionDecision]);
    yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Draft answer' }] } };
    yield { ...result, result: '  Tor stands at the well.  ' };
  });
  assert.equal(await claude.ask(root, 'Write a brief'), 'Tor stands at the well.');
  assert.deepEqual(decisions, [['Read', 'allow'], ['Read', 'deny'], ['Edit', 'deny'], ['Bash', 'deny'], ['Write hook', 'deny']]);
  const { options } = calls[0];
  assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep']);
  assert.equal(options.model, 'claude-opus-5-5', 'asks use the pinned model');
  assert.equal(options.resume, undefined);
  // No session or checkpoint: the book's store isn't touched.
  assert.deepEqual((await claude.session(root)).sessionId ?? null, null);

  await assert.rejects(claude.ask(root, ''), /Missing prompt/);
  const failing = await service(async function* () {
    yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] };
  });
  await assert.rejects(failing.claude.ask(root, 'x'), (err) => err.status === 502 && /error_max_turns/.test(err.message));
});

// Resolves with all of a run's events once it is over.
function collect(run) {
  return new Promise((resolve) => {
    const events = [];
    run.subscribe((e) => (e ? events.push(e) : resolve(events)));
  });
}

const text = (t) => ({ type: 'stream_event', parent_tool_use_id: null, session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.012, num_turns: 2, duration_ms: 900, session_id: 's1', result: 'done' };

test('streams text and tools, checkpoints before and commits after', async () => {
  const root = await gitBook(SAMPLE_BOOK);
  // Your own unsaved-to-git work, which must land in its own commit first.
  await fs.writeFile(path.join(root, 'outline/01-the-washing-house/01-opening.md'), 'Summary: the bell, louder.\n');
  const { claude, calls } = await service(async function* (options) {
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    yield text('Drafting ');
    yield text('now.');
    const input = { file_path: path.join(options.cwd, 'manuscript/01-the-washing-house/01-opening.md'), content: 'The bell struck one, then two.\n' };
    yield {
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: 's1',
      message: { content: [{ type: 'text', text: 'Drafting now.' }, { type: 'tool_use', id: 't1', name: 'Write', input }] },
    };
    const ok = await options.canUseTool('Write', input, { signal: new AbortController().signal });
    assert.equal(ok.behavior, 'allow');
    await fs.writeFile(input.file_path, input.content);
    yield result;
  });

  const { runId } = await claude.start(root, {
    prompt: 'Draft this scene from its plot\nwith more bells',
    context: { file: 'manuscript/01-the-washing-house/01-opening.md', companion: 'outline/01-the-washing-house/01-opening.md', mode: '', selection: { path: 'x.md', text: 'the bell' } },
  });
  const events = await collect(claude.run(runId, root));
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['start', 'text', 'text', 'tool', 'files', 'done']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Drafting now.', 'text is not sent twice');
  assert.equal(events[3].summary, 'Write manuscript/01-the-washing-house/01-opening.md');
  const files = events.find((e) => e.type === 'files');
  assert.deepEqual(files.files, [{ status: 'M', path: 'manuscript/01-the-washing-house/01-opening.md' }]);
  assert.deepEqual(events.at(-1), { seq: 5, type: 'done', stopped: false, ok: true, cost: 0.012, turns: 2, durationMs: 900 });

  // The prompt carries the editor's context, and the run is confined.
  const { prompt, options } = calls[0];
  assert.match(prompt, /^<editor-context>\nOpen in the editor: manuscript\/01-the-washing-house\/01-opening.md\nBeside it: outline/);
  assert.match(prompt, /Selected text in x.md:\n"""\nthe bell\n"""/);
  assert.match(prompt, /Draft this scene from its plot\nwith more bells$/);
  assert.equal(options.cwd, root);
  assert.deepEqual(options.settingSources, ['project']);
  assert.ok(!options.tools.includes('Bash'), 'Bash is off by default');
  assert.equal(options.resume, undefined);

  // Your edit, then Claude's, as separate commits.
  const log = gitIn(root, 'log', '--format=%s', '-3').trim().split('\n');
  assert.equal(log[0], 'Claude: Draft this scene from its plot');
  assert.match(log[1], /^Autosave: Edit 01-opening/);
  assert.equal(files.before, gitIn(root, 'rev-parse', 'HEAD~1').trim());
  assert.equal(files.commit, gitIn(root, 'rev-parse', '--short', 'HEAD').trim());
  assert.match(gitIn(root, 'log', '-1', '--format=%b'), /M manuscript\/01-the-washing-house\/01-opening.md/);
  assert.equal(gitIn(root, 'show', 'HEAD:outline/01-the-washing-house/01-opening.md'), 'Summary: the bell, louder.\n');

  // The transcript is kept with the session id, outside the book.
  const session = await claude.session(root);
  assert.equal(session.sessionId, 's1');
  assert.equal(session.running, null);
  assert.deepEqual(session.entries.map((e) => e.type), ['start', 'text', 'tool', 'files', 'done']);
  assert.equal(session.entries[1].text, 'Drafting now.');
  assert.equal(gitIn(root, 'status', '--porcelain'), '');
});

test('follow-ups resume the session; a new conversation does not', async () => {
  const root = await gitBook(SAMPLE_BOOK);
  const { claude, calls } = await service(async function* () {
    yield { type: 'system', subtype: 'init', session_id: `s${calls.length}` };
    yield { ...result, session_id: `s${calls.length}` };
  });
  for (const opts of [{}, {}, { newSession: true }]) {
    const { runId } = await claude.start(root, { prompt: 'Hello', ...opts });
    await collect(claude.run(runId, root));
  }
  assert.deepEqual(calls.map((c) => c.options.resume), [undefined, 's1', undefined]);
  const session = await claude.session(root);
  assert.equal(session.sessionId, 's3');
  assert.equal(session.entries.filter((e) => e.type === 'start').length, 1, 'new conversation starts a fresh transcript');

  await claude.clear(root);
  assert.deepEqual(await claude.session(root), { sessionId: null, entries: [], extraTools: 'off', running: null });
});

test('runs that look at images use the image model; others the pinned model', async () => {
  const root = await gitBook(SAMPLE_BOOK);
  const { claude, calls } = await service(async function* () {
    yield result;
  });
  for (const opts of [{}, { model: 'claude-writer' }, { images: true }, { images: true, imageModel: 'claude-other' }]) {
    const { runId } = await claude.start(root, { prompt: 'Look', ...opts });
    await collect(claude.run(runId, root));
  }
  assert.deepEqual(calls.map((c) => c.options.model), ['claude-opus-5-5', 'claude-writer', 'claude-haiku-5-5', 'claude-other']);
  const starts = (await claude.session(root)).entries.filter((e) => e.type === 'start');
  assert.equal(starts.at(-1).model, 'claude-other', 'the panel can show which model ran');
});

test('modelsFrom reads claude.model and claude.imageModel, with defaults', () => {
  assert.deepEqual(modelsFrom({}), { model: 'claude-opus-5-5', imageModel: 'claude-haiku-5-5' });
  assert.deepEqual(modelsFrom({ claude: { model: ' claude-x ', imageModel: '' } }), { model: 'claude-x', imageModel: 'claude-haiku-5-5' });
});

test('approval requests round-trip through the panel', async () => {
  const root = await gitBook(SAMPLE_BOOK);
  const answers = [];
  const { claude, calls } = await service(async function* (options) {
    const signal = new AbortController().signal;
    for (const command of ['ls manuscript', 'rm -rf /']) {
      const decision = await options.canUseTool('Bash', { command }, { signal });
      answers.push(decision);
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: decision.behavior }] } };
    }
    yield result;
  });
  await claude.setSettings(root, { extraTools: 'ask' });
  await assert.rejects(claude.setSettings(root, { extraTools: 'always' }), /extraTools must be one of/);

  const { runId } = await claude.start(root, { prompt: 'List the files' });
  const run = claude.run(runId, root);
  const done = collect(run);
  run.subscribe((e) => {
    if (e?.type === 'permission') run.answer(e.requestId, e.detail === 'ls manuscript');
  });
  const events = await done;
  assert.deepEqual(answers.map((a) => a.behavior), ['allow', 'deny']);
  assert.deepEqual(answers[0].updatedInput, { command: 'ls manuscript' });
  const cards = events.filter((e) => e.type === 'permission');
  assert.deepEqual(cards.map((c) => c.summary), ['Run: ls manuscript', 'Run: rm -rf /']);
  assert.deepEqual(events.filter((e) => e.type === 'permission-done').map((e) => e.allow), [true, false]);
  assert.ok(calls[0].options.tools.includes('Bash'), 'Bash is offered once the setting asks');
  assert.throws(() => run.answer(cards[0].requestId, true), /already answered/);
});

test('stop aborts the run and still commits what it changed', async () => {
  const root = await gitBook(SAMPLE_BOOK);
  let pendingAnswer;
  const { claude } = await service(async function* (options) {
    await fs.writeFile(path.join(options.cwd, 'manuscript/01-the-washing-house/01-opening.md'), 'Half a draft');
    yield text('Working');
    // Waits on an approval that never comes; Stop should end it.
    pendingAnswer = options.canUseTool('WebFetch', { url: 'https://example.com' }, { signal: options.abortController.signal });
    await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve));
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  await claude.setSettings(root, { extraTools: 'ask' });
  const { runId } = await claude.start(root, { prompt: 'Draft it' });
  const run = claude.run(runId, root);
  const done = collect(run);
  await new Promise((resolve) => run.subscribe((e) => { if (e?.type === 'permission') resolve(); }));
  await assert.rejects(claude.start(root, { prompt: 'Another' }), /already working/);
  run.stop();
  const events = await done;
  assert.equal((await pendingAnswer).behavior, 'deny');
  assert.ok(!events.some((e) => e.type === 'error'), 'stopping is not an error');
  assert.deepEqual(events.at(-1).stopped, true);
  assert.deepEqual(events.find((e) => e.type === 'files').files.map((f) => f.path), ['manuscript/01-the-washing-house/01-opening.md']);
  assert.match(gitIn(root, 'log', '-1', '--format=%B'), /^Claude: Draft it\n[\s\S]*stopped before it finished/);
  // The book is free for the next run.
  assert.equal((await claude.session(root)).running, null);
});

test('edits outside the book are refused, whatever the agent asks', async () => {
  const root = await gitBook(SAMPLE_BOOK);
  const outside = await tempDir();
  await fs.symlink(outside, path.join(root, 'escape'));
  const decisions = {};
  const hooks = {};
  const { claude } = await service(async function* (options) {
    const signal = new AbortController().signal;
    const tries = {
      inside: { file_path: path.join(root, 'codex/new.md') },
      relative: { file_path: 'codex/new.md' },
      dotdot: { file_path: '../elsewhere.md' },
      absolute: { file_path: path.join(outside, 'x.md') },
      git: { file_path: path.join(root, '.git/config') },
      symlink: { file_path: path.join(root, 'escape/x.md') },
      none: {},
    };
    const hook = options.hooks.PreToolUse[0].hooks[0];
    for (const [name, input] of Object.entries(tries)) {
      decisions[name] = (await options.canUseTool('Edit', input, { signal })).behavior;
      const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: input });
      hooks[name] = out.hookSpecificOutput?.permissionDecision ?? 'pass';
    }
    decisions.bash = (await options.canUseTool('Bash', { command: 'ls' }, { signal })).behavior;
    hooks.bash = (await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).hookSpecificOutput.permissionDecision;
    decisions.read = (await options.canUseTool('Read', { file_path: path.join(root, 'AGENTS.md') }, { signal })).behavior;
    decisions.grep = (await options.canUseTool('Grep', { pattern: 'bell' }, { signal })).behavior;
    yield result;
  });
  const { runId } = await claude.start(root, { prompt: 'Try everything' });
  await collect(claude.run(runId, root));
  assert.deepEqual(decisions, {
    inside: 'allow', relative: 'allow', dotdot: 'deny', absolute: 'deny', git: 'deny', symlink: 'deny', none: 'deny', bash: 'deny', read: 'allow', grep: 'allow',
  });
  assert.deepEqual(hooks, {
    inside: 'pass', relative: 'pass', dotdot: 'deny', absolute: 'deny', git: 'deny', symlink: 'deny', none: 'deny', bash: 'deny',
  });
});

test('errors from the agent show in the panel and the book is still committed', async () => {
  const root = await gitBook(SAMPLE_BOOK);
  const { claude } = await service(async function* (options) {
    await fs.writeFile(path.join(options.cwd, 'codex/canon-notes.md'), '# Canon\nMore.\n');
    yield { type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] } };
    throw new Error('Claude Code process exited with code 1');
  });
  const { runId } = await claude.start(root, { prompt: 'Note it' });
  const events = await collect(claude.run(runId, root));
  assert.deepEqual(events.filter((e) => e.type === 'error').map((e) => e.message), [
    'Claude Code could not sign in. Run `claude` in a terminal to log in, then try again. (With BOOK_EDITOR_API_KEY=1, check that ANTHROPIC_API_KEY is valid.)',
  ], 'the same failure is reported once');
  assert.equal(events.at(-1).ok, false);
  assert.equal(gitIn(root, 'log', '-1', '--format=%s').trim(), 'Claude: Note it');
});

test('runs use the Claude Code login unless an API key is asked for', () => {
  const env = agentEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-stale' });
  assert.equal(env.PATH, '/bin');
  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal(agentEnv({ ANTHROPIC_API_KEY: 'sk-real', BOOK_EDITOR_API_KEY: '1' }).ANTHROPIC_API_KEY, 'sk-real');
});

test('prompt building and transcript compaction', () => {
  assert.equal(buildPrompt('Just this', {}), 'Just this');
  assert.equal(buildPrompt('Go', { mode: 'camera' }), '<editor-context>\nNarration mode being worked on: camera\n</editor-context>\n\nGo');
  assert.deepEqual(compact([
    { seq: 0, type: 'text', text: 'a' }, { seq: 1, type: 'text', text: 'b' }, { seq: 2, type: 'tool', summary: 'x' }, { seq: 3, type: 'text', text: 'c' },
  ]), [{ type: 'text', text: 'ab' }, { type: 'tool', summary: 'x' }, { type: 'text', text: 'c' }]);
});

// --- over HTTP -------------------------------------------------------------------

let server;
let base;
let app;
let library;

before(async () => {
  const configDir = await tempDir();
  process.env.BOOK_EDITOR_CONFIG = path.join(configDir, 'config.json');
  library = await tempDir();
  await saveConfig({ libraryRoot: library, registered: {} });
  const root = path.join(library, 'sample');
  await fs.mkdir(root);
  for (const [rel, content] of Object.entries(SAMPLE_BOOK)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  gitIn(root, 'init', '-q', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'init');
  const fake = fakeQuery(async function* (options) {
    yield text('Hi');
    await options.canUseTool('Bash', { command: 'pwd' }, { signal: options.abortController.signal });
    yield result;
  });
  app = createApp({ claude: new ClaudeService({ query: fake.query, log: quiet }), token: 'secret-token' });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// Reads an SSE stream until its `end` event.
async function readEvents(url, onEvent = () => {}) {
  const res = await fetch(base + url);
  assert.equal(res.status, 200);
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (/^event: end$/m.test(block)) return events;
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) {
        const e = JSON.parse(data);
        events.push(e);
        await onEvent(e);
      }
    }
  }
  return events;
}

test('the Claude routes need the page token, which the page carries', async () => {
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /<meta name="editor-token" content="secret-token">/);
  assert.equal((await call('GET', '/api/books/sample/claude/session')).status, 403);
  assert.equal((await call('POST', '/api/books/sample/claude/runs', { prompt: 'x' }, { 'X-Editor-Token': 'wrong-token!' })).status, 403);
  assert.equal((await call('POST', '/api/books/sample/claude/runs?token=secret-token', { prompt: 'x' })).status, 403, 'the query token is for GETs only');
  assert.equal((await call('GET', '/api/books/sample/claude/session?token=secret-token')).status, 200);
});

test('a run over HTTP: start, stream, approve, finish', async () => {
  const auth = { 'X-Editor-Token': 'secret-token' };
  const settings = await call('PUT', '/api/books/sample/claude/settings', { extraTools: 'ask' }, auth);
  assert.deepEqual(settings.data, { extraTools: 'ask' });
  assert.equal((await call('POST', '/api/books/sample/claude/runs', { prompt: '  ' }, auth)).status, 400);
  const start = await call('POST', '/api/books/sample/claude/runs', { prompt: 'Where am I?' }, auth);
  assert.equal(start.status, 201);
  const { runId } = start.data;
  assert.equal((await call('GET', '/api/books/sample/claude/session', undefined, auth)).data.running, runId);
  assert.equal((await call('POST', '/api/books/sample/claude/runs', { prompt: 'Again' }, auth)).status, 409);

  const events = await readEvents(`/api/books/sample/claude/runs/${runId}/events?token=secret-token`, async (e) => {
    if (e.type === 'permission') {
      const res = await call('POST', `/api/books/sample/claude/runs/${runId}/permission`, { requestId: e.requestId, allow: true }, auth);
      assert.equal(res.status, 200);
    }
  });
  assert.deepEqual(events.map((e) => e.type), ['start', 'text', 'permission', 'permission-done', 'files', 'done']);
  assert.deepEqual(events.find((e) => e.type === 'files').files, [], 'nothing changed, nothing committed');

  // Replay after a reconnect starts after the last event seen.
  const replay = await readEvents(`/api/books/sample/claude/runs/${runId}/events?token=secret-token&after=3`);
  assert.deepEqual(replay.map((e) => e.type), ['files', 'done']);
  assert.equal((await call('POST', `/api/books/sample/claude/runs/${runId}/stop`, {}, auth)).status, 200, 'stopping a finished run is harmless');
  assert.equal((await call('POST', '/api/books/sample/claude/runs/nope/stop', {}, auth)).status, 404);
  const session = await call('GET', '/api/books/sample/claude/session', undefined, auth);
  assert.equal(session.data.entries.length, 6);
  assert.deepEqual(await call('DELETE', '/api/books/sample/claude/session', undefined, auth), { status: 200, data: { ok: true } });
});
