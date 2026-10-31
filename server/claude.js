import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkpoint } from './autocommit.js';
import { configPath } from './config.js';
import { badRequest, conflict, HttpError, notFound } from './errors.js';
import { git, isRepo } from './git.js';
import { resolveInBook } from './paths.js';

// Runs Claude Code in a book's folder through the Claude Agent SDK, one run
// per book at a time, and turns what it does into events for the Claude
// panel: text as it arrives, short tool summaries, approval requests, the
// files it changed and the final result. Before a run the book is
// checkpointed; after it, the run's changes are committed as "Claude: …".

// Runs that look at images use a small model: it's enough to say what a
// picture shows, and much cheaper.
export const DEFAULT_IMAGE_MODEL = 'claude-haiku-5-5';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EXTRA_TOOLS = new Set(['Bash', 'WebFetch', 'WebSearch']);
const EXTRA_TOOL_SETTINGS = ['off', 'ask'];

const MAX_PROMPT = 20000;
const ASK_TIMEOUT_MS = 3 * 60 * 1000;
const ASK_MAX_TURNS = 12;
const MAX_SELECTION = 20000;
const MAX_ENTRIES = 2000;

const SYSTEM_APPEND = `You are helping a writer with a novel, from a panel inside their book editor.
The book is plain Markdown in git: manuscript/ holds scenes (pure prose, no front matter), outline/ mirrors it with one plot file per scene, codex/ holds characters, locations and notes. AGENTS.md has the book's conventions.
Files you change reload in the writer's open panes, and the editor commits your changes when you finish. Change only files inside this book. Keep answers in the panel short; the work belongs in the files.`;

// Runs use your Claude Code login. An ANTHROPIC_API_KEY in the shell that
// started the editor would take precedence over it (and is often a stale key
// meant for something else), so it is dropped unless BOOK_EDITOR_API_KEY=1.
export function agentEnv(env = process.env) {
  const out = { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'book-editor/0.1.0' };
  if (env.BOOK_EDITOR_API_KEY !== '1') delete out.ANTHROPIC_API_KEY;
  return out;
}

// The SDK is loaded on first use, so the server starts (and tests run)
// without it.
async function* sdkQuery(args) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  yield* query(args);
}

export class ClaudeService {
  constructor({ query = sdkQuery, log = console, storeDir, onCommitted = () => {} } = {}) {
    this.query = query;
    this.log = log;
    this.onCommitted = onCommitted;
    this.storeDirOverride = storeDir;
    this.runs = new Map(); // runId -> Run (the latest per book is kept for replay)
    this.active = new Map(); // book root -> running Run
  }

