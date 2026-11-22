// mend: one patch tool for every AI edit format.
//
// Implements SPEC.md version 1: reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines
// each edit names at the first of three matching tiers, and writes every
// change or none, printing what it changed or why it failed.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`
// with the working directory as the root of a tree of text files. When
// MAKEFUN_ENV_URL is set, the program hands the trial over to runner.ts.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

/** A parse failure: the patch cannot be read in its format. */
class ParseFailure extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** One edit that failed: its code and the path it concerns. */
class EditFailure extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

/** A file's lines, its line break, and whether it ends with one. */
interface FileModel {
  lines: string[];
  brk: '\r\n' | '\n';
  eol: boolean;
}

function parseFile(text: string): FileModel {
  let brk: '\r\n' | '\n' = '\n';
  const firstLf = text.indexOf('\n');
  if (firstLf > 0 && text[firstLf - 1] === '\r') brk = '\r\n';
  if (text === '') return { lines: [], brk, eol: false };
  const lines = text.split(brk);
  let eol = false;
  if (text.endsWith(brk)) {
    lines.pop();
    eol = true;
  }
  return { lines, brk, eol };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.brk) + (m.eol ? m.brk : '');
}

/** A patch's lines: split at `\n`, one trailing `\r` removed from each,
 *  without the empty piece after a final `\n`. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Trailing spaces and tabs removed. */
function rtrimWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/* ------------------------------------------------------------------ */
/* Matching (SPEC section 5)                                           */
/* ------------------------------------------------------------------ */

/** A line as a tier reads it: 0 exact, 1 trailing ws removed,
 *  2 leading and trailing ws removed. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O's lines match the file's lines at a tier. */
