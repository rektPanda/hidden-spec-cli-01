// mend: apply an AI-written edit to a tree of text files.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool calls), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. Node 22, standard
// library alone; run as `node main.ts [options] [PATCH]`.
//
// The hot path (line matching) is single-pass with no regex and no
// per-line allocation: each tier's line keys are computed once per scan.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own break, its lines, whether it ends with a break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Matching (SPEC.md section 5). Single pass, no regex.               */
/* ------------------------------------------------------------------ */

function isSpaceTab(c: number): boolean {
  return c === 32 || c === 9;
}

/** A line's key at a tier: 0 exact, 1 trailing space/tab off, 2 both off. */
function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  let e = s.length;
  while (e > 0 && isSpaceTab(s.charCodeAt(e - 1))) e -= 1;
  if (tier === 1) return e === s.length ? s : s.slice(0, e);
  let b = 0;
  while (b < e && isSpaceTab(s.charCodeAt(b))) b += 1;
  return s.slice(b, e);
}

function leadingWs(s: string): string {
  let i = 0;
  while (i < s.length && isSpaceTab(s.charCodeAt(i))) i += 1;
  return s.slice(0, i);
}

function isOnlyWs(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (!isSpaceTab(s.charCodeAt(i))) return false;
  }
  return true;
}

/** Positions at or after `from` where O occurs at one tier (may overlap). */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const n = o.length;
  const pos: number[] = [];
  if (n === 0 || lines.length - from < n) return pos;
  const ok: string[] = new Array<string>(n);
  for (let j = 0; j < n; j += 1) ok[j] = tierKey(o[j]!, tier);
  const fk: string[] = new Array<string>(lines.length);
  for (let i = from; i < lines.length; i += 1) fk[i] = tierKey(lines[i]!, tier);
  outer: for (let i = from; i + n <= lines.length; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (fk[i + j] !== ok[j]) continue outer;
    }
    pos.push(i);
  }
  return pos;
}

/** First tier (0, then 1, then 2; only 0 when strict) where O occurs. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(lines, o, t, from);
    if (eof) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** First line at or after `from` equal to a one-line anchor, first tier. */
function anchorAt(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = tierKey(anchor, t);
    for (let i = from; i < lines.length; i += 1) {
      if (tierKey(lines[i]!, t) === a) return i;
    }
  }
  return -1;
}

/** One line of O or N; ctx lines are written as the file's own line. */
interface OLine {
  text: string;
  ctx: boolean;
}

/** Build N's replacement lines for a match at `at` (section 5). */
function buildReplacement(n: OLine[], o: OLine[], fileLines: string[], at: number, tier: number): string[] {
  const ctxO: number[] = [];
  for (let j = 0; j < o.length; j += 1) {
    if (o[j]!.ctx) ctxO.push(j);
  }
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(fileLines[at]!);
    p = leadingWs(o[0]!.text);
  }
  const out: string[] = [];
  let k = 0;
  for (const nl of n) {
    if (nl.ctx) {
      out.push(fileLines[at + ctxO[k]!]!);
      k += 1;
    } else if (tier === 2) {
      const t = nl.text;
      if (!isOnlyWs(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** Split a hunk/chunk body into old lines O and new lines N. */
function bodyLines(body: string[]): { o: OLine[]; n: OLine[]; noEolNew: boolean } {
  const o: OLine[] = [];
  const n: OLine[] = [];
  for (const bl of body) {
    if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      o.push({ text: t, ctx: true });
      n.push({ text: t, ctx: true });
    } else if (bl.startsWith('-')) {
      o.push({ text: bl.slice(1), ctx: false });
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1), ctx: false });
    } else if (bl === '') {
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: true });
    }
    // a `\` line refers to the body line before it; handled in noEolNew.
  }
  let noEolNew = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const bl = body[k]!;
    if (bl.startsWith(' ') || bl.startsWith('+') || bl === '') {
      noEolNew = body[k + 1] !== undefined && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  return { o, n, noEolNew };
}

/* ------------------------------------------------------------------ */
/* Format detection (section 4).                                      */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6).                                         */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], i: number, sec: Section): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  i += 1;
  const body: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      i += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  sec.hunks.push({ a, body });
  return i;
}