  // A one-off question about the book, for answers that go back into a dialog
  // rather than into files: no session, no checkpoint, no approvals. Claude
  // may read and search inside the book and do nothing else. Resolves with
  // its final answer.
  async ask(root, prompt, { signal } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw badRequest('Missing prompt');
    if (prompt.length > MAX_PROMPT) throw badRequest(`The prompt is too long (at most ${MAX_PROMPT} characters)`);
    const policy = new Policy(root, 'off');
    await policy.init();
    const abort = new AbortController();
    signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const timer = setTimeout(() => abort.abort(), ASK_TIMEOUT_MS);
    const readOnly = async (tool, input) => (READ_TOOLS.has(tool) && (await policy.decide(tool, input)).action === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'Only reading and searching inside the book is allowed here.' });
    let text = '';
    let result = null;
    try {
      const messages = this.query({
        prompt,
        options: {
          cwd: root,
          env: agentEnv(),
          settingSources: ['project'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
          tools: [...READ_TOOLS],
          permissionMode: 'default',
          canUseTool: readOnly,
          // Settings can't widen this: anything but an in-book read is refused.
          hooks: {
            PreToolUse: [{
              hooks: [async (input) => {
                if (input?.hook_event_name !== 'PreToolUse') return {};
                const { behavior, message } = await readOnly(input.tool_name, input.tool_input || {});
                return behavior === 'allow' ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } };
              }],
            }],
          },
          maxTurns: ASK_MAX_TURNS,
          abortController: abort,
        },
      });
      for await (const msg of messages) {
        if (msg.parent_tool_use_id) continue;
        if (msg.type === 'assistant') {
          const said = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (said.trim()) text = said;
        } else if (msg.type === 'result') {
          if (msg.is_error) throw new Error(msg.errors?.join('\n') || msg.subtype || 'Claude stopped with an error');
          result = msg.result;
        }
      }
    } catch (err) {
      if (abort.signal.aborted) throw new HttpError(504, signal?.aborted ? 'Cancelled' : 'Claude took too long to answer');
      throw new HttpError(502, friendlyError(err));
    } finally {
      clearTimeout(timer);
    }
    const answer = (typeof result === 'string' && result.trim() ? result : text).trim();
    if (!answer) throw new HttpError(502, 'Claude didn’t answer');
    return answer;
  }

  // Session ids and transcripts live with the editor's config, not in the book.
  storeFile(root) {
    const dir = this.storeDirOverride || path.join(path.dirname(configPath()), 'claude');
    const key = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
    return path.join(dir, `${key}.json`);
  }

  async load(root) {
    try {
      const data = JSON.parse(await fs.readFile(this.storeFile(root), 'utf8'));
      return { sessionId: null, extraTools: 'off', entries: [], ...data };
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.error(`Cannot read the Claude transcript for ${root}: ${err.message}`);
      return { root, sessionId: null, extraTools: 'off', entries: [] };
    }
  }

  async save(root, store) {
    const file = this.storeFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...store, root, entries: store.entries.slice(-MAX_ENTRIES) }, null, 1));
    await fs.rename(tmp, file);
  }

  // What the panel needs after a reload.
  async session(root) {
    const store = await this.load(root);
    const run = this.active.get(root);
    return {
      sessionId: store.sessionId,
      entries: store.entries,
      extraTools: store.extraTools,
      running: run ? run.id : null,
    };
  }

  // New conversation: forget the session and its transcript.
  async clear(root) {
    if (this.active.has(root)) throw conflict('Claude is still working; stop it first');
    const store = await this.load(root);
    await this.save(root, { ...store, sessionId: null, entries: [] });
    return { ok: true };
  }

  async setSettings(root, { extraTools }) {
    if (!EXTRA_TOOL_SETTINGS.includes(extraTools)) throw badRequest(`extraTools must be one of: ${EXTRA_TOOL_SETTINGS.join(', ')}`);
    const store = await this.load(root);
    await this.save(root, { ...store, extraTools });
    return { extraTools };
  }

  run(id, root) {
    const run = this.runs.get(id);
    if (!run || run.root !== root) throw notFound('No such Claude run');
    return run;
  }

  // Starts a run and returns at once; its work streams as events.
  //   images: the run looks at images, so it uses the image model (Haiku
  //   unless the config's claude.imageModel says otherwise)
  async start(root, { prompt, context, newSession = false, images = false, imageModel = DEFAULT_IMAGE_MODEL } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw badRequest('Write a prompt first');
    if (prompt.length > MAX_PROMPT) throw badRequest('That prompt is too long');
    if (this.active.has(root)) throw conflict('Claude is already working on this book');
    const run = new Run(root, prompt.trim(), cleanContext(context));
    for (const [id, old] of this.runs) if (old.root === root) this.runs.delete(id);
    this.runs.set(run.id, run);
    this.active.set(root, run);
    run.model = images === true ? imageModel : null;
    run.done = this.execute(run, { newSession: newSession === true })
      .catch((err) => this.log.error(`Claude run failed in ${root}: ${err.message}`))
      .finally(() => { if (this.active.get(root) === run) this.active.delete(root); });
    return { runId: run.id };
  }

  // Stops every run and waits for their commits (on shutdown).
  async stopAll() {
    const runs = [...this.active.values()];
    for (const run of runs) run.stop();
    await Promise.allSettled(runs.map((r) => r.done));
  }

  async execute(run, { newSession }) {
    const { root } = run;
    const store = await this.load(root);
    if (newSession) Object.assign(store, { sessionId: null, entries: [] });
    run.emit({ type: 'start', prompt: run.prompt, context: run.context, at: new Date().toISOString(), ...(run.model ? { model: run.model } : {}) });

    let before = null;
    const repo = await isRepo(root);
    if (repo) {
      try {
        await checkpoint(root, 'before a Claude run');
        before = await head(root); // null in a repo with no commits yet
      } catch (err) {
        run.emit({ type: 'error', message: `Could not commit your work before the run: ${err.message}` });
        return this.finish(run, store, { before: null, repo: false });
      }
    }

    const policy = new Policy(root, store.extraTools);
    await policy.init();
    try {
      const messages = this.query({
        prompt: buildPrompt(run.prompt, run.context),
        options: {
          cwd: root,
          env: agentEnv(),
          // Project settings only: the book's CLAUDE.md / AGENTS.md apply, and
          // the user's own allow rules can't widen what a run may do.
          settingSources: ['project'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
          tools: [...READ_TOOLS, 'Edit', 'Write', ...(store.extraTools === 'ask' ? EXTRA_TOOLS : [])],
          ...(run.model ? { model: run.model } : {}),
          permissionMode: 'default',
          canUseTool: (tool, input, opts) => this.canUseTool(run, policy, tool, input, opts),
          // A hook runs even where a settings rule would allow the tool, so the
          // book boundary holds whatever the settings say.
          hooks: { PreToolUse: [{ hooks: [(input) => policy.hook(input)] }] },
          includePartialMessages: true,
          abortController: run.abort,
          ...(store.sessionId ? { resume: store.sessionId } : {}),
        },
      });
      const streamed = { text: false };
      for await (const msg of messages) {
        this.handleMessage(run, store, msg, policy, streamed);
      }
    } catch (err) {
      if (!run.abort.signal.aborted) run.fail(friendlyError(err));
    }
    return this.finish(run, store, { before, repo });
  }

  handleMessage(run, store, msg, policy, streamed) {
    if (msg.session_id && msg.session_id !== store.sessionId) {
      store.sessionId = msg.session_id;
    }
    if (msg.parent_tool_use_id) return; // a subagent's inner work
    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        streamed.text = true;
        run.emit({ type: 'text', text: ev.delta.text });
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'text' && !streamed.text && block.text) run.emit({ type: 'text', text: block.text });
        if (block.type === 'tool_use') {
          run.emit({ type: 'tool', id: block.id, name: block.name, summary: summarize(block.name, block.input, policy) });
        }
      }
      streamed.text = false;
      if (msg.error) run.fail(assistantError(msg.error));
    } else if (msg.type === 'user') {
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const block of content) {
        if (block.type === 'tool_result' && block.is_error) {
          run.emit({ type: 'tool-error', id: block.tool_use_id, message: resultText(block.content).slice(0, 500) });
        }
      }
    } else if (msg.type === 'result') {
      run.result = {
        ok: !msg.is_error,
        cost: msg.total_cost_usd ?? null,
        turns: msg.num_turns ?? null,
        durationMs: msg.duration_ms ?? null,
      };
      if (msg.is_error && !run.abort.signal.aborted) {
        const detail = msg.errors?.join('\n') || (msg.subtype === 'success' ? msg.result : msg.subtype);
        run.fail(String(detail || 'Claude stopped with an error'));
      }
    }
  }

  async canUseTool(run, policy, tool, input, { signal } = {}) {
    const decision = await policy.decide(tool, input);
    if (decision.action === 'allow') return { behavior: 'allow', updatedInput: input };
    if (decision.action === 'deny') return { behavior: 'deny', message: decision.reason };
    const allow = await run.ask({ tool, summary: summarize(tool, input, policy), detail: detailOf(tool, input) }, signal);
    return allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'The writer declined this.' };
  }

  // Commits what the run changed and reports it; also stores the transcript.
  async finish(run, store, { before, repo }) {
    run.denyPending();
    let files = [];
    let commit = null;
    if (repo) {
      try {
        const res = await checkpoint(run.root, '', { message: (changes) => runMessage(run.prompt, changes, run.stopped) });
        if (res.committed) commit = res.commit;
        this.onCommitted(run.root);
        // Everything since the checkpoint, in case an autosave (you switching
        // files mid-run) committed part of it already.
        const now = await head(run.root);
        if (before && now && now !== before) files = await changedBetween(run.root, before, now);
        else if (res.committed) files = res.changes.map(({ status, path: p, from }) => ({ status, path: p, ...(from ? { from } : {}) }));
      } catch (err) {
        run.emit({ type: 'error', message: `Could not commit Claude’s changes: ${err.message}` });
      }
    }
    run.emit({ type: 'files', before, commit, files });
    run.emit({ type: 'done', stopped: run.stopped, ...(run.result || { ok: false }) });
    try {
      // Reread the store, so a settings change made during the run is kept.
      const latest = await this.load(run.root);
      await this.save(run.root, { ...latest, sessionId: store.sessionId, entries: [...store.entries, ...compact(run.events)] });
    } catch (err) {
      this.log.error(`Cannot save the Claude transcript: ${err.message}`);
    }
    // Free the book before saying the run is over, so a follow-up can start.
    this.active.delete(run.root);
    run.finished = true;
    run.notify(null); // tells listeners the stream is over
  }
}

