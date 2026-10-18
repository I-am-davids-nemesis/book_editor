import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNodes, layoutGraph } from '../public/js/graph.js';

// c(hash, parents, opts): a commit as the server sends it.
const c = (hash, parents = [], { auto = false, refs = [], head = false } = {}) =>
  ({ hash, parents, auto, refs, head, subject: auto ? `Autosave: ${hash}` : hash, date: '2026-10-18T10:00:00Z', files: [] });

test('autosave runs fold into one row; named commits and branch tips break runs', () => {
  const commits = [
    c('a6', ['a5'], { auto: true, refs: ['main'], head: true }),
    c('a5', ['a4'], { auto: true }),
    c('a4', ['n3'], { auto: true }),
    c('n3', ['a2']),
    c('a2', ['a1'], { auto: true }),
    c('a1', ['n0'], { auto: true, refs: ['old-tip'] }),
    c('n0'),
  ];
  const nodes = buildNodes(commits);
  assert.deepEqual(nodes.map((n) => n.id), ['group:a6', 'n3', 'a2', 'a1', 'n0']);
  const [group] = nodes;
  assert.deepEqual(group.commits.map((x) => x.hash), ['a6', 'a5', 'a4']);
  assert.equal(group.base, 'n3');
  assert.deepEqual(group.parentIds, ['n3']);
  assert.equal(group.head, true);

  const open = buildNodes(commits, { expanded: new Set(['a6']) });
  assert.deepEqual(open.slice(0, 3).map((n) => n.id), ['a6', 'a5', 'a4']);
});

test('a commit something branches from stays its own row', () => {
  const commits = [
    c('b1', ['a2'], { refs: ['draft'] }),
    c('a3', ['a2'], { auto: true, refs: ['main'], head: true }),
    c('a2', ['a1'], { auto: true }),
    c('a1', ['n0'], { auto: true }),
    c('n0'),
  ];
  const ids = buildNodes(commits).map((n) => n.id);
  // a2 has two children (b1 and a3), so a3 can't absorb it; a2+a1 fold.
  assert.deepEqual(ids, ['b1', 'a3', 'group:a2', 'n0']);
});

test('named-only hides autosaves and links through them', () => {
  const commits = [
    c('a2', ['n1'], { auto: true, refs: ['main'], head: true }),
    c('n1', ['a0']),
    c('a0', ['n00'], { auto: true }),
    c('n00'),
  ];
  const nodes = buildNodes(commits, { namedOnly: true, expanded: new Set(['a2']) });
  assert.deepEqual(nodes.map((n) => [n.id, n.parentIds]), [['a2', ['n1']], ['n1', ['n00']], ['n00', []]]);
});

test('worktree row sits on top of HEAD', () => {
  const nodes = buildNodes([c('n1', ['n0'], { refs: ['main'], head: true }), c('n0')], { worktree: { parent: 'n1', files: [] } });
  assert.deepEqual(nodes.map((n) => [n.id, n.parentIds]), [['worktree', ['n1']], ['n1', ['n0']], ['n0', []]]);
});

test('layoutGraph: a straight line uses one lane', () => {
  const { rows, width } = layoutGraph(buildNodes([c('c3', ['c2']), c('c2', ['c1']), c('c1')]));
  assert.equal(width, 1);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows[0].segments, [{ from: 0, to: 0, color: 0, offEnd: false }]);
  assert.deepEqual(rows[2].segments, []);
});

test('layoutGraph: a branch forks into a second lane and a merge joins it', () => {
  // m merges b (draft) into a; both come from root r.
  //   m
  //   |\
  //   a b
  //   |/
  //   r
  const nodes = buildNodes([c('m', ['a', 'b']), c('a', ['r']), c('b', ['r']), c('r')]);
  const { rows, width } = layoutGraph(nodes);
  assert.equal(width, 2);
  assert.deepEqual(rows.map((r) => [r.node.id, r.lane]), [['m', 0], ['a', 0], ['b', 1], ['r', 0]]);
  // m forks a line out to lane 1 (towards b)
  assert.deepEqual(rows[0].segments.map((s) => [s.from, s.to]), [[0, 0], [0, 1]]);
  // from a: lane 0 continues to r (passes b's row), lane 1 goes to b
  assert.deepEqual(rows[1].segments.map((s) => [s.from, s.to]), [[0, 0], [1, 1]]);
  // from b: lane 0 passes down to r, lane 1 merges into r's lane
  assert.deepEqual(rows[2].segments.map((s) => [s.from, s.to]), [[0, 0], [1, 0]]);
  assert.notEqual(rows[2].color, rows[1].color);
});

test('layoutGraph: two branch tips side by side, line off the end for unloaded parents', () => {
  const nodes = buildNodes([c('t1', ['base'], { refs: ['main'] }), c('t2', ['base'], { refs: ['draft'] })]);
  const { rows } = layoutGraph(nodes);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1]);
  // Both lanes wait for "base", which isn't loaded: the lines run off the end.
  assert.ok(rows[1].segments.every((s) => s.offEnd));
});