/** Apply one hunk to a file state; returns N length minus O length. */
function applyHunk(state: FileState, h: Hunk, d: number, strict: boolean, path: string): number {
  const { o, n, noEolNew } = bodyLines(h.body);
  const oTexts = o.map((x) => x.text);
  if (o.length === 0) {
    const ins = Math.max(0, h.a + d);
    const at = Math.min(ins, state.lines.length);
    const atEnd = ins >= state.lines.length;
    state.lines.splice(at, 0, ...n.map((x) => x.text));
    if (atEnd) state.final = !noEolNew;
    return n.length;
  }
  const found = findTier(state.lines, oTexts, strict, 0, false);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const at = best;
  const endsAtEof = at + o.length === state.lines.length;
  const rep = buildReplacement(n, o, state.lines, at, found.tier);
  state.lines.splice(at, o.length, ...rep);
  if (endsAtEof) state.final = !noEolNew;
  return n.length - o.length;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.create || oldP === null;
    const isDel = sec.del || newP === null;
    if (isCreate) {
      const np = newP;
      if (np === null) throw new Fail('unsafe', '');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          if (h.body[k]!.startsWith('+')) {
            plus.push(h.body[k]!.slice(1));
            lastPlus = { hunk: h, idx: k };
          }
        }
      }
      let finalBreak = false;
      if (plus.length > 0) {
        const lp = lastPlus!;
        const next = lp.hunk.body[lp.idx + 1];
        finalBreak = !(next !== undefined && next.startsWith('\\'));
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDel) {
      const op = oldP;
      if (op === null) throw new Fail('unsafe', '');
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const state = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) d += applyHunk(state, h, d, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, renderFile(state));
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = (oldP ?? newP)!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const state = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(state, h, d, strict, p);
    tree.now.set(p, renderFile(state));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  const newSection = (oldP: string | null, newP: string | null): Section => {
    const s: Section = { oldPath: oldP, newPath: newP, create: false, del: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      inHeader = true;
      hasPair = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader || hasPair) {
        cur = newSection(null, null);
        inHeader = true;
        hasPair = false;
      }
      const op = headerPath(line);
      const np = headerPath(lines[i + 1]!);
      cur.oldPath = op === '/dev/null' ? null : op;
      cur.newPath = np === '/dev/null' ? null : np;
      hasPair = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) {
        i = parseHunk(lines, i, cur);
        inHeader = false;
        continue;
      }
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.del = true;
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!hasPair) cur.oldPath = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!hasPair) cur.newPath = line.slice(10).trim();
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      i = parseHunk(lines, i, cur);
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7).                                 */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const state = parseFile(before);
    const found = findTier(state.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const rep = buildReplacement(
      newLines.map((t) => ({ text: t, ctx: false })),
      oldLines.map((t) => ({ text: t, ctx: false })),
      state.lines,
      at,
      found.tier,
    );
    state.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, renderFile(state));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0;
  for (;;) {
    let searchIdx = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        searchIdx = j;
        break;
      }
    }
    if (searchIdx < 0) break;
    let path: string | null = null;
    for (let k = searchIdx - 1; k >= prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8).                                           */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const state = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = anchorAt(state.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = bodyLines(ch.body);
      const oTexts = o.map((x) => x.text);
      if (o.length === 0) {
        const at = ch.eof ? state.lines.length : cursor;
        const rep = n.map((x) => x.text);
        state.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
        continue;
      }
      const found = findTier(state.lines, oTexts, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const at = found.pos[0]!;
      const rep = buildReplacement(n, o, state.lines, at, found.tier);
      state.lines.splice(at, o.length, ...rep);
      cursor = at + rep.length;
    }
    const out = renderFile(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const p = line.slice('*** Add File:'.length).trim();
      i += 1;
      const collected: { text: string; fromEmpty: boolean }[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:') || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          collected.push({ text: l.slice(1), fromEmpty: false });
          i += 1;
          continue;
        }
        if (blank(l)) {
          collected.push({ text: '', fromEmpty: true });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (collected.length > 0 && collected[collected.length - 1]!.fromEmpty) collected.pop();
      edits.push(v4aAddEdit(p, collected.map((c) => c.text)));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const p = line.slice('*** Delete File:'.length).trim();
      i += 1;
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const p = line.slice('*** Update File:'.length).trim();
      const updateLine = i;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:') || l.trim() === '*** End Patch') break;
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          i += 1;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || blank(l)) {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push(l);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        // Blank lines (empty or only whitespace) at the end of a section
        // are not part of it (section 8); only the section's end is stripped.
        while (cur.body.length > 0 && blank(cur.body[cur.body.length - 1]!)) cur.body.pop();
        chunks.push(cur);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9).                                            */
/* ------------------------------------------------------------------ */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const state = parseFile(before);
      if (lineNo < 0 || lineNo > state.lines.length) throw new Fail('no-match', p);
      state.lines.splice(lineNo, 0, ...add);
      tree.now.set(p, renderFile(state));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM (JSON.parse rejects it)
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (sections 1, 2 and 10).          */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const n = outLines.length;
  return { code: 0, out: [...outLines, `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