class Run {
  constructor(root, prompt, context) {
    this.id = crypto.randomUUID();
    this.root = root;
    this.prompt = prompt;
    this.context = context;
    this.events = [];
    this.listeners = new Set();
    this.pending = new Map(); // requestId -> resolve(allow)
    this.abort = new AbortController();
    this.stopped = false;
    this.finished = false;
    this.result = null;
  }

  emit(event) {
    const e = { seq: this.events.length, ...event };
    this.events.push(e);
    this.notify(e);
  }

  // The agent's first error is the one worth showing; the SDK then reports
  // the same failure again as an error result and a thrown error.
  fail(message) {
    if (this.failed) return;
    this.failed = true;
    this.emit({ type: 'error', message });
  }

  notify(e) {
    for (const fn of this.listeners) fn(e);
  }

  // Sends events after `after` (for replay), then new ones as they come.
  // `send(null)` means the run is over.
  subscribe(send, after = -1) {
    for (const e of this.events) if (e.seq > after) send(e);
    if (this.finished) {
      send(null);
      return () => {};
    }
    this.listeners.add(send);
    return () => this.listeners.delete(send);
  }

  // An approval card in the panel; resolves with the writer's answer.
  ask(request, signal) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const answer = (allow) => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        this.emit({ type: 'permission-done', requestId, allow });
        resolve(allow);
      };
      this.pending.set(requestId, answer);
      signal?.addEventListener('abort', () => answer(false), { once: true });
      this.emit({ type: 'permission', requestId, ...request });
    });
  }

  answer(requestId, allow) {
    const fn = this.pending.get(requestId);
    if (!fn) throw notFound('That request was already answered');
    fn(allow === true);
  }

  denyPending() {
    for (const fn of [...this.pending.values()]) fn(false);
  }

  stop() {
    if (this.finished) return;
    this.stopped = true;
    this.denyPending();
    this.abort.abort();
  }
}

