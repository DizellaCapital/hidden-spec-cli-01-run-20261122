// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// the V4A patch format, text-editor tool calls as JSON), finds the lines each
// edit names at the first of three matching tiers, and writes every change or
// none. The whole contract is SPEC.md. Node 22, the standard library alone;
// run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Exit 2 with exactly one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed; the run reports it and keeps going with the next edit. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

interface Move {
  old: string;
  neo: string;
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed each, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file's text as lines, its line break, and whether it ends with one. */
interface FileText {
  br: string;
  lines: string[];
  eol: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let eol = false;
  if (text.endsWith(br)) {
    eol = true;
    lines.pop();
  }
  return { br, lines, eol };
}

function serializeFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

/** One line compared at a matching tier. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  if (tier === 1) return t;
  return t.replace(/^[ \t]+/, '');
}

/** Every 0-based position where `pat` occurs in `lines` at `tier` (occurrences may overlap). */
function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  const np = pat.map((l) => normLine(l, tier));
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j]!, tier) !== np[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `pat` occurs at least once, with its positions; null when it never occurs. */
function findTier(lines: string[], pat: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, pat, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewLine {
  text: string;
  /** Index into O when this is a context line, -1 when it is an added line. */
  ctx: number;
}

/**
 * The replacement lines for a match at `pos`: a context line is written as the
 * file's own matched line, never the patch's; at tier 2 every other line is
 * re-indented from the patch's first-line indent to the file's.
 */
function buildNew(nLines: NewLine[], oLines: string[], fileLines: string[], pos: number, tier: number): string[] {
  const fLead = leadingWs(fileLines[pos] ?? '');
  const pLead = oLines.length > 0 ? leadingWs(oLines[0]!) : '';
  return nLines.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    let s = n.text;
    if (tier === 2 && s !== '' && !/^[ \t]+$/.test(s) && s.startsWith(pLead)) {
      s = fLead + s.slice(pLead.length);
    }
    return s;
  });
}

/** Split hunk/chunk body lines into old lines O and new lines N. */
function splitBody(body: string[]): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const bl of body) {
    if (bl.startsWith(' ')) {
      O.push(bl.slice(1));
      N.push({ text: bl.slice(1), ctx: O.length - 1 });
    } else if (bl.startsWith('-')) {
      O.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      N.push({ text: bl.slice(1), ctx: -1 });
    } else if (bl === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
    }
    // A `\` line is a marker for the line before it, never content.
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line: the result then ends without a line break. */
function hunkNoEol(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!;
    if (b.startsWith(' ') || b.startsWith('+') || b === '') last = i;
  }
  if (last < 0) return false;
  return last + 1 < body.length && body[last + 1]!.startsWith('\\');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Detect the patch format (SPEC.md section 4), or null when none holds. */
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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
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
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** Old start line A from `@@ -A[,B] +C[,D] @@` (1-based; B and D are not used). */
  a: number;
  body: string[];
}

interface Section {
  /** `---` path, or undefined when no pair names one; null means `/dev/null`. */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | null | undefined;
  renameTo: string | null | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, leading `a/`/`b/` removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  const p = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
  return p === '/dev/null' ? null : p;
}

function parseDiffGit(line: string): { old: string; neo: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) return null;
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') return null;
  return { old: x, neo: y };
}

/** Apply a section's hunks in order to a file's text; throws Fail on the first hunk that fails. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitBody(h.body);
    if (O.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > f.lines.length) at = f.lines.length;
      const atEnd = at === f.lines.length;
      const ins = N.map((n) => n.text);
      f.lines.splice(at, 0, ...ins);
      if (atEnd) f.eol = !hunkNoEol(h.body);
      d += N.length;
      continue;
    }
    const found = findTier(f.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + O.length === f.lines.length;
    const rep = buildNew(N, O, f.lines, best, found.tier);
    f.lines.splice(best, O.length, ...rep);
    if (atEnd) f.eol = !hunkNoEol(h.body);
    d += N.length - O.length;
  }
  return serializeFile(f);
}

function unifiedSectionEdit(sec: Section, strict: boolean, moves: Move[]): Edit {
  return (tree: Tree): void => {
    const oldPath: string | null =
      sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : (sec.diffOld ?? null);
    const newPath: string | null =
      sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : (sec.diffNew ?? null);
    if (oldPath === null && newPath === null) return;
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    const isCreate = (oldPath === null || sec.newFile) && newPath !== null;
    const isDelete = !isCreate && (newPath === null || sec.deletedFile) && oldPath !== null;
    const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
    if (isCreate) {
      const p = newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      for (const h of sec.hunks) for (const bl of h.body) if (bl.startsWith('+')) plusLines.push(bl.slice(1));
      let noEol = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let j = body.length - 1; j >= 0; j--) {
          if (body[j]!.startsWith('+')) {
            noEol = j + 1 < body.length && body[j + 1]!.startsWith('\\');
            break outer;
          }
        }
      }
      tree.now.set(p, plusLines.length === 0 ? '' : plusLines.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const from = oldPath!;
      const to = newPath!;
      if (tree.get(from) === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const result = applyHunks(tree.get(from)!, sec.hunks, strict, from);
      tree.now.set(from, null);
      tree.now.set(to, result);
      moves.push({ old: from, neo: to });
      return;
    }
    const p = oldPath!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

function unifiedParse(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let curHunk: Hunk | null = null;
  const blankSection = (): Section => ({
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const startSection = (s: Section): void => {
    sections.push(s);
    cur = s;
    inHeader = true;
    curHunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = dg.old;
      s.diffNew = dg.neo;
      startSection(s);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      const s = blankSection();
      s.pairOld = headerPath(line);
      s.pairNew = headerPath(lines[i + 1]!);
      startSection(s);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      curHunk = hunk;
      inHeader = false;
      i++;
      continue;
    }
    if (curHunk !== null) {
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        curHunk.body.push(line);
        i++;
        continue;
      }
      curHunk = null;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  for (const s of sections) {
    for (const h of s.hunks) {
      while (h.body.length > 0 && h.body[h.body.length - 1] === '') h.body.pop();
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = buildNew(
      newLines.map((t) => ({ text: t, ctx: -1 })),
      oldLines,
      f.lines,
      pos,
      found.tier,
    );
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, serializeFile(f));
  };
}

function srParse(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
      let end = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
      if (end === -1) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, end), strict));
      prevPath = path;
      prevEnd = end;
      i = end + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  /** Anchor text after `@@`, or null when there is none. */
  anchor: string | null;
  /** `*** End of File` ended this chunk: it must match at the file's end. */
  eof: boolean;
  /** The chunk's body lines, as written; split into O and N once the chunk is whole. */
  body: string[];
  O: string[];
  N: NewLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Add File: the file's lines. */
  fileLines: string[];
  /** Update File: the new path, or null. */
  moveTo: string | null;
  chunks: VChunk[];
}

