// Source control panel: branch, staged and working changes (list or tree), commit history, diffs.
//
// Modified from Herdr's shipped `changes` mod (https://github.com/herdrdev/herdr-app, Apache-2.0).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git: the folder watch would refresh again.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color"];
const MAX_FILES = 1000, MAX_COMMITS = 100, MAX_LINES = 1500;
const LOG = ["log", "--topo-order", "--decorate=full", "-n", String(MAX_COMMITS), "--branches", "--remotes", "--tags", "HEAD", "--format=%H%x1f%P%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const letter = (c) => c === "D" ? "D" : c === "A" ? "A" : "M";
const markColor = (t, s) => s === "A" ? t.ansi2 : s === "D" || s === "!" ? t.ansi1 : t.ansi3;
const MARK_NAME = { M: "Modified", A: "Added", D: "Deleted", U: "Untracked", "!": "Conflict" };
const ICON = (name) => `mods/git-panel/${name}.svg`, OWN = ICON;
const UNITS = { minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };
const age = (s) => { const m = /^(\d+) (second|minute|hour|day|week|month|year)/.exec(s); return !m ? s : m[2] === "second" ? "now" : m[1] + UNITS[m[2]]; };

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

function parseStatus(stdout) {
  const entries = stdout.split("\0").filter(Boolean), head = entries.shift()?.slice(3) ?? "";
  const m = /^(?:No commits yet on )?(.+?)(?:\.\.\.\S+)?(?: \[(.*)\])?$/.exec(head);
  const branch = { name: m?.[1] ?? "", ahead: +(/ahead (\d+)/.exec(m?.[2] ?? "")?.[1] ?? 0), behind: +(/behind (\d+)/.exec(m?.[2] ?? "")?.[1] ?? 0) };
  const staged = [], work = [];
  for (const entry of entries.slice(0, MAX_FILES)) {
    const xy = entry.slice(0, 2), path = entry.slice(3);
    if (xy === "??") work.push({ path, s: "A", fresh: true });
    else if (xy.includes("U") || xy === "AA" || xy === "DD") work.push({ path, s: "!" });
    else {
      if (xy[0] !== " ") staged.push({ path, s: letter(xy[0]) });
      if (xy[1] !== " ") work.push({ path, s: letter(xy[1]) });
    }
  }
  return { branch, staged, work, limited: entries.length > MAX_FILES };
}

// `%D` with --decorate=full: refs/heads/x, refs/remotes/o/x, tag: refs/tags/x, HEAD -> refs/heads/x, HEAD.
function parseRefs(raw) {
  const refs = [];
  let head = false;
  for (let r of raw ? raw.split(", ") : []) {
    if (r.startsWith("HEAD")) { head = true; if (!r.includes(" -> ")) continue; r = r.split(" -> ")[1]; }
    if (r.startsWith("tag: refs/tags/")) refs.push({ name: r.slice(15), kind: "tag" });
    else if (r.startsWith("refs/heads/")) refs.push({ name: r.slice(11), kind: "local" });
    else if (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD")) refs.push({ name: r.slice(13), kind: "remote" });
  }
  // A remote ref that matches a local branch on the same commit says nothing new.
  const local = new Set(refs.filter((r) => r.kind === "local").map((r) => r.name));
  return { head, refs: refs.filter((r) => r.kind !== "remote" || !local.has(r.name.slice(r.name.indexOf("/") + 1))) };
}

function parseLog(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, parents, short, author, when, refs, subject] = line.split("\x1f");
    return { hash, parents: parents ? parents.split(" ") : [], short, author, when, subject, ...parseRefs(refs) };
  });
}

// Lanes from parent hashes. Each lane waits for one hash; a commit takes the lane that waits for it.
// Per commit: `through` lanes cross the row, `into` lanes end in this commit (a branch merged here),
// `out` lanes start or join at this row (second and later parents), `below` lanes are alive after it.
function layoutGraph(commits) {
  const lanes = [], free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  let width = 1;
  for (const c of commits) {
    const above = lanes.flatMap((h, i) => h ? [i] : []);
    let col = lanes.indexOf(c.hash);
    c.tip = col < 0;
    if (col < 0) col = free();
    c.col = col; c.through = []; c.into = []; c.out = [];
    for (const i of above) if (lanes[i] !== c.hash) c.through.push(i); else if (i !== col) c.into.push(i);
    for (const i of c.into) lanes[i] = null;
    lanes[col] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      const fresh = k < 0;
      if (fresh) { k = free(); lanes[k] = p; }
      c.out.push({ k, fresh });
    }
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    c.below = lanes.flatMap((h, i) => h ? [i] : []);
    width = Math.max(width, col + 1, lanes.length, ...c.through.map((i) => i + 1), ...c.into.map((i) => i + 1));
  }
  return width;
}