function occurrencesAt(O: string[], lines: string[], tier: number): number[] {
  const no = O.map((l) => normLine(l, tier));
  const nf = lines.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (nf[i + j] !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(O: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(O, lines, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function isBlankish(s: string): boolean {
  return s === '' || /^[ \t]+$/.test(s);
}

/** One line of N: `text`, and the index into O when it is a context line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Build the lines that replace a match: context lines are written as the
 *  file's own matched lines; at tier 2 every other line is re-indented
 *  from O's first line's leading whitespace to the file's. */
function buildNewLines(O: string[], N: NewLine[], fileLines: string[], at: number, tier: number): string[] {
  const f = at < fileLines.length ? leadingWs(fileLines[at]) : '';
  const p = O.length > 0 ? leadingWs(O[0]) : '';
  const out: string[] = [];
  for (const nl of N) {
    if (nl.ctx !== null) {
      out.push(fileLines[at + nl.ctx]);
    } else if (tier === 2) {
      const t = nl.text;
      if (!isBlankish(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** A path exists in the tree as a file, or as a directory holding files. */
function pathExists(tree: Map<string, string>, p: string): boolean {
  if (tree.has(p)) return true;
  const prefix = p + '/';
  for (const k of tree.keys()) {
    if (k.startsWith(prefix)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bslash';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  plusNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

type UnifiedKind = 'create' | 'delete' | 'move' | 'change' | 'noop';

interface UnifiedEdit {
  format: 'unified';
  kind: UnifiedKind;
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
}

/** A path after `--- `/`+++ `: up to the first tab, surrounding spaces
 *  removed, a leading `a/` or `b/` removed; `/dev/null` means no file. */
function stripUnifiedPath(raw: string): string | null {
  let p = raw.split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:$|[ \t])/;

function parseUnified(lines: string[]): UnifiedEdit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;

  const freshSection = (): Section => ({
    pairOld: null,
    pairNew: null,
    plusNew: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    isNew: false,
    isDel: false,
    hunks: [],
  });
  const endHunk = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1];
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      if (cur !== null) cur.hunks.push(hunk);
      hunk = null;
    }
  };
  const endSection = (): void => {
    endHunk();
    if (cur !== null) {
      sections.push(cur);
      cur = null;
    }
    inHeader = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (hunk !== null) {
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        endHunk();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (line[0] === ' ') hunk.body.push({ kind: 'ctx', text: line.slice(1) });
        else if (line[0] === '-') hunk.body.push({ kind: 'old', text: line.slice(1) });
        else if (line[0] === '+') hunk.body.push({ kind: 'new', text: line.slice(1) });
        else hunk.body.push({ kind: 'bslash', text: line.slice(1) });
        i += 1;
        continue;
      }
      endHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new ParseFailure(i + 1);
      endSection();
      cur = freshSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseFailure(i + 1);
      if (cur === null) throw new ParseFailure(i + 1);
      hunk = { a: Number(m[1]), body: [] };
      inHeader = false;
      i += 1;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          cur.pairOld = stripUnifiedPath(line.slice(4));
          cur.pairNew = stripUnifiedPath(lines[i + 1].slice(4));
          i += 2;
          continue;
        }
        throw new ParseFailure(i + 2);
      }
      if (line.startsWith('+++ ')) {
        cur.plusNew = stripUnifiedPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (/^new file mode(?:$|[ \t])/.test(line)) {
        cur.isNew = true;
        i += 1;
        continue;
      }
      if (/^deleted file mode(?:$|[ \t])/.test(line)) {
        cur.isDel = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        endSection();
        cur = freshSection();
        cur.pairOld = stripUnifiedPath(line.slice(4));
        cur.pairNew = stripUnifiedPath(lines[i + 1].slice(4));
        inHeader = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  endSection();
  if (sections.length === 0) throw new ParseFailure(1);
  return sections.map(sectionToUnifiedEdit);
}

function sectionToUnifiedEdit(sec: Section): UnifiedEdit {
  const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.plusNew ?? sec.renameTo ?? sec.diffNew;
  if (oldPath === null || sec.isNew) {
    if (newPath === null) {
      return { format: 'unified', kind: 'noop', oldPath: null, newPath: null, hunks: sec.hunks };
    }
    return { format: 'unified', kind: 'create', oldPath: null, newPath, hunks: sec.hunks };
  }
  if (newPath === null || sec.isDel) {
    return { format: 'unified', kind: 'delete', oldPath, newPath: null, hunks: sec.hunks };
  }
  if (oldPath !== newPath) {
    return { format: 'unified', kind: 'move', oldPath, newPath, hunks: sec.hunks };
  }
  return { format: 'unified', kind: 'change', oldPath, newPath: null, hunks: sec.hunks };
}

/** A hunk's old lines O and new lines N, in body order. */
function hunkON(h: Hunk): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const bl of h.body) {
    if (bl.kind === 'ctx') {
      O.push(bl.text);
      N.push({ text: bl.text, ctx: O.length - 1 });
    } else if (bl.kind === 'old') {
      O.push(bl.text);
    } else if (bl.kind === 'new') {
      N.push({ text: bl.text, ctx: null });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function bslashAfterLastCtxOrPlus(h: Hunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j++) {
    if (h.body[j].kind === 'ctx' || h.body[j].kind === 'new') last = j;
  }
  if (last === -1) return false;
  return last + 1 < h.body.length && h.body[last + 1].kind === 'bslash';
}

function applyUnified(
  edit: UnifiedEdit,
  tree: Map<string, string>,
  strict: boolean,
): { move?: { oldPath: string; newPath: string } } {
  if (edit.oldPath !== null && !isSafePath(edit.oldPath)) {
    throw new EditFailure('unsafe', edit.oldPath);
  }
  if (edit.newPath !== null && !isSafePath(edit.newPath)) {
    throw new EditFailure('unsafe', edit.newPath);
  }
  if (edit.kind === 'noop') return {};
  if (edit.kind === 'create') {
    const newPath = edit.newPath as string;
    if (pathExists(tree, newPath)) throw new EditFailure('exists', newPath);
    const plus: string[] = [];
    let lastPlus: { h: Hunk; j: number } | null = null;
    for (const h of edit.hunks) {
      for (let j = 0; j < h.body.length; j++) {
        if (h.body[j].kind === 'new') {
          plus.push(h.body[j].text);
          lastPlus = { h, j };
        }
      }
    }
    const noBreak =
      lastPlus !== null &&
      lastPlus.j + 1 < lastPlus.h.body.length &&
      lastPlus.h.body[lastPlus.j + 1].kind === 'bslash';
    tree.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
    return {};
  }
  if (edit.kind === 'delete') {
    const oldPath = edit.oldPath as string;
    if (!tree.has(oldPath)) throw new EditFailure('missing', oldPath);
    tree.delete(oldPath);
    return {};
  }
  const oldPath = edit.oldPath as string;
  if (!tree.has(oldPath)) throw new EditFailure('missing', oldPath);
  if (edit.kind === 'move') {
    const newPath = edit.newPath as string;
    if (pathExists(tree, newPath)) throw new EditFailure('exists', newPath);
  }
  const model = parseFile(tree.get(oldPath) as string);
  let d = 0;
  for (const h of edit.hunks) {
    const { O, N } = hunkON(h);
    if (O.length === 0) {
      let ins = h.a + d;
      if (ins < 0) ins = 0;
      if (ins > model.lines.length) ins = model.lines.length;
      const atEnd = ins === model.lines.length;
      const repl = N.map((nl) => nl.text);
      model.lines.splice(ins, 0, ...repl);
      if (atEnd) model.eol = !bslashAfterLastCtxOrPlus(h);
      d += N.length - O.length;
      continue;
    }
    const found = findTier(O, model.lines, strict);
    if (found === null) throw new EditFailure('no-match', oldPath);
    const target = h.a - 1 + d;
    let best = found.pos[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const repl = buildNewLines(O, N, model.lines, best, found.tier);
    const touchesEnd = best + O.length === model.lines.length;
    model.lines.splice(best, O.length, ...repl);
    if (touchesEnd) model.eol = !bslashAfterLastCtxOrPlus(h);
    d += N.length - O.length;
  }
  const outText = serializeFile(model);
  if (edit.kind === 'move') {
    tree.delete(oldPath);
    tree.set(edit.newPath as string, outText);
    return { move: { oldPath, newPath: edit.newPath as string } };
  }
  tree.set(oldPath, outText);
  return {};
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

interface SREdit {
  format: 'search-replace';
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SREdit[] {
  const edits: SREdit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rtrimWs(lines[i]) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplace; j--) {
        const t = lines[j].trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new ParseFailure(searchLine);
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = rtrimWs(lines[j]);
        if (t === '=======') {
          eq = j;
          break;
        }
        if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      }
      if (eq === -1) throw new ParseFailure(searchLine);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        const t = rtrimWs(lines[j]);
        if (t === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
        if (t === '<<<<<<< SEARCH') break;
      }
      if (rep === -1) throw new ParseFailure(searchLine);
      edits.push({
        format: 'search-replace',
        path,
        oldLines: lines.slice(i + 1, eq),
        newLines: lines.slice(eq + 1, rep),
      });
      prevPath = path;
      prevReplace = rep;
      i = rep + 1;
      continue;
    }
    i += 1;
  }
  if (edits.length === 0) throw new ParseFailure(1);
  return edits;
}

function applySearchReplace(
  edit: SREdit,
  tree: Map<string, string>,
  strict: boolean,
): Record<string, never> {
  if (!isSafePath(edit.path)) throw new EditFailure('unsafe', edit.path);
  if (edit.oldLines.length === 0) {
    if (pathExists(tree, edit.path)) throw new EditFailure('exists', edit.path);
    tree.set(edit.path, edit.newLines.length === 0 ? '' : edit.newLines.join('\n') + '\n');
    return {};
  }
  if (!tree.has(edit.path)) throw new EditFailure('missing', edit.path);
  const model = parseFile(tree.get(edit.path) as string);
  const found = findTier(edit.oldLines, model.lines, strict);
  if (found === null) throw new EditFailure('no-match', edit.path);
  if (found.pos.length > 1) throw new EditFailure('ambiguous', edit.path);
  const at = found.pos[0];
  const N: NewLine[] = edit.newLines.map((t) => ({ text: t, ctx: null }));
  const repl = buildNewLines(edit.oldLines, N, model.lines, at, found.tier);
  model.lines.splice(at, edit.oldLines.length, ...repl);
  tree.set(edit.path, serializeFile(model));
  return {};
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NewLine[];
}

interface V4AEdit {
  format: 'v4a';
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

function parseV4a(lines: string[]): V4AEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseFailure(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFailure(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseFailure(lines.length + 1);

  const edits: V4AEdit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    } else {
      throw new ParseFailure(i + 1);
    }
    let j = i + 1;
    while (j < last) {
      const l = lines[j];
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
      j += 1;
    }
    let end = j;
    while (end > i + 1 && lines[end - 1].trim() === '') end -= 1;
    const body = lines.slice(i + 1, end);
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k];
        if (bl === '') addLines.push('');
        else if (bl[0] === '+') addLines.push(bl.slice(1));
        else throw new ParseFailure(i + 2 + k);
      }
      edits.push({ format: 'v4a', kind: 'add', path, moveTo: null, addLines, chunks: [] });
    } else if (kind === 'delete') {
      if (body.length > 0) throw new ParseFailure(i + 2);
      edits.push({ format: 'v4a', kind: 'delete', path, moveTo: null, addLines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (k < body.length && body[k].startsWith('*** Move to:')) {
        moveTo = body[k].slice('*** Move to:'.length).trim();
        k += 1;
      }
      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      let firstChunkStarted = false;
      const closeChunk = (): void => {
        if (curChunk !== null) {
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      while (k < body.length) {
        const bl = body[k];
        if (bl.startsWith('@@')) {
          closeChunk();
          const anchorText = bl.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, O: [], N: [] };
          firstChunkStarted = true;
          k += 1;
          continue;
        }
        if (bl === '*** End of File') {
          if (curChunk === null) throw new ParseFailure(i + 2 + k);
          curChunk.eof = true;
          closeChunk();
          k += 1;
          continue;
        }
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (curChunk === null) {
            if (firstChunkStarted) throw new ParseFailure(i + 2 + k);
            curChunk = { anchor: null, eof: false, O: [], N: [] };
            firstChunkStarted = true;
          }
          if (bl === '') {
            curChunk.O.push('');
            curChunk.N.push({ text: '', ctx: curChunk.O.length - 1 });
          } else if (bl[0] === ' ') {
            const t = bl.slice(1);
            curChunk.O.push(t);
            curChunk.N.push({ text: t, ctx: curChunk.O.length - 1 });
          } else if (bl[0] === '-') {
            curChunk.O.push(bl.slice(1));
          } else {
            curChunk.N.push({ text: bl.slice(1), ctx: null });
          }
          k += 1;
          continue;
        }
        throw new ParseFailure(i + 2 + k);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new ParseFailure(i + 1);
      edits.push({ format: 'v4a', kind: 'update', path, moveTo, addLines: [], chunks });
    }
    i = j;
  }
  if (edits.length === 0) throw new ParseFailure(1);
  return edits;
}

function applyV4a(
  edit: V4AEdit,
  tree: Map<string, string>,
  strict: boolean,
): { move?: { oldPath: string; newPath: string } } {
  if (!isSafePath(edit.path)) throw new EditFailure('unsafe', edit.path);
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) throw new EditFailure('unsafe', edit.moveTo);
  if (edit.kind === 'add') {
    if (pathExists(tree, edit.path)) throw new EditFailure('exists', edit.path);
    tree.set(edit.path, edit.addLines.length === 0 ? '' : edit.addLines.join('\n') + '\n');
    return {};
  }
  if (edit.kind === 'delete') {
    if (!tree.has(edit.path)) throw new EditFailure('missing', edit.path);
    tree.delete(edit.path);
    return {};
  }
  if (!tree.has(edit.path)) throw new EditFailure('missing', edit.path);
  if (edit.moveTo !== null && pathExists(tree, edit.moveTo)) throw new EditFailure('exists', edit.moveTo);
  const model = parseFile(tree.get(edit.path) as string);
  const tiers = strict ? [0] : [0, 1, 2];
  let cursor = 0;
  for (const ch of edit.chunks) {
    if (ch.anchor !== null) {
      let foundAt = -1;
      for (const t of tiers) {
        const nA = normLine(ch.anchor, t);
        for (let idx = cursor; idx < model.lines.length; idx++) {
          if (normLine(model.lines[idx], t) === nA) {
            foundAt = idx;
            break;
          }
        }
        if (foundAt !== -1) break;
      }
      if (foundAt === -1) throw new EditFailure('no-match', edit.path);
      cursor = foundAt + 1;
    }
    if (ch.O.length === 0) {
      const ins = ch.eof ? model.lines.length : cursor;
      const repl = ch.N.map((nl) => nl.text);
      model.lines.splice(ins, 0, ...repl);
      cursor = ins + repl.length;
      continue;
    }
    let chosen: { tier: number; at: number } | null = null;
    for (const t of tiers) {
      const pos = occurrencesAt(ch.O, model.lines, t).filter(
        (p) => p >= cursor && (!ch.eof || p + ch.O.length === model.lines.length),
      );
      if (pos.length > 0) {
        chosen = { tier: t, at: pos[0] };
        break;
      }
    }
    if (chosen === null) throw new EditFailure('no-match', edit.path);
    const repl = buildNewLines(ch.O, ch.N, model.lines, chosen.at, chosen.tier);
    model.lines.splice(chosen.at, ch.O.length, ...repl);
    cursor = chosen.at + repl.length;
  }
  const outText = serializeFile(model);
  if (edit.moveTo !== null) {
    tree.delete(edit.path);
    tree.set(edit.moveTo, outText);
    return { move: { oldPath: edit.path, newPath: edit.moveTo } };
  }
  tree.set(edit.path, outText);
  return {};
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

interface JsonEdit {
  format: 'json';
  kind: 'create' | 'str_replace' | 'insert';
  path: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

function validateJsonEdit(obj: unknown): JsonEdit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { format: 'json', kind: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str === undefined) {
      return { format: 'json', kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr: '' };
    }
    if (typeof o.new_str !== 'string') return null;
    return { format: 'json', kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr: o.new_str };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { format: 'json', kind: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], rawText: string): JsonEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseFailure(1);
  if (lines[first].trimStart()[0] === '[') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new ParseFailure(first + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseFailure(first + 1);
    const edits: JsonEdit[] = [];
    for (const el of parsed) {
      const e = validateJsonEdit(el);
      if (e === null) throw new ParseFailure(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseFailure(1);
    return edits;
  }
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      throw new ParseFailure(i + 1);
    }
    const e = validateJsonEdit(parsed);
    if (e === null) throw new ParseFailure(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseFailure(1);
  return edits;
}

function applyJson(edit: JsonEdit, tree: Map<string, string>): Record<string, never> {
  if (!isSafePath(edit.path)) throw new EditFailure('unsafe', edit.path);
  if (edit.kind === 'create') {
    if (pathExists(tree, edit.path)) throw new EditFailure('exists', edit.path);
    tree.set(edit.path, edit.fileText as string);
    return {};
  }
  if (!tree.has(edit.path)) throw new EditFailure('missing', edit.path);
  if (edit.kind === 'str_replace') {
    const raw = tree.get(edit.path) as string;
    const isCrlf = parseFile(raw).brk === '\r\n';
    let text = raw;
    let oldStr = edit.oldStr as string;
    let newStr = edit.newStr as string;
    if (isCrlf) {
      text = raw.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let idx = 0;
    let firstIdx = -1;
    for (;;) {
      const found = text.indexOf(oldStr, idx);
      if (found === -1) break;
      if (firstIdx === -1) firstIdx = found;
      count += 1;
      idx = found + 1;
    }
    if (count === 0) throw new EditFailure('no-match', edit.path);
    if (count > 1) throw new EditFailure('ambiguous', edit.path);
    let replaced = text.slice(0, firstIdx) + newStr + text.slice(firstIdx + oldStr.length);
    if (isCrlf) replaced = replaced.replace(/\n/g, '\r\n');
    tree.set(edit.path, replaced);
    return {};
  }
  const raw = tree.get(edit.path) as string;
  const model = parseFile(raw);
  const insertLine = edit.insertLine as number;
  if (insertLine < 0 || insertLine > model.lines.length) throw new EditFailure('no-match', edit.path);
  const newLines = splitPatchLines(edit.newStr as string);
  model.lines.splice(insertLine, 0, ...newLines);
  tree.set(edit.path, serializeFile(model));
  return {};
}

/* ------------------------------------------------------------------ */
/* Order and atomicity (SPEC section 10), format detection (section 4) */
/* and invocation (sections 1 and 2)                                   */
/* ------------------------------------------------------------------ */

type AnyEdit = UnifiedEdit | SREdit | V4AEdit | JsonEdit;

interface MoveRecord {
  oldPath: string;
  newPath: string;
}

function loadTree(dir: string): Map<string, string> {
  const tree = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      const r = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isDirectory()) walk(p, r);
      else if (entry.isFile()) tree.set(r, readFileSync(p, 'utf8'));
    }
  };
  walk(dir, '');
  return tree;
}

function writeTree(initial: Map<string, string>, finalTree: Map<string, string>): void {
  for (const p of initial.keys()) {
    if (!finalTree.has(p)) rmSync(p);
  }
  for (const [p, content] of finalTree) {
    if (initial.get(p) !== content) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
  }
}

interface RunResult {
  exit: number;
  output: string;
  finalTree: Map<string, string>;
}

function runEdits(
  edits: AnyEdit[],
  initial: Map<string, string>,
  strict: boolean,
  checkOnly: boolean,
): RunResult {
  const tree = new Map(initial);
  const failures: EditFailure[] = [];
  const moves: MoveRecord[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree);
    try {
      let res: { move?: { oldPath: string; newPath: string } } = {};
      if (edit.format === 'unified') res = applyUnified(edit, tree, strict);
      else if (edit.format === 'search-replace') res = applySearchReplace(edit, tree, strict);
      else if (edit.format === 'v4a') res = applyV4a(edit, tree, strict);
      else res = applyJson(edit, tree);
      if (res.move !== undefined) moves.push(res.move);
    } catch (err) {
      if (err instanceof EditFailure) {
        tree.clear();
        for (const [k, v] of snapshot) tree.set(k, v);
        failures.push(err);
      } else {
        throw err;
      }
    }
  }
  if (failures.length > 0) {
    const lines = failures.map((f) => `error: ${f.code} ${f.path}`);
    lines.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { exit: 1, output: lines.join('\n') + '\n', finalTree: tree };
  }
  interface ChangeEntry {
    sortKey: string;
    line: string;
    path: string;
    kind: 'A' | 'D' | 'M';
  }
  const entries: ChangeEntry[] = [];
  const allPaths = new Set<string>([...initial.keys(), ...tree.keys()]);
  for (const p of allPaths) {
    const before = initial.get(p);
    const after = tree.get(p);
    if (before === undefined && after !== undefined) {
      entries.push({ sortKey: p, line: `A ${p}`, path: p, kind: 'A' });
    } else if (before !== undefined && after === undefined) {
      entries.push({ sortKey: p, line: `D ${p}`, path: p, kind: 'D' });
    } else if (before !== undefined && after !== undefined && before !== after) {
      entries.push({ sortKey: p, line: `M ${p}`, path: p, kind: 'M' });
    }
  }
  const outLines: { sortKey: string; line: string }[] = [];
  for (const e of entries) outLines.push({ sortKey: e.sortKey, line: e.line });
  for (const m of moves) {
    const oldBefore = initial.get(m.oldPath);
    const newBefore = initial.get(m.newPath);
    const oldAfter = tree.get(m.oldPath);
    const newAfter = tree.get(m.newPath);
    if (
      oldBefore !== undefined &&
      oldAfter === undefined &&
      newBefore === undefined &&
      newAfter !== undefined
    ) {
      const dIdx = outLines.findIndex((e) => e.line === `D ${m.oldPath}`);
      const aIdx = outLines.findIndex((e) => e.line === `A ${m.newPath}`);
      if (dIdx !== -1 && aIdx !== -1) {
        outLines.splice(Math.max(dIdx, aIdx), 1);
        outLines.splice(Math.min(dIdx, aIdx), 1);
        outLines.push({ sortKey: m.newPath, line: `R ${m.oldPath} -> ${m.newPath}` });
      }
    }
  }
  outLines.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  const lines = outLines.map((e) => e.line);
  lines.push(`ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`);
  void checkOnly;
  return { exit: 0, output: lines.join('\n') + '\n', finalTree: tree };
}

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): FormatName | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank !== -1) {
    const first = lines[firstNonBlank];
    if (first.trim() === '*** Begin Patch') return 'v4a';
    const c = first.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (let i = 0; i < lines.length; i++) {
    if (rtrimWs(lines[i]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

function main(): void {
  const argv = process.argv.slice(2);
  let format: FormatName | 'auto' | null = null;
  let checkOnly = false;
  let strict = false;
  let positional: string | null = null;
  let positionalCount = 0;
  let endOfOptions = false;
  let usageError = false;
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seen.has('check')) {
          usageError = true;
          break;
        }
        seen.add('check');
        checkOnly = true;
      } else if (arg === '--strict') {
        if (seen.has('strict')) {
          usageError = true;
          break;
        }
        seen.add('strict');
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seen.has('format')) {
          usageError = true;
          break;
        }
        seen.add('format');
        const v = arg.slice('--format='.length);
        if (
          v !== 'unified' &&
          v !== 'search-replace' &&
          v !== 'v4a' &&
          v !== 'json' &&
          v !== 'auto'
        ) {
          usageError = true;
          break;
        }
        format = v as FormatName | 'auto';
      } else {
        usageError = true;
        break;
      }
      continue;
    }
    positionalCount += 1;
    if (positionalCount > 1) {
      usageError = true;
      break;
    }
    positional = arg;
  }
  if (usageError) {
    writeSync(1, 'error: usage\n');
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (positional === null || positional === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(positional, 'utf8');
    } catch {
      writeSync(1, 'error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }
  const lines = splitPatchLines(patchText);
  let fmt: FormatName | null = null;
  if (format === null || format === 'auto') {
    fmt = detectFormat(lines);
    if (fmt === null) {
      writeSync(1, 'error: format\n');
      process.exitCode = 2;
      return;
    }
  } else {
    fmt = format;
  }
  let edits: AnyEdit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (err) {
    if (err instanceof ParseFailure) {
      writeSync(1, `error: parse ${err.line}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  const initial = loadTree(process.cwd());
  const result = runEdits(edits, initial, strict, checkOnly);
  if (result.exit === 0 && !checkOnly) writeTree(initial, result.finalTree);
  writeSync(1, result.output);
  process.exitCode = result.exit;
}

/* ------------------------------------------------------------------ */
/* Entry point (at the end, so every declaration above is initialised) */
/* ------------------------------------------------------------------ */

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