// Decides what a run may do. Reads and searches inside the book are fine;
// edits only inside it (never .git); Bash and web tools only when the book's
// setting asks for them, and then each needs the writer's approval.
class Policy {
  constructor(root, extraTools) {
    this.root = path.resolve(root);
    this.extraTools = extraTools;
  }

  async init() {
    this.realRoot = await fs.realpath(this.root).catch(() => this.root);
  }

  // Book-relative path for one the agent gave, or null if it is outside.
  async inBook(p) {
    if (typeof p !== 'string' || !p) return null;
    for (const base of [this.root, this.realRoot]) {
      const rel = path.isAbsolute(p) ? path.relative(base, p) : p;
      try {
        await resolveInBook(this.root, rel);
        return rel.split(path.sep).join('/');
      } catch {
        // try the next base
      }
    }
    return null;
  }

  rel(p) {
    if (typeof p !== 'string') return '';
    for (const base of [this.root, this.realRoot]) {
      const rel = path.isAbsolute(p) ? path.relative(base, p) : p;
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/') || '.';
    }
    return p;
  }

  async decide(tool, input = {}) {
    if (READ_TOOLS.has(tool)) {
      const target = tool === 'Read' ? input.file_path : input.path;
      if (tool !== 'Read' && !target) return { action: 'allow' };
      if (target === '.' || (await this.inBook(target))) return { action: 'allow' };
      return { action: 'ask' };
    }
    if (WRITE_TOOLS.has(tool)) {
      const target = input.file_path ?? input.notebook_path;
      if (await this.inBook(target)) return { action: 'allow' };
      return { action: 'deny', reason: `Only files inside the book can be changed; ${target || 'that path'} is outside it.` };
    }
    if (EXTRA_TOOLS.has(tool)) {
      if (this.extraTools === 'ask') return { action: 'ask' };
      return { action: 'deny', reason: `${tool} is switched off for this book. The writer can turn it on in the Claude panel's settings.` };
    }
    return { action: 'ask' };
  }

  // PreToolUse hook: denials are final here, and Bash or web tools always
  // come back to the writer, whatever a settings file allows.
  async hook(input) {
    if (input?.hook_event_name !== 'PreToolUse') return {};
    const tool = input.tool_name;
    if (!WRITE_TOOLS.has(tool) && !EXTRA_TOOLS.has(tool)) return {};
    const decision = await this.decide(tool, input.tool_input || {});
    if (decision.action === 'allow') return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.action,
        ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
      },
    };
  }
}

// --- prompt and context --------------------------------------------------------

const oneLine = (s, max = 500) => (typeof s === 'string' ? s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '');