const ROW = 24, GRAPH_MAX = 120;
const laneWidth = (n) => n <= 8 ? 12 : Math.max(6, Math.floor(96 / n));
const laneColor = (t, i) => [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1][i % 6];

// One row of the graph: 2px lines and rounded corners, all absolute, so lanes join at every row edge.
function graphCell(c, n, L, t, fill) {
  const x = (i) => i * L + L / 2, mid = ROW / 2, R = L / 2, col = x(c.col);
  const line = (i, top, h) => div().absolute().left(x(i) - 1).top(top).w(2).h(h).bg(laneColor(t, i));
  const flat = (from, to, i) => div().absolute().left(Math.min(from, to)).top(mid - 1).w(Math.abs(to - from)).h(2).bg(laneColor(t, i));
  const corner = (i, down) => {
    const right = x(i) > col, e = div().absolute().w(R + 2).h(down ? ROW - mid + 1 : mid + 1).top(down ? mid - 1 : 0)
      .left(right ? x(i) - R - 1 : x(i) - 1).border_color(laneColor(t, i)).when(down, (e) => e.border_t(2)).when(!down, (e) => e.border_b(2));
    if (right) return e.border_r(2).when(down, (e) => e.rounded_tr(R + 1)).when(!down, (e) => e.rounded_br(R + 1));
    return e.border_l(2).when(down, (e) => e.rounded_tl(R + 1)).when(!down, (e) => e.rounded_bl(R + 1));
  };
  const edge = (i) => x(i) > col ? x(i) - R - 1 : x(i) + R + 1;
  const parts = c.through.map((i) => line(i, 0, ROW));
  for (const j of c.into) parts.push(flat(col, edge(j), j), corner(j, false));
  for (const { k, fresh } of c.out) parts.push(...(fresh ? [flat(col, edge(k), k), corner(k, true)] : [flat(col, x(k), k)]));
  if (!c.tip) parts.push(line(c.col, 0, mid));
  if (c.parents.length) parts.push(line(c.col, mid, ROW - mid));
  const tint = laneColor(t, c.col);
  const dot = c.head ? div().size(12).rounded_full().border_2().border_color(tint).bg(fill).flex().items_center().justify_center().child(div().size(4).rounded_full().bg(tint))
    : c.parents.length > 1 ? div().size(8).rounded_full().border_2().border_color(tint).bg(fill)
    : div().size(8).rounded_full().bg(tint);
  const s = c.head ? 12 : 8;
  parts.push(dot.absolute().left(col - s / 2).top(mid - s / 2));
  return div().relative().flex_none().w(Math.min(n * L, GRAPH_MAX)).h(ROW).overflow_hidden().children(parts);
}

