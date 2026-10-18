// Turns the server's commit list into rows for the History view: autosave
// runs folded into one row, and lanes for drawing the branch lines.
// Pure functions (no DOM), so they're tested in Node.

// A run of autosave commits can fold into one row when it is a straight line
// (each commit's only parent is the next one), nothing else branches off or
// merges into its middle, and no branch points at a commit inside it.
//
// `worktree` (the uncommitted changes) adds a row on top whose parent is
// `worktree.parent` (the HEAD commit).
export function buildNodes(commits, { expanded = new Set(), namedOnly = false, worktree = null } = {}) {
  const index = new Map(commits.map((c, i) => [c.hash, i]));
  const childCount = new Map();
  for (const c of commits) for (const p of c.parents) childCount.set(p, (childCount.get(p) || 0) + 1);

  // Which node each commit belongs to.
  const nodeOf = new Map();
  const nodes = [];
  let i = 0;
  while (i < commits.length) {
    const c = commits[i];
    let j = i;
    if (c.auto) {
      while (j + 1 < commits.length) {
        const cur = commits[j];
        const next = commits[j + 1];
        if (!next.auto || cur.parents.length !== 1 || cur.parents[0] !== next.hash) break;
        if (childCount.get(next.hash) !== 1 || next.refs.length || next.head) break;
        j++;
      }
    }
    const run = commits.slice(i, j + 1);
    if (run.length > 1 && !expanded.has(run[0].hash)) {
      const node = groupNode(run);
      nodes.push(node);
      for (const m of run) nodeOf.set(m.hash, node);
    } else {
      for (const m of run) {
        const node = commitNode(m);
        nodes.push(node);
        nodeOf.set(m.hash, node);
      }
    }
    i = j + 1;
  }

  // "Named save points only" hides autosave rows that aren't branch tips;
  // lines skip through them to the next visible ancestor.
  const hidden = (node) => namedOnly && node.auto && !node.refs.length && !node.head;
  const memo = new Map();
  const visibleFor = (hash, seen = new Set()) => {
    if (memo.has(hash)) return memo.get(hash);
    const node = nodeOf.get(hash);
    let out;
    if (!node) out = hash; // not loaded yet: the line runs off the bottom
    else if (!hidden(node)) out = node.id;
    else if (seen.has(hash)) out = null;
    else {
      seen.add(hash);
      const first = node.parents[0];
      out = first ? visibleFor(first, seen) : null;
    }
    memo.set(hash, out);
    return out;
  };

  const visible = nodes.filter((n) => !hidden(n));
  for (const n of visible) {
    n.parentIds = [...new Set(n.parents.map((p) => visibleFor(p)).filter((p) => p && p !== n.id))];
  }
  // Keep the original order (index of the newest commit in the node).
  visible.sort((a, b) => index.get(a.hash) - index.get(b.hash));
  if (worktree) {
    visible.unshift({
      id: 'worktree',
      kind: 'worktree',
      hash: null,
      commits: [],
      parents: worktree.parent ? [worktree.parent] : [],
      parentIds: worktree.parent ? [visibleFor(worktree.parent)].filter(Boolean) : [],
      refs: [],
      head: false,
      auto: false,
      files: worktree.files,
    });
  }
  return visible;
}

function commitNode(c) {
  return {
    id: c.hash,
    kind: 'commit',
    hash: c.hash,
    commits: [c],
    parents: c.parents,
    refs: c.refs,
    head: c.head,
    auto: c.auto,
    subject: c.subject,
    date: c.date,
  };
}

function groupNode(run) {
  const newest = run[0];
  const oldest = run.at(-1);
  return {
    id: `group:${newest.hash}`,
    kind: 'group',
    hash: newest.hash,
    commits: run,
    parents: oldest.parents,
    refs: newest.refs,
    head: newest.head,
    auto: true,
    subject: newest.subject,
    date: newest.date,
    oldestDate: oldest.date,
    // The state just before the run, for "what changed in these autosaves".
    base: oldest.parents[0] ?? null,
  };
}

// Assigns each node a lane (column) and works out the line segments between
// consecutive rows. Nodes come newest first; `parentIds` link them (an id that
// isn't in the list is a parent not loaded yet, and its line runs off the end).
//
// Each row gets:
//   lane      the column of its dot
//   color     color index of its lane
//   segments  lines from this row down to the next: { from, to, color },
//             where from/to are columns (from = this row, to = next row)
export function layoutGraph(nodes) {
  const lanes = []; // id each lane is waiting for, or null
  const colors = [];
  let nextColor = 0;
  const free = () => {
    const k = lanes.indexOf(null);
    return k === -1 ? lanes.length : k;
  };

  const rows = nodes.map((node) => {
    let lane = lanes.indexOf(node.id);
    if (lane === -1) {
      lane = free();
      lanes[lane] = node.id;
      colors[lane] = nextColor++;
    }
    // Other lanes waiting for this node merge into its dot.
    const merging = [];
    for (let k = 0; k < lanes.length; k++) {
      if (k !== lane && lanes[k] === node.id) {
        merging.push(k);
        lanes[k] = null;
      }
    }
    const color = colors[lane];
    const [first, ...others] = node.parentIds;
    lanes[lane] = first ?? null;
    const forks = [];
    for (const p of others) {
      let k = lanes.indexOf(p);
      if (k === -1) {
        k = free();
        lanes[k] = p;
        colors[k] = nextColor++;
      }
      forks.push(k);
    }
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { node, lane, color, merging, forks, after: lanes.slice(), colorsAfter: colors.slice(0, lanes.length) };
  });

  // Segments from row i to row i+1.
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    row.segments = [];
    row.after.forEach((id, k) => {
      if (id === null) return;
      const from = row.forks.includes(k) ? row.lane : k;
      const to = next && id === next.node.id ? next.lane : k;
      row.segments.push({ from, to, color: row.colorsAfter[k], offEnd: !next });
    });
  });
  const width = Math.max(1, ...rows.map((r) => Math.max(r.lane + 1, r.after.length)));
  return { rows, width };
}
