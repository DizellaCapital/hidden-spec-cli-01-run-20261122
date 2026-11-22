# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and `mend` reads each one exactly as `SPEC.md` says, changing every
file or nothing.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line for each path whose state changed (`A`, `D`, `M`, or
`R old -> new`), then `ok: <n> files`. Exit 1 prints one `error: <code>
<path>` line for each edit that failed, then `failed: <k> of <n> edits`,
and no file is written. Exit 2 prints a single `error: usage`,
`error: no-patch`, `error: format` or `error: parse <N>` line.

## How it works

- **Three matching tiers.** Old lines are found at the first tier where
  they occur: exact, then ignoring trailing spaces and tabs, then ignoring
  leading and trailing spaces and tabs. At tier 2 the replacement lines are
  re-indented from the old lines' indent to the file's, and context lines
  are always written as the file's own lines.
- **Unified diffs.** Sections, hunks, nearest-occurrence matching against
  the (often wrong) hunk line numbers, creations, deletions, renames, and
  `\ No newline at end of file` handling for the result's final line break.
- **SEARCH/REPLACE blocks.** The path is the nearest non-blank, non-fence
  line before the block, or the previous block's path; a block whose old
  lines occur more than once fails as `ambiguous`.
- **V4A patches.** Add, Delete and Update sections with a cursor that walks
  the file: anchors, first-chunk-without-`@@`, `*** End of File` chunks, and
  `*** Move to:` renames.
- **JSON edits.** One JSON array or JSON Lines of `create`, `str_replace`
  and `insert` objects, with CRLF normalisation for `str_replace`.
- **Atomicity.** Edits apply in order to the tree as earlier edits left it;
  a failed edit changes nothing, the edits after it still run, and when any
  edit failed no file is written at all.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. When
  `MAKEFUN_ENV_URL` is set it hands the trial over to `runner.ts`.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the
  checks from the env, runs `node main.ts` on each one in a fresh
  directory, and posts the exit code, stdout and files left behind.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check the program gets wrong, with what differed, and
  the practice score.
- `SPEC.md`: the whole specification — every sentence of it is a
  requirement, including the ones the practice set does not show.
- `LICENSE`: MIT.

## Practice result

    node check.ts program/generator/practice.json
    100 of 100 passed: practice score 1000

Entered on [make.fun](https://make.fun/?ref=qxacafna&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