// Keeps only the fields the panel sends, trimmed to sane sizes.
export function cleanContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  const out = {};
  if (oneLine(c.file)) out.file = oneLine(c.file);
  if (oneLine(c.companion)) out.companion = oneLine(c.companion);
  if (typeof c.mode === 'string') out.mode = oneLine(c.mode, 60);
  if (c.selection && typeof c.selection.text === 'string' && c.selection.text.trim()) {
    out.selection = { path: oneLine(c.selection.path), text: c.selection.text.slice(0, MAX_SELECTION) };
  }
  return out;
}

export function buildPrompt(prompt, context = {}) {
  const lines = [];
  if (context.file) lines.push(`Open in the editor: ${context.file}`);
  if (context.companion) lines.push(`Beside it: ${context.companion}`);
  if (context.mode) lines.push(`Narration mode being worked on: ${context.mode}`);
  if (context.selection) {
    lines.push(`Selected text${context.selection.path ? ` in ${context.selection.path}` : ''}:`, '"""', context.selection.text, '"""');
  }
  if (!lines.length) return prompt;
  return `<editor-context>\n${lines.join('\n')}\n</editor-context>\n\n${prompt}`;
}

// --- describing tool calls -------------------------------------------------------

function clip(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function summarize(tool, input = {}, policy = null) {
  const rel = (p) => (policy ? policy.rel(p) : String(p ?? ''));
  switch (tool) {
    case 'Read': return `Read ${rel(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Edit ${rel(input.file_path)}`;
    case 'Write': return `Write ${rel(input.file_path)}`;
    case 'NotebookEdit': return `Edit ${rel(input.notebook_path)}`;
    case 'Glob': return `Find files: ${clip(input.pattern, 120)}${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Grep': return `Search for “${clip(input.pattern, 120)}”${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Bash': return `Run: ${clip(input.command, 200)}`;
    case 'WebFetch': return `Fetch ${clip(input.url, 200)}`;
    case 'WebSearch': return `Search the web: ${clip(input.query, 200)}`;
    case 'TodoWrite': return 'Update its to-do list';
    default: return tool;
  }
}

function detailOf(tool, input = {}) {
  if (tool === 'Bash') return clip(input.command, 4000);
  if (tool === 'WebFetch') return clip(`${input.url}\n\n${input.prompt ?? ''}`.trim(), 4000);
  if (tool === 'WebSearch') return clip(input.query, 4000);
  return clip(JSON.stringify(input, null, 2), 4000);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

function assistantError(code) {
  const messages = {
    authentication_failed: 'Claude Code could not sign in. Run `claude` in a terminal to log in, then try again. (With BOOK_EDITOR_API_KEY=1, check that ANTHROPIC_API_KEY is valid.)',
    billing_error: 'Claude reported a billing problem with your account.',
    rate_limit: 'Claude is rate limited right now; try again in a little while.',
    overloaded: 'Claude is overloaded right now; try again in a little while.',
  };
  return messages[code] || `Claude reported an error (${code}).`;
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/Cannot find (package|module) '@anthropic-ai\/claude-agent-sdk'/.test(msg)) {
    return 'The Claude Agent SDK is not installed. Run `npm install` in the editor folder.';
  }
  if (/ENOENT|not found/i.test(msg) && /claude/i.test(msg)) {
    return `Could not start Claude Code: ${msg}`;
  }
  return msg;
}

// --- commits and transcripts ------------------------------------------------------

async function head(root) {
  try {
    return (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

async function changedBetween(root, from, to) {
  const out = await git(root, ['diff', '--name-status', '-M', from, to]);
  return out.trim().split('\n').filter(Boolean).map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status: status[0], path: paths.at(-1), ...(paths.length > 1 ? { from: paths[0] } : {}) };
  });
}

function runMessage(prompt, changes, stopped) {
  const first = prompt.split('\n').find((l) => l.trim())?.trim() || 'run';
  const subject = `Claude: ${first.length > 60 ? `${first.slice(0, 59)}…` : first}`;
  const lines = changes.map((c) => `${c.status} ${c.from ? `${c.from} -> ` : ''}${c.path}`);
  return `${subject}\n\n${lines.join('\n')}\n${stopped ? '\nThe run was stopped before it finished.\n' : ''}`;
}

// The run's events, with streamed text joined into whole blocks, for the
// stored transcript.
export function compact(events) {
  const out = [];
  for (const { seq, ...e } of events) {
    const last = out.at(-1);
    if (e.type === 'text' && last?.type === 'text') last.text += e.text;
    else out.push({ ...e });
  }
  return out;
}