const V4A_STARTS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

function isV4aStart(line: string): boolean {
  return V4A_STARTS.some((p) => line.startsWith(p));
}

function v4aSectionEdit(sec: VSection, strict: boolean, moves: Move[]): Edit {
  return (tree: Tree): void => {
    const path = sec.path;
    if (!safe(path)) throw new Fail('unsafe', path);
    if (sec.kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    const moveTo = sec.moveTo;
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let foundIdx = -1;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && foundIdx < 0; t++) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (normLine(f.lines[k]!, t) === normLine(chunk.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (chunk.O.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        const ins = chunk.N.map((n) => n.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top; t++) {
        const occ = occurrences(f.lines, chunk.O, t).filter(
          (p) => p >= cursor && (!chunk.eof || p + chunk.O.length === f.lines.length),
        );
        if (occ.length > 0) {
          found = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const rep = buildNew(chunk.N, chunk.O, f.lines, found.pos, found.tier);
      f.lines.splice(found.pos, chunk.O.length, ...rep);
      cursor = found.pos + rep.length;
    }
    const result = serializeFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      moves.push({ old: path, neo: moveTo });
    } else {
      tree.now.set(path, result);
    }
  };
}

function v4aParse(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    const secLines: Array<{ no: number; text: string }> = [];
    let j = i + 1;
    while (j < last) {
      const lj = lines[j]!;
      if (isV4aStart(lj)) break;
      secLines.push({ no: j + 1, text: lj });
      j++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const sl of secLines) {
        if (sl.text.startsWith('+')) fileLines.push(sl.text.slice(1));
        else if (sl.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${sl.no}`);
      }
      edits.push(v4aSectionEdit({ kind, path, fileLines, moveTo: null, chunks: [] }, strict, moves));
    } else if (kind === 'delete') {
      for (const sl of secLines) throw new Exit2(`error: parse ${sl.no}`);
      edits.push(v4aSectionEdit({ kind, path, fileLines: [], moveTo: null, chunks: [] }, strict, moves));
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.text.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (eof: boolean): void => {
        if (cur !== null) {
          cur.eof = eof;
          cur = null;
        }
      };
      for (; k < secLines.length; k++) {
        const sl = secLines[k]!;
        const t = sl.text;
        if (t.startsWith('@@')) {
          closeChunk(false);
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [], O: [], N: [] };
          chunks.push(cur);
        } else if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${sl.no}`);
          closeChunk(true);
        } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${sl.no}`);
            cur = { anchor: null, eof: false, body: [], O: [], N: [] };
            chunks.push(cur);
          }
          cur.body.push(t);
        } else {
          throw new Exit2(`error: parse ${sl.no}`);
        }
      }
      for (const c of chunks) {
        const split = splitBody(c.body);
        c.O = split.O;
        c.N = split.N;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push(v4aSectionEdit({ kind, path, fileLines: [], moveTo, chunks }, strict, moves));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2, 10)                        */
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
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedParse(lines, strict, moves);
    else if (kind === 'search-replace') edits = srParse(lines, strict);
    else edits = v4aParse(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  interface OutLine {
    key: string;
    text: string;
  }
  const outLines: OutLine[] = [];
  const covered = new Set<string>();
  for (const m of moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.get(m.old);
    const newWas = tree.original(m.neo);
    const newNow = tree.get(m.neo);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      outLines.push({ key: m.neo, text: `R ${m.old} -> ${m.neo}` });
      covered.add(m.old);
      covered.add(m.neo);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    outLines.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  outLines.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const rows = outLines.map((l) => l.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