export default class GitPanel extends View {
  init(_props, cx) {
    this.staged = []; this.work = []; this.commits = []; this.branch = null; this.rows = []; this.diffWidth = 0; this.lanes = 1;
    this.collapsed = new Set(); this.tree = false; this.sel = null; this.openCommit = null; this.commitFiles = new Map();
    this.caps = { staged: 140, work: 224 };
    try { Object.assign(this.caps, JSON.parse(localStorage.getItem("caps") ?? "{}")); } catch {}
    this.title = ""; this.hot = null; this.wheelAt = 0; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit title · Enter to commit" });
    this.body = TextareaState.new({ placeholder: "Description (optional)" });
    this.body.set_auto_grow(2, 6);
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.title.trim());
      this.title = this.input.value();
      if (had !== Boolean(this.title.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.query = "";
    this.filter = InputState.new({ placeholder: "Switch to or create a branch" });
    this.filter.on("change", (_e, cx) => { this.query = this.filter.value(); cx.notify(); });
    this.filter.on("submit", (_e, cx) => {
      const q = this.query.trim(), match = this.branches?.find((b) => b.name === q);
      match ? this.checkout(match, cx) : this.createBranch(q, cx);
    });
    for (const [state, name] of [[this.input, "typingTitle"], [this.body, "typingBody"]]) {
      state.on("focus", (_e, cx) => { this[name] = true; cx.notify(); });
      state.on("blur", (_e, cx) => { this[name] = false; cx.notify(); });
    }
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.refresh(cx); } }
      catch { this.watched = null; }
    });
  }

  async git(args, lenient) {
    const r = await exec("git", [...READ, ...args], { cwd: this.root, on: this.on });
    if (r.code !== 0 && !lenient) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
    return r;
  }

  reset() {
    this.root = null; this.staged = []; this.work = []; this.commits = []; this.branch = null; this.openCommit = null;
    this.commitFiles = new Map(); this.clearSel(); this.clearMessage(); this.error = null; this.note = null;
    this.watched = null; this.limited = false; this.lanes = 1; this.sig = null; this.branches = null;
  }

  clearSel() { this.sel = null; this.setLines([]); }

  clearMessage() { this.title = ""; this.input.set_value(""); this.body.set_value(""); }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((l) => l.length * 7 + 50));
  }

  refresh(cx) {
    if (this.loading) { this.dirty = true; return; }
    if (this.busy) { this.spinning = false; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!cwd) { this.spinning = false; return; }
    this.loading = true;
    let changed = true;
    cx.spawn(async (cx) => {
      try {
        // The root only changes with the context, which resets it.
        if (!this.root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (key() !== context) return;
          if (top.code !== 0) { this.reset(); this.context = context; this.error = "Not a git repository"; return; }
          this.root = top.stdout.trim(); this.on = on;
        }
        // log fails only without commits, so it also says whether HEAD exists.
        const [status, log] = await Promise.all([this.git(["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]), this.git(LOG, true)]);
        if (key() !== context) return;
        const sig = status.stdout + "\0\0" + log.code + log.stdout;
        // Most refreshes come from file events that change nothing git reports: skip the rebuild and the redraw.
        // An edit to a file that is already modified leaves the status as it was, so an open diff still reloads.
        if (sig === this.sig && !this.error) {
          if (!this.sel || this.sel.kind === "commit") { changed = false; return; }
          await this.loadDiff(this.sel, context).catch(() => {});
          return;
        }
        this.sig = sig;
        const s = parseStatus(status.stdout), commits = log.code === 0 ? parseLog(log.stdout) : [];
        Object.assign(this, { branch: s.branch, staged: s.staged, work: s.work, limited: s.limited, hasHead: log.code === 0, commits, lanes: layoutGraph(commits), error: null });
        this.watch(this.root, cx);
        if (this.sel && this.sel.kind !== "commit" && !(this.sel.kind === "staged" ? this.staged : this.work).some((f) => f.path === this.sel.path)) this.clearSel();
        if (this.sel) await this.loadDiff(this.sel, context).catch(() => { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); });
      } catch (e) { if (key() === context) { this.error = String(e); this.root = null; this.sig = null; } }
      finally {
        this.loading = false;
        if (this.dirty) { this.dirty = false; this.refresh(cx); }
        else if (this.spinning) { this.spinning = false; changed = true; }
        if (changed) cx.notify();
      }
    });
  }

  async loadDiff(sel, context) {
    let lines;
    if (sel.kind === "work" && sel.fresh) {
      const text = await readTextFile(`${this.root}/${sel.path}`, { on: this.on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else lines = [`@@ -0,0 +1,${countLines(text)} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, MAX_LINES).map((l) => `+${l}`)];
    } else {
      const base = sel.kind === "staged" ? ["diff", "--cached"] : sel.kind === "commit" ? ["show", "--format=", sel.hash] : ["diff"];
      const r = await this.git([...base, ...DIFF, "--", sel.path]);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? ["Binary file changed or no text diff available"] : all.slice(first);
    }
    if (key() === context && this.sel === sel) this.setLines(lines.slice(0, MAX_LINES).map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l));
  }

  select(sel, cx) {
    const same = this.sel && this.sel.kind === sel.kind && this.sel.path === sel.path && this.sel.hash === sel.hash;
    if (same) { this.clearSel(); cx.notify(); return; }
    this.sel = sel; this.setLines([]); this.note = null;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await this.loadDiff(sel, context); }
      catch (e) { if (key() === context && this.sel === sel) this.note = `Cannot preview this diff: ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  toggleCommit(hash, cx) {
    this.openCommit = this.openCommit === hash ? null : hash;
    if (!this.openCommit || this.commitFiles.has(hash)) { cx.notify(); return; }
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        const r = await this.git(["diff-tree", "-r", "--root", "--no-commit-id", "--name-status", "--no-renames", "-z", hash]);
        const f = r.stdout.split("\0"), files = [];
        for (let i = 0; i + 1 < f.length; i += 2) files.push({ path: f[i + 1], s: letter(f[i][0]) });
        if (key() === context) this.commitFiles.set(hash, files);
      } catch (e) { if (key() === context) this.note = String(e); }
      cx.notify();
    });
    cx.notify();
  }

  // Runs git writes in order, then refreshes. A refresh already running reruns once it ends.
  act(argsList, cx, ok) {
    if (this.busy || !this.root || this.context !== key()) return;
    const context = this.context;
    this.busy = true; this.note = null; this.asking = null;
    cx.spawn(async (cx) => {
      try { for (const args of argsList) await this.git(args); if (key() === context) ok?.(); }
      catch (e) { if (key() === context) this.note = String(e); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  stage(path, cx) { this.act([["add", "--", path]], cx); }
  unstage(path, cx) { this.act([this.hasHead ? ["restore", "--staged", "--", path] : ["rm", "--cached", "-q", "--", path]], cx); }
  stageAll(cx) { this.act([["add", "-A"]], cx); }
  // Discard only touches the working tree; staged changes stay. It always asks first.
  discard(files, cx) {
    const tracked = files.filter((f) => !f.fresh && f.s !== "!").map((f) => f.path), fresh = files.filter((f) => f.fresh).map((f) => f.path);
    const list = [...(tracked.length ? [["restore", "--", ...tracked]] : []), ...(fresh.length ? [["clean", "-f", "--", ...fresh]] : [])];
    if (!list.length) return;
    const one = files.length === 1 ? files[0].path.split("/").pop() : null;
    const text = one ? (fresh.length ? `Delete untracked file ${one}?` : `Discard changes to ${one}?`)
      : `Discard ${tracked.length} changed and delete ${fresh.length} untracked files?`;
    this.asking = { text: `${text} This cannot be undone.`, list };
    cx.notify();
  }

  openBranches(cx) {
    if (this.branches) { this.branches = null; cx.notify(); return; }
    this.branches = []; this.branchesLoading = true; this.query = ""; this.filter.set_value("");
    const context = this.context, current = this.branch?.name;
    cx.spawn(async (cx) => {
      try {
        const r = await this.git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
        const refs = r.stdout.split("\n").filter(Boolean), local = new Set(refs.filter((x) => x.startsWith("refs/heads/")).map((x) => x.slice(11)));
        const list = refs.flatMap((x) => x.startsWith("refs/heads/") ? [{ name: x.slice(11), local: true }]
          : !x.endsWith("/HEAD") && !local.has(x.slice(13).replace(/^[^/]+\//, "")) ? [{ name: x.slice(13), local: false }] : []);
        if (key() === context && this.branches) this.branches = list.map((b) => ({ ...b, current: b.local && b.name === current }));
      } catch (e) { if (key() === context) { this.branches = null; this.note = String(e); } }
      this.branchesLoading = false;
      cx.notify();
    });
    this.filter.focus();
    cx.notify();
  }

  // A remote branch gets a local branch that tracks it.
  checkout(b, cx) {
    if (b.current) { this.branches = null; cx.notify(); return; }
    this.act([b.local ? ["switch", b.name] : ["switch", "--track", b.name]], cx, () => { this.branches = null; });
  }

  createBranch(name, cx) {
    // A leading "-" would be read as an option.
    if (!name || name.startsWith("-")) return;
    this.act([["switch", "-c", name]], cx, () => { this.branches = null; });
  }
  unstageAll(cx) { this.act([this.hasHead ? ["restore", "--staged", "--", "."] : ["rm", "-r", "--cached", "-q", "--", "."]], cx); }

  commit(cx) {
    const title = this.title.trim(), body = this.body.value().trim();
    if (!title || !this.root) return;
    const list = [["commit", "-m", title, ...(body ? ["-m", body] : [])]];
    if (!this.staged.length) list.unshift(["add", "-A"]);
    this.act(list, cx, () => this.clearMessage());
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    localStorage.setItem("caps", JSON.stringify(this.caps));
    cx.notify();
  }

  flip(id, cx) { this.collapsed.has(id) ? this.collapsed.delete(id) : this.collapsed.add(id); cx.notify(); }

  // Rows show their actions only while hovered; GPUI has no group hover, so the row id is kept here.
  // While the wheel moves, rows slide under the pointer: keep the state but skip the redraw.
  hover(id, on, cx) {
    const next = on ? id : this.hot === id ? null : this.hot;
    if (next === this.hot) return;
    this.hot = next;
    if (Date.now() - this.wheelAt > 250) cx.notify();
  }

  button(id, icon, tip, fn, t, spin) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(svg(icon).size(14).when(Boolean(spin), (e) => e.spin(900)));
  }

  notice(icon, title, hint, t, spin) {
    return v_flex().flex_1().py(32).px(16).gap(6).items_center().text_center()
      .child(svg(icon).size(20).text_color(t.dim).when(Boolean(spin), (e) => e.spin(900)))
      .child(div().text_size(13).text_color(t.muted).child(title))
      .when(Boolean(hint), (e) => e.child(div().text_size(12).text_color(t.dim).child(hint)));
  }

  // `cap` is the section's maximum list height in px; without it the section takes the space that is left
  // and `rows(height)` returns the whole body. Every list scrolls on its own.
  section(id, title, count, actions, rows, t, cap) {
    const open = !this.collapsed.has(id), fill = cap === undefined, list = open && !fill ? rows() : [];
    const head = h_flex().h(28).flex_none().px(6).gap(2).items_center().bg(t.raised).rounded(6)
      .child(h_flex().id(`sec-${id}`).flex_1().min_w(0).h_full().px(2).gap(6).items_center().cursor_pointer().on_click((_e, cx) => this.flip(id, cx))
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
        .child(div().font_semibold().text_size(12).truncate().child(title))
        .child(div().flex_none().px(6).rounded(8).bg(t.hover).text_size(10).text_color(t.muted).child(String(count))));
    for (const a of actions) head.child(a);
    // A scroll area needs an explicit height here: the Graph gets what the column has left.
    const height = fill ? Math.max(120, (this.listHeight ?? 0) - this.used - 2) : Math.min(cap, list.length * 28 + 2);
    this.used += 30 + (open ? height + 2 : 0);
    if (!open) return [head];
    if (fill) { this.graphH = height; return [head, rows(height)]; }
    // Dragging the grip sets the section's cap, up to its content and down to the Graph's 120px.
    this.used += 8;
    const grip = div().id(`grip-${id}`).h(6).flex_none().flex().items_center().justify_center().rounded(3).cursor_row_resize().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.drag = { id, y: e.position.y, start: height, max: Math.min(list.length * 28 + 2, height + Math.max(0, this.spare ?? 0)) };
        cx.notify();
      })
      .child(div().w(28).h(2).rounded(1).bg(this.drag?.id === id ? t.accent : t.border));
    return [head, v_flex().id(`scroll-${id}`).flex_none().h(height).overflow_y_scrollbar().gap(2).children(list), grip];
  }

  fileRow(f, kind, depth, flat, t) {
    const parts = f.path.split("/"), name = parts.pop(), id = `${kind}-${f.path}`;
    const picked = this.sel && this.sel.kind === kind && this.sel.path === f.path;
    const sel = { kind, path: f.path, fresh: f.fresh }, mark = f.fresh ? "U" : f.s;
    const shown = picked || this.hot === id;
    const row = h_flex().id(`row-${id}`).h(26).flex_none().pl(8 + depth * 14).pr(4).gap(4).items_center().rounded(6)
      .when(picked, (e) => e.bg(t.selected)).when(!picked, (e) => e.hover((s) => s.bg(t.hover)))
      .on_hover((on, cx) => this.hover(id, on, cx))
      .child(h_flex().id(`file-${id}`).flex_1().min_w(0).h_full().gap(6).items_center().cursor_pointer().on_click((_e, cx) => this.select(sel, cx))
        .child(div().min_w(0).truncate().text_color(markColor(t, f.s)).when(f.s === "D", (e) => e.line_through()).child(name))
        .when(flat && parts.length > 0, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))));
    // Invisible until hovered: the pointer is on the row before it can reach the button.
    const action = (icon, tip, fn) => this.button(`${icon}-${id}`, ICON(icon), tip, (cx) => { this.hot = null; fn(cx); }, t)
      .opacity(shown ? 1 : 0).transition("opacity", { duration: 120, easing: "ease-out" });
    if (kind === "staged") row.child(action("minus", "Unstage changes", (cx) => this.unstage(f.path, cx)));
    if (kind === "work" && f.s !== "!") row.child(action("undo", f.fresh ? "Delete file" : "Discard changes", (cx) => this.discard([f], cx)));
    if (kind === "work") row.child(action("plus", f.s === "!" ? "Stage (mark resolved)" : "Stage changes", (cx) => this.stage(f.path, cx)));
    return row.child(div().id(`mark-${id}`).w(16).flex_none().text_center().text_size(11).font_semibold().text_color(markColor(t, f.s)).tooltip(MARK_NAME[mark]).child(mark));
  }

  // A conventional-commit prefix ("feat(zsh): ") is dimmed so the message itself stands out.
  subject(c, t) {
    const [, prefix, message] = /^(\w+(?:\([^)]*\))?!?:\s+)(.*)$/.exec(c.subject) ?? [, "", c.subject];
    return h_flex().flex_1().min_w(64).gap(4).items_center().when(c.head, (e) => e.font_medium())
      .when(Boolean(prefix), (e) => e.child(div().flex_none().text_color(t.dim).child(prefix.trim())))
      .child(div().min_w(0).truncate().child(message));
  }

  fileRows(files, kind, t, empty = "No changes") {
    if (!files.length) return [h_flex().h(26).flex_none().px(10).items_center().text_size(12).text_color(t.dim).child(empty)];
    if (!this.tree) return files.map((f) => this.fileRow(f, kind, 0, true, t));
    const out = [], seen = new Set(), scope = `${kind}:`;
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = f.path.split("/");
      let hidden = false;
      for (let i = 0; i < parts.length - 1 && !hidden; i++) {
        const dir = scope + parts.slice(0, i + 1).join("/");
        if (!seen.has(dir)) {
          seen.add(dir);
          out.push(h_flex().id(`dir-${dir}`).h(26).flex_none().pl(6 + i * 14).pr(6).gap(4).items_center().rounded(6).cursor_pointer()
            .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click((_e, cx) => this.flip(dir, cx))
            .child(svg(ICON(this.collapsed.has(dir) ? "chevron-right" : "chevron-down")).size(12).flex_none().text_color(t.dim))
            .child(div().min_w(0).truncate().text_color(t.muted).child(parts[i])));
        }
        hidden = this.collapsed.has(dir);
      }
      if (!hidden) out.push(this.fileRow(f, kind, parts.length - 1, false, t));
    }
    return out;
  }

  badge(r, t) {
    const local = r.kind === "local";
    return div().min_w(0).max_w(96).truncate().px(5).rounded(4).text_size(10)
      .when(local, (e) => e.bg(t.accent + "22").text_color(t.accent))
      .when(!local, (e) => e.border_1().border_color(t.border).text_color(r.kind === "tag" ? t.ansi3 : t.muted)).child(r.name);
  }

  // Only the visible rows are built, so a long history scrolls without rebuilding the panel. Rows in a
  // virtual list take no handlers: one click handler reads the item from its key.
  graph(t, height) {
    if (!this.commits.length) return h_flex().h(26).px(10).items_center().text_size(12).text_color(t.dim).child(this.hasHead ? "No commits" : "No commits yet");
    const items = [];
    for (const c of this.commits) {
      items.push({ key: `c:${c.hash}`, size: ROW, c });
      if (this.openCommit !== c.hash) continue;
      const files = this.commitFiles.get(c.hash);
      items.push({ key: `m:${c.hash}`, size: 24, c, text: `${c.short} · ${c.author} · ${c.when}` });
      if (!files?.length) items.push({ key: `l:${c.hash}`, size: 26, c, text: files ? "No file changes" : "Loading files…" });
      else for (const f of files) items.push({ key: `f:${c.hash}:${f.path}`, size: 26, c, f });
    }
    const byKey = new Map(items.map((i) => [i.key, i])), n = this.lanes, L = laneWidth(n), graphW = Math.min(n * L, GRAPH_MAX);
    return div().relative().flex_none().h(height)
      .child(v_virtual_list("scroll-log", items.length, items.map((i) => i.size), (i) => items[i].key,
        (range) => items.slice(range.start, range.end).map((it) => this.graphRow(it, n, L, graphW, t))).size_full()
        .on_item_click((key, cx) => {
          const it = byKey.get(key);
          if (it?.f) this.select({ kind: "commit", path: it.f.path, hash: it.c.hash }, cx);
          else if (key.startsWith("c:")) this.toggleCommit(it.c.hash, cx);
        }))
      .child(Scrollbar.vertical("scroll-log").viewport_from_layout().absolute().inset_0());
  }

  graphRow(it, n, L, graphW, t) {
    const c = it.c;
    if (it.key.startsWith("c:")) {
      const open = this.openCommit === c.hash, more = c.refs.length - 2;
      return h_flex().id(it.key).h(ROW).w_full().pl(4).pr(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(open, (e) => e.bg(t.selected)).when(!open, (e) => e.hover((s) => s.bg(t.hover)))
        .child(graphCell(c, n, L, t, t.background))
        .child(this.subject(c, t))
        .when(c.refs.length > 0, (e) => e.child(h_flex().min_w(0).gap(4).items_center().overflow_hidden()
          .children(c.refs.slice(0, 2).map((r) => this.badge(r, t)))
          .when(more > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${more}`)))))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(age(c.when)));
    }
    // Rows under an open commit: the lanes alive below it run beside them.
    const f = it.f, picked = f && this.sel?.kind === "commit" && this.sel.hash === c.hash && this.sel.path === f.path;
    const parts = f ? f.path.split("/") : [], name = parts.pop();
    return div().id(it.key).relative().w_full().h(it.size)
      .children(c.below.filter((i) => i * L < graphW).map((i) => div().absolute().left(4 + i * L + L / 2 - 1).top(0).bottom(0).w(2).bg(laneColor(t, i))))
      .child(h_flex().h_full().ml(4 + graphW + 4).pl(4).pr(8).gap(6).items_center().rounded(6).text_size(f ? 13 : 11)
        .when(!f, (e) => e.text_color(t.dim).child(div().min_w(0).truncate().child(it.text)))
        .when(Boolean(f), (e) => e.cursor_pointer().when(picked, (e) => e.bg(t.selected)).when(!picked, (e) => e.hover((s) => s.bg(t.hover)))
          .child(div().min_w(0).truncate().text_color(markColor(t, f.s)).when(f.s === "D", (e) => e.line_through()).child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
          .child(div().w(16).flex_none().text_center().text_size(11).font_semibold().text_color(markColor(t, f.s)).child(f.s))));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  header(t) {
    const b = this.branch, detached = b?.name.startsWith("HEAD (");
    const count = (icon, value, tip) => h_flex().id(`count-${icon}`).flex_none().gap(1).items_center().text_size(11).text_color(t.muted).tooltip(tip)
      .child(svg(OWN(icon)).size(11)).child(String(value));
    return h_flex().h(42).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().font_semibold().child("Source Control"))
      .child(h_flex().id("branch").flex_1().min_w(0).gap(4).items_center().text_size(12).when(Boolean(b), (e) => e
        .cursor_pointer().rounded(5).px(4).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openBranches(cx))
        .tooltip(detached ? "Detached HEAD: click to switch branch" : "Switch or create a branch")
        .child(svg(ICON("git-branch")).size(13).flex_none().text_color(detached ? t.blocked : t.accent))
        .child(div().min_w(0).truncate().text_color(detached ? t.blocked : t.accent).child(detached ? "Detached HEAD" : b.name))
        .when(b.ahead > 0, (e) => e.child(count("arrow-up", b.ahead, `${b.ahead} to push`)))
        .when(b.behind > 0, (e) => e.child(count("arrow-down", b.behind, `${b.behind} to pull`)))))
      .child(this.button("view", OWN(this.tree ? "list" : "list-tree"), this.tree ? "View as list" : "View as tree", (cx) => { this.tree = !this.tree; cx.notify(); }, t))
      .child(this.button("reload", OWN("refresh"), "Reload", (cx) => { this.spinning = true; this.refresh(cx); cx.notify(); }, t, this.spinning));
  }

  branchPicker(t) {
    const q = this.query.trim(), low = q.toLowerCase();
    const rows = this.branches.filter((b) => b.name.toLowerCase().includes(low)).slice(0, 200).map((b) =>
      h_flex().id(`br-${b.local ? "l" : "r"}-${b.name}`).h(26).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click((_e, cx) => this.checkout(b, cx))
        .child(svg(ICON("git-branch")).size(12).flex_none().text_color(b.current ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(b.current ? t.accent : b.local ? t.foreground : t.muted).child(b.name))
        .when(b.current, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("current"))));
    if (q && !q.startsWith("-") && !this.branches.some((b) => b.local && b.name === q))
      rows.unshift(h_flex().id("br-create").h(26).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click((_e, cx) => this.createBranch(q, cx))
        .child(svg(ICON("plus")).size(12).flex_none().text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().child(`Create branch ${q}`)));
    return v_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border).bg(t.raised + "66")
      .child(div().id("branch-filter").w_full().h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.filter).h_full().text_size(12).text_color(t.foreground)))
      .child(v_flex().id("branch-list").flex_none().h(Math.min(208, Math.max(1, rows.length) * 28)).overflow_y_scrollbar().gap(2)
        .children(rows.length ? rows : [h_flex().h(26).px(8).items_center().text_size(12).text_color(t.dim).child(this.branchesLoading ? "Loading branches…" : "No matching branch")]));
  }

  composer(t) {
    const changes = this.staged.length + this.work.length;
    const enabled = Boolean(this.title.trim() && this.root && !this.busy && changes);
    const field = (id, focused) => div().id(id).w_full().px(10).rounded(8).border_1().border_color(focused ? t.accent : t.border)
      .when(!focused, (e) => e.hover((s) => s.border_color(t.input))).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const label = this.busy ? "Working…" : !this.root || changes ? (this.staged.length ? "Commit" : "Commit all") : "Nothing to commit";
    return v_flex().flex_none().p(10).gap(8).border_b(1).border_color(t.border)
      .child(field("commit-title", this.typingTitle).h(32).flex().items_center().child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
      .child(field("commit-body", this.typingBody).py(6).child(Textarea.new(this.body).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().id("commit").w_full().h(32).gap(6).items_center().justify_center().rounded(8).text_size(12).font_medium()
        .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim)
        .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).active((s) => s.opacity(0.8)))
        .when(!enabled && !this.busy && changes > 0 && !this.title.trim(), (e) => e.tooltip("Write a commit title first"))
        .on_click((_e, cx) => { if (enabled) this.commit(cx); })
        .when(this.busy, (e) => e.child(svg(ICON("spinner")).size(12).spin(900)))
        .child(label));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), clean = !this.staged.length && !this.work.length;
    this.used = 12;
    const items = this.error === "Not a git repository" ? [this.notice(ICON("git-branch"), "No repository here", "Focus a folder inside a git repository.", t)]
      : this.error ? [this.notice(ICON("x"), "Cannot read this repository", this.error, t)]
      : !this.root ? [this.loading ? this.notice(ICON("spinner"), "Loading…", "", t, true) : this.notice(ICON("folder"), "No folder", "Focus a terminal or a pane that has a folder.", t)] : [
        ...(this.staged.length ? this.section("staged", "Staged Changes", this.staged.length, [this.button("unstage-all", ICON("minus"), "Unstage all", (cx) => this.unstageAll(cx), t)], () => this.fileRows(this.staged, "staged", t), t, this.caps.staged) : []),
        ...this.section("work", "Changes", this.work.length, this.work.length ? [this.button("discard-all", ICON("undo"), "Discard all", (cx) => this.discard(this.work, cx), t), this.button("stage-all", ICON("plus"), "Stage all", (cx) => this.stageAll(cx), t)] : [],
          () => this.fileRows(this.work, "work", t, clean ? "Working tree clean" : "No unstaged changes"), t, this.caps.work),
        ...this.section("log", "Graph", this.commits.length >= MAX_COMMITS ? `${MAX_COMMITS}+` : this.commits.length, [], (height) => this.graph(t, height), t),
      ];
    // Room a grip may take: what the Graph has above its 120px, or the free space when it is collapsed.
    this.spare = this.collapsed.has("log") ? (this.listHeight ?? 0) - this.used : (this.graphH ?? 120) - 120;
    const sel = this.sel, parts = sel ? sel.path.split("/") : [];
    return v_flex().id("git-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.branches || this.asking) { this.branches = null; this.asking = null; }
        else if (this.typingTitle || this.typingBody) this.handle.focus();
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(this.header(t))
      .when(Boolean(this.branches), (e) => e.child(this.branchPicker(t)))
      .child(this.composer(t))
      .child(v_flex().id("git-list").flex_1().min_h(0).p(6).gap(2).on_scroll_wheel(() => { this.wheelAt = Date.now(); })
        .on_mouse_move((e, cx) => {
          const d = this.drag;
          if (!d) return;
          const v = Math.round(Math.min(d.max, Math.max(30, d.start + e.position.y - d.y)));
          if (v !== this.caps[d.id]) { this.caps[d.id] = v; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => this.endDrag(cx)).on_hover((on, cx) => { if (!on) this.endDrag(cx); })
        .on_size_change((size, cx) => { if (size.height !== this.listHeight) { this.listHeight = size.height; cx.notify(); } }).children(items)
        .when(this.limited, (e) => e.child(div().px(8).py(4).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_FILES} changed files`))))
      .when(Boolean(this.asking), (e) => e.child(h_flex().flex_none().pl(10).pr(6).py(6).gap(6).items_center().bg(t.ansi1 + "14").border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(this.asking?.text ?? ""))
        .child(div().id("ask-no").h(26).px(10).flex().items_center().rounded(6).cursor_pointer().text_size(12).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.asking = null; cx.notify(); }).child("Cancel"))
        .child(div().id("ask-yes").h(26).px(10).flex().items_center().rounded(6).cursor_pointer().text_size(12).bg(t.ansi1).text_color(t.background)
          .hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.act(this.asking.list, cx)).child("Discard"))))
      .when(Boolean(this.note), (e) => e.child(h_flex().flex_none().pl(10).pr(6).py(4).gap(6).items_start().bg(t.ansi1 + "14").border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).py(3).text_size(11).text_color(t.ansi1).child(this.note ?? ""))
        .child(this.button("close-note", ICON("x"), "Dismiss", (cx) => { this.note = null; cx.notify(); }, t))))
      .when(Boolean(sel), (e) => e
        .child(h_flex().h(28).flex_none().pl(10).pr(4).gap(6).items_center().border_t(1).border_color(t.border).bg(t.raised)
          .child(div().flex_none().max_w(200).truncate().text_size(11).font_medium().child(parts.at(-1) ?? ""))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.slice(0, -1).join("/")))
          .child(this.button("close-diff", ICON("x"), "Close diff", (cx) => { this.clearSel(); cx.notify(); }, t)))
        .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
          .child(div().id("git-diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("git-diff", this.rows.length, 20, (i) => String(i),
              (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
          .child(Scrollbar.vertical("git-diff").viewport_from_layout().absolute().inset_0())
          .when(!this.rows.length, (e) => e.child(div().absolute().inset_0().flex().items_center().justify_center().text_color(t.dim).child("Loading diff…")))));
  }
}
