# Codebase Review

**Date:** 2026-11-11
**Revision:** `a982af1` (`main`; the only working-tree change is this file)
**Scope:** all of [`src/`](../../src) (29 files, ~3,900 lines), [`tests/`](../../tests) (19 suites + 2 helpers, ~3,200 lines), the Skill package ([`skills/video-analyzer`](../../skills/video-analyzer): `SKILL.md`, three references, the launcher, ~660 lines), [`README.md`](../../README.md), [`findings-and-plan.md`](../../findings-and-plan.md), and the build/lint/test configuration.

## Verdict

Green gate, clean layering, and an unusually consistent error contract. **No P1 and no P2 defect was found.** Every one of the ten findings from the previous review is still fixed, and each was re-checked against the current source rather than the resolution table.

Three P3 issues and six P4 issues remain. None of them corrupts data or opens a remote hole; they are contract and ergonomics gaps at the edges of an otherwise disciplined codebase:

- the documented recovery path (`help <operation>`) is unreachable when a setting is malformed,
- `search_timestamp` will happily relay an inverted time range,
- the MCP interface inlines multi-megabyte image payloads by default.

> **Updated 2026-11-11.** Findings 1–3 (the three P3s) have since been fixed; see [Resolution Status](#resolution-status). Findings 4–9 remain open.

## Method

- Read every source file, every test suite, the Skill package and its three reference documents, the README, and the build/lint/test configuration. Compared each documented operation, setting, error code, limit, and exit behaviour against the implementation.
- Ran the full gate: `npm run check` (build → typecheck → oxlint → vitest → prettier). **Green** — `tsc --noEmit` clean, oxlint clean, **225 passed / 1 skipped** across 19 files in ~6 s at review time (229 / 1 after the resolutions below), Prettier clean.
- Re-ran the suite with `FFMPEG_PATH`/`FFPROBE_PATH` pointing at missing binaries: **214 passed / 12 skipped (226)**, i.e. the eleven ffmpeg-dependent skips the README documents plus the always-skipped Windows symlink case.
- Generated a 6 s H.264/AAC clip with ffmpeg and drove the built `dist/cli.js` for every probe below (all in the OS temp directory, except where noted).

## Findings Summary

| #   | Severity | Area               | Finding                                                                                                                        |
| --- | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | P3       | CLI contract       | `--version` and `help` load configuration first, so one malformed setting disables the documented recovery path                |
| 2   | P3       | Result correctness | `search_timestamp` accepts `endSeconds < startSeconds` and never range-checks `endSeconds` against the clip                    |
| 3   | P3       | MCP transport      | `extract_frames` inlines up to 20 full-size frames (~1–5 MB of base64) into a single MCP tool result with no size guard        |
| 4   | P4       | Result shape       | A zero-frame extraction keeps an empty artifact directory and emits an undocumented `data.frames: []` that no other branch has |
| 5   | P4       | Silent fallback    | Unknown CLI flags are swallowed; an unrecognised `VIDEO_ANALYZER_LOG_LEVEL` silently becomes `warn`                            |
| 6   | P4       | SSRF hardening     | Three IPv6 encodings that reach private IPv4 are treated as public (6to4, IPv4-compatible, site-local)                         |
| 7   | P4       | Download integrity | A truncated body is reported as a completed download; `Content-Length` is only compared against the size cap                   |
| 8   | P4       | Dead surface       | Payloads are validated twice per call; `maxWidth` is unreachable; one scene-mode `truncated` branch is always `false`          |
| 9   | P4       | Process            | No CI, so the build/lint/test/format claims still rest on a developer machine with ffmpeg                                      |

## Findings

### P3: `--version` and `help` are blocked by an invalid configuration

**Where:** [`cli.ts:273`](../../src/adapters/cli.ts:273) calls `loadConfig` before [`parseArgs` at line 147](../../src/adapters/cli.ts:147), so every branch — including the two that never touch configuration — depends on a valid environment.

```text
$ VIDEO_ANALYZER_REQUEST_TIMEOUT_MS=not-a-number node dist/cli.js --version
{"ok":false,"error":{"code":"INVALID_INPUT",
 "message":"VIDEO_ANALYZER_REQUEST_TIMEOUT_MS must be an integer >= 1000.","hint":"Received \"not-a-number\"."}}
exit=1

$ VIDEO_ANALYZER_REQUEST_TIMEOUT_MS=not-a-number node dist/cli.js help
{"ok":false,…same error…}
```

**Impact:** `help <operation>` is the documented next step for an `INVALID_INPUT` rejection ([`troubleshooting.md`](../../skills/video-analyzer/references/troubleshooting.md), [`SKILL.md`](../../skills/video-analyzer/SKILL.md)) and the only way an agent can recover an argument name. A malformed setting — including one that arrives through the repository's own `.env`, which is exactly the untrusted-input case the allowlist was built for — turns that recovery step into the same opaque failure. `--version` is also the natural health check for wrappers and CI, and it fails the same way. `list` and `mcp` work today only because they are reached after the same load.

**Suggested fix:** parse argv first and load configuration only on the branches that need it (an operation, or `mcp`). `--version`, `help`, and `list` read nothing from `Config` — `CLI_USAGE` is built from the registry at module load — so they can run before `loadConfig` is called. Add a test that `runCli(['--version'], io, { VIDEO_ANALYZER_REQUEST_TIMEOUT_MS: 'nope' })` still prints the version and exits `0`.

### P3: `search_timestamp` relays inverted and unbounded ranges

**Where:** [`parseTimestampMatches`](../../src/operations/searchTimestamp.ts:37) accepts any second number as the end of a range ([line 67](../../src/operations/searchTimestamp.ts:67)); the only sanity check is on the start ([line 146](../../src/operations/searchTimestamp.ts:146)).

```text
$ node -e "…parseTimestampMatches('MATCH 42 — 3 speakers appear on screen')"
[{ "startSeconds": 42, "endSeconds": 3, "description": "speakers appear on screen" }]

$ …('MATCH 10 to 5 — backwards range')
[{ "startSeconds": 10, "endSeconds": 5, … }]
```

The summary then renders `00:00:42.000 – 00:00:03.000: speakers appear on screen`, and there is no warning, because `durationSeconds` is only compared with `startSeconds`.

**Impact:** the two things this operation is trusted to be careful about are estimates and impossible values. The estimate warning is present and repeated, but an inverted range is worse than an estimate — it is a visible non-sequitur an agent will faithfully relay ("the clip ends before it starts"), and `MATCH 3 999 — …` on a 6 s clip passes the only range check that exists. [`operations.md`](../../skills/video-analyzer/references/operations.md) advertises `data.matches[]` with `startSeconds` and an optional `endSeconds` and says a match past the clip "cannot be real, so it is reported with a warning", which is currently only half true.

**Suggested fix:** when `endSeconds <= startSeconds`, drop `endSeconds` (a zero-length or inverted range is not a range). Extend the `beyondDuration` filter to `endSeconds` as well, and keep one warning that counts both. Two unit tests over `parseTimestampMatches` and one over the operation's warning text are enough.

### P3: the MCP interface inlines up to 20 full-size frames per call

**Where:** [`DEFAULT_MAX_IMAGES = 20`](../../src/operations/extractFrames.ts:79) is the page size for every interface, and [`mcpTools.ts:40`](../../src/adapters/mcpTools.ts:40) base64-encodes every returned frame into the tool result ([`loadImages`](../../src/adapters/envelope.ts)).

Measured with 20 frames from a generated clip, scaled to the default 1280 px width:

```text
frames=20 rawKB=927 base64KB=1235 maxFrameKB=48   # synthetic test pattern, 320x240 source
```

**Impact:** 1.2 MB is the _floor_ — a test pattern is cheap to encode, and real footage at 1280 px with `-q:v 3` typically produces 100–200 KB per frame, i.e. 2–5 MB of base64 in one JSON-RPC message, on default settings, for a single tool call. MCP clients and stdio proxies commonly cap message size, so the failure mode is a large `extract_frames` result that cannot be delivered at all even though ffmpeg already wrote the files successfully — the caller loses the manifest, not just the images. The CLI is unaffected: it returns `images[].path` only.

**Suggested fix:** pick one. Lower the MCP default page size (the CLI default can stay at 20), add a cumulative byte budget in `toCallToolResult` that stops inlining and reports the remaining paths, or return `resource_link` content for the MCP interface. Whichever is chosen, [`operations.md`](../../skills/video-analyzer/references/operations.md) should state the inline cost.

### P4: a zero-frame extraction keeps an empty directory and an undocumented `data.frames`

**Where:** the zero-result branch of [`extractFrames.ts:233`](../../src/operations/extractFrames.ts:233) returns `frames: []` plus the `outputDir` it created, and nothing removes that directory — only the error path calls `removeDir` ([line 306](../../src/operations/extractFrames.ts:306)).

```text
$ node dist/cli.js extract_frames --input '{"videoPath":"clip.mp4","mode":"scene","outputDir":"…/scene-empty"}'
{ "ok": true,
  "summary": "No frames were extracted. …",
  "data": { "mode": "scene", "outputDir": "…/frames-mwc6eidb-a07f23c0",
            "frames": [], "totalFrames": 0, "offset": 0, "hasMore": false, "truncated": false } }
exists after run: True        # empty directory left behind
```

**Impact:** two small contract warts in one branch. `data.frames` appears only here and is always empty, so it is an undocumented field that no consumer can rely on (`operations.md` documents `images[]`, `totalFrames`, `offset`, `hasMore`, `truncated`, `timestamps`, `expectedFrames`, `frameBudget` — never `frames`). And `outputDir` is documented as "the folder this request wrote into"; for this branch it is a folder the request created and abandoned. This repository's own working tree currently holds nineteen empty `video-analyzer-output/frames-*` directories, which is what this looks like after a few manual runs.

**Suggested fix:** in the zero-result branch, `await removeDir(outDir)` and stop reporting `outputDir`; delete `frames: []` from the payload. One assertion in the existing scene-mode test covers it.

### P4: silent fallbacks where every other setting fails loudly

- **Unknown CLI flags are swallowed.** [`cli.ts:181`](../../src/adapters/cli.ts:181) pushes anything unrecognised into `parsed.rest`, which no branch reads: `parseArgs(['get_video_info','--prety','--input','{}'])` yields `rest: ['--prety']` and plain (non-pretty) output. A typo'd `--input-file` degrades to the generic "requires arguments" error, which names neither the flag nor the mistake.
- **An unrecognised log level is silently downgraded.** [`config.ts:135`](../../src/config.ts:135) falls back to `warn` for anything outside `silent|error|warn|info|debug`, while every other malformed setting raises `INVALID_INPUT` naming the variable. `VIDEO_ANALYZER_LOG_LEVEL=verbose` produces no diagnostic at all, so a user debugging by turning logging _up_ gets the default.

**Suggested fix:** reject unknown `-`/`--` flags in `parseArgs` with `INVALID_INPUT` and a hint listing the accepted ones, and raise `INVALID_INPUT` for an unrecognised log level (listing the valid values, as `readBool` already does for booleans).

### P4: the SSRF classifier misses three IPv6 encodings

**Where:** [`isPrivateAddress`](../../src/utils/net.ts:123) decodes IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::a.b.c.d`) forms via [`embeddedIpv4`](../../src/utils/net.ts:144), but not 6to4 (`2002::/16`), not IPv4-compatible (`::a.b.c.d`), and not the deprecated site-local range (`fec0::/10`).

```text
2002:7f00:1::      -> false   # 6to4 wrapping 127.0.0.1
::127.0.0.1        -> false   # IPv4-compatible
fec0::1            -> false   # site-local
::ffff:127.0.0.1   -> true
64:ff9b::7f00:1    -> true
```

**Impact:** a public hostname that resolves to one of these forms is accepted, resolved, and connected to. The practical risk is low — 6to4 and IPv4-compatible addresses are rarely routed, and [`assertSafeHttpUrl`](../../src/utils/net.ts) already documents itself as best-effort against DNS rebinding — but the function otherwise tries to be exhaustive, so the gap is a genuine oversight rather than a documented policy.

**Suggested fix:** treat `2002::/16` and `fec0::/10` as private, and decode `::a.b.c.d` the way the mapped form is decoded (the existing `expandIpv6` already folds the dotted quad into two hex groups). Extend [`net.test.ts`](../../tests/unit/net.test.ts), which currently covers the mapped and NAT64 forms only.

### P4: a truncated download is reported as a completed download

**Where:** [`downloadToFile`](../../src/utils/net.ts:319) reads `content-length` only to enforce `maxBytes`, then counts streamed bytes at [line 344](../../src/utils/net.ts:344) and never compares the two.

**Impact:** when a server closes the connection mid-body, the partial file is written, the function returns normally, and the caller proceeds — for an AI operation that means uploading an incomplete file to Gemini and failing later as `GEMINI_PROCESSING_FAILED` or as a confusing ffprobe error. The error code that fits (`DOWNLOAD_FAILED`) is already in place; only the check is missing.

**Suggested fix:** after the pipeline completes, if `declaredLength` is finite and `bytesWritten < declaredLength`, raise `DOWNLOAD_FAILED` naming both numbers. A loopback test in [`net.test.ts`](../../tests/unit/net.test.ts) can serve a short body behind a larger `Content-Length`.

### P4: small dead surface and duplicated work

- **Every payload is validated twice.** The CLI parses at [`cli.ts:337`](../../src/adapters/cli.ts:337) and the MCP adapter at [`mcpTools.ts:71`](../../src/adapters/mcpTools.ts:71); [`executeOperation`](../../src/operations/execute.ts:64) then parses again, by design, so an embedder cannot skip validation. The cost is small but the second parse is pure duplication on the two hot paths.
- **`FrameExtractionOptions.maxWidth` is unreachable.** [`ffmpeg.ts:200`](../../src/services/ffmpeg.ts:200) accepts it, no operation supplies it, and every call site falls back to 1280. Either expose it as an input (the MCP payload-size finding makes this attractive) or delete it.
- **One scene-mode branch is dead.** [`ffmpeg.ts:530`](../../src/services/ffmpeg.ts:530) returns `truncated: unique.length > 0` on the empty-timestamp path, but that line is only reachable when `unique` is empty, so the value is always `false`.

**Suggested fix:** pass the already-parsed value into `executeOperation` (or parse once in a shared helper), and either wire `maxWidth` to an input or remove it. Each is a few lines; none changes behaviour.

### P4: no CI

There is still no `.github/` directory, so a green `npm run check` is a claim about one developer's machine. It matters more here than usual: the Skill suite drives the packaged launcher, the `.cmd` shim path is Windows-only, and eleven integration tests skip themselves when ffmpeg is absent — none of which a local run necessarily exercises together. One workflow matrixed over `ubuntu-latest` and `windows-latest` running `npm run check` with ffmpeg installed would pin all of it.

## Previous Review Status

The ten findings recorded in the previous revision of this document were re-checked against the current source (not taken from its resolution table). All remain fixed:

| #   | Previous finding                                       | Verification performed                                                                                                                                                                            |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm run check` never built the CLI                    | `package.json` has `"pretest": "npm run build"`; this run's gate output shows the build before vitest. `skill.test.ts` also fails with an explicit "run `npm run build`" message                  |
| 2   | `.env` was an unrestricted environment override        | Re-ran the probe: a `.env` with `FFPROBE_PATH`, `PATH`, and `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` in the working directory was ignored; only `VIDEO_ANALYZER_LOG_LEVEL` from that file took effect |
| 3   | Unusable artifact directory surfaced as INTERNAL       | `outputDir` pointing at a file now returns `OUTPUT_FAILED`, hint naming `outputDir`, `details.code: ENOTDIR`                                                                                      |
| 4   | A failed transcript write discarded the transcript     | Code returns the text in `summary` with a warning and `data.outputWritten: false`; pinned by `transcribeOutput.test.ts` (ENOSPC case)                                                             |
| 5   | `invoke.mjs help <operation>` printed general usage    | Launcher forwards `help`/`list` operands positionally; `skill.test.ts` asserts the operation schema and the absence of "Usage:"                                                                   |
| 6   | URL uploads could never hit the upload cache           | `ResolvedMedia.cacheKey` / `EnsureUploadedParams.cacheKey` key the cache on origin; `geminiService.test.ts` covers reuse across differing temp paths                                              |
| 7   | README claimed every CLI call prints one envelope      | README and `CLI_USAGE` now separate JSON (`operations`, `list`) from plain text (`--version`, `help`), and `CLI_USAGE` lists the upload/poll settings                                             |
| 8   | Trailing-space wording; "on PATH" for an explicit path | `FFPROBE_PATH=C:\definitely\missing\ffprobe.exe` now yields "The configured media binary was not found: …"; wording corrected in README and references                                            |
| 9   | `search_timestamp` / `extract_frames` shape gaps       | `durationSeconds` and `raw` are always present; an out-of-range `offset` reports "No frames on this page…"; a whitespace-only reply is `NO_SPEECH`                                                |
| 10  | Hygiene and packaging polish                           | `video-analyzer-output/` is in `.prettierignore`; the temp sweep covers launcher payload files; `package.json` has `repository`/`bugs`/`homepage`; dead export surface removed                    |

## Architecture And Quality

**Strengths**

- **One source of truth per concern.** [`registry.ts`](../../src/operations/registry.ts) owns names, titles, schemas, categories, and handlers; both adapters iterate it, and [`parity.test.ts`](../../tests/contract/parity.test.ts) enforces name, schema identity, description, and read-only/destructive parity. The `satisfies readonly Operation<z.ZodTypeAny>[]` constraint keeps the inferred `OperationName` union honest.
- **Uniform, typed error contract.** Every expected failure is a [`VideoAnalyzerError`](../../src/utils/errors.ts:43) with a code from a closed union, an optional hint, and structured `details`; adapters render it as JSON or text without leaking stacks. The findings above are visible precisely because the contract is otherwise this consistent — each one is a place where a branch drifts from it.
- **Deterministic seams.** [`GeminiMediaService`](../../src/services/gemini.ts) takes injectable `api`, `now`, and `sleep`; [`runWithBounds`](../../src/utils/abort.ts:32) makes deadline and cancellation behaviour testable without real timers; FFmpeg runs through `execFile` with argument arrays, so there is no shell.
- **Budgets enforced during production.** `-frames:v` caps interval extraction inside FFmpeg, `resolveFrameBudget` refuses to return `0` (which FFmpeg reads as unlimited), and `extractFramesAtTimestamps` stats every output instead of trusting the exit code.
- **Storage invariants documented at the type.** "One artifact directory per request" is explained on [`FrameExtractionOptions.outDir`](../../src/services/ffmpeg.ts), enforced for the modes that list the directory, covered by unit and integration tests, and the folder is removed on failure. Finding 4 is the one case the invariant does not cover.
- **Strictness that pays off.** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, and `isolatedModules` are enabled and satisfied rather than cast around. `no-console` is an error, which is what keeps stdout safe for both the CLI envelope and MCP frames.
- **Docs as part of the product.** README, `SKILL.md`, and the three references agree with the code on settings, error codes, exit behaviour, and Windows quirks, and a test enforces that every operation appears in `SKILL.md`.

**Weaknesses**

- **Process-global mutable state.** [`sharedService`](../../src/operations/shared.ts:16) and the logger [`sink`](../../src/utils/logger.ts:30) are module-level singletons with test-only reset hooks. Correct for the two shipped entry points; two embedders with different configs in one process would interfere, and the export surface does not say so. Rebuilding `Config` per call also silently discards the upload cache.
- **Two independent budgets are coupled.** The download deadline is `max(VIDEO_ANALYZER_REQUEST_TIMEOUT_MS, 60 s)`, so raising the request timeout to allow a large download also lengthens every Gemini call. A dedicated download timeout would separate them (noted in the previous review; still true).
- **Hard-coded FFmpeg budgets.** `FFMPEG_TIMEOUT_MS` (10 min) and `FFPROBE_TIMEOUT_MS` (60 s) are constants while every Gemini deadline is configurable; a scene extraction over a feature-length file can hit the former with no way to raise it.
- **No type-aware linting.** `oxlint` has no `no-floating-promises` or `no-misused-promises`, and the README explains why (TypeScript 7 support). Reasonable, but it means an unawaited promise anywhere in the operation layer would not be caught.

## Security Assessment

The network boundary remains the strongest part of the codebase.

- **SSRF defence is layered.** [`assertSafeHttpUrl`](../../src/utils/net.ts) rejects non-HTTP(S) schemes, embedded credentials, loopback/metadata names, and every private or reserved IPv4/IPv6 range it models; every redirect hop is revalidated and resolution failures fail closed. Finding 6 is a completeness gap in the IPv6 list, not a change in the model.
- **Size bounds are enforced twice.** `Content-Length` is checked before the body is read and the running byte count is checked while streaming, so a chunked response cannot exceed `maxBytes`. Finding 7 is the inverse (short) case.
- **Command execution is safe.** FFmpeg/FFprobe run via `execFile` with argument arrays, and input paths are resolved to absolute paths first, so a `videoPath` starting with `-` cannot be read as an option. The Skill launcher reaches `cmd.exe` on the Windows shim path, but Node quotes arguments containing `&`/`|`/`^` and the JSON payload is staged in a file rather than passed as an argument — I re-tested an operand containing `&echo …` and it arrived as a single quoted argument.
- **Source-media protection is thorough** for `transcribe_video`: canonical-path comparison (covering `..`, symlinks, casing) plus device/inode comparison (covering hard links) before upload, backed by an exclusive-create `wx` write so a target that appears after validation still cannot be clobbered.
- **`.env` is a convenience, not a trust grant.** `DOTENV_KEYS` limits what a repository-supplied file can set, so it cannot choose the binaries that run or relax the host policy. This is the single most important invariant in the codebase to keep — every new setting should be added to that list deliberately, never by default.
- **Secrets are never logged.** Diagnostics go to stderr or the MCP logging channel; the key is handed only to the SDK.
- **Residual risk is documented honestly.** The resolve-to-connect window is not pinned, so DNS rebinding remains theoretically possible; the README says so instead of over-claiming.

## Test Assessment

225 passing, 1 skipped, ~6 s at review time (229 / 1 after the resolutions) — fast enough to run on every save, and the assertions are specific rather than snapshot-shaped.

| Area                         | Coverage | Notes                                                                                                                                                                                 |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini timeouts/cancellation | Strong   | Stalled generation, status poll, and upload; pre-aborted signal; upload time counted against the processing deadline; shared upload surviving its initiator's cancellation            |
| Frame budgets                | Strong   | Budget passed as `-frames:v`, on-disk count capped, uncapped config still bounded, paging does not change the produced count, sub-minimum interval rejected before any process        |
| Output isolation             | Strong   | Reused directories report only their own frames; pre-populated directories rejected without invoking FFmpeg; integration test reuses one parent directory                             |
| Source overwrite protection  | Strong   | Relative spelling, `file://`, symlink, hard link, symlinked parent, existing file, directory target, exclusive-create race                                                            |
| Transcript preservation      | Good     | The ENOSPC case is simulated by intercepting `writeFile`, so the "text survives" contract is pinned rather than assumed                                                               |
| SSRF / download policy       | Good     | Private and reserved ranges, IPv6 mapped/NAT64, credentials, platform-page rejection, opt-in, declared and streamed size limits, redirect revalidation, timeout/cancel classification |
| CLI / MCP parity             | Strong   | Names, schema object identity, descriptions, read-only and destructive classification, a real in-memory MCP client                                                                    |

**Gaps introduced by this review's findings**

- ~~no test that `--version` / `help` survive a malformed environment (finding 1)~~,
- ~~no test for `endSeconds` ordering or an out-of-range end (finding 2)~~,
- no assertion about the zero-frame branch — neither the directory nor the `data.frames` key (finding 4),
- `net.test.ts` does not cover 6to4, IPv4-compatible, or site-local IPv6, nor a short body against a larger `Content-Length` (findings 6 and 7).

The struck-through gaps were closed with the resolutions (four new tests); 4, 6, and 7 are still outstanding.

**Other gaps**

- [`envelope.ts`](../../src/adapters/envelope.ts), [`errors.ts`](../../src/utils/errors.ts), [`abort.ts`](../../src/utils/abort.ts), and [`version.ts`](../../src/version.ts) have no direct unit tests; they are exercised only through callers.
- `runCli(['mcp'])` is untested — the MCP server is covered through `createMcpServer` instead, which is the better seam, but the subcommand's wiring is not.
- Integration and Skill suites skip themselves without ffmpeg, and nothing surfaces the skip count, so a run without ffmpeg still looks green. The README documents this (11 extra skips), and I confirmed the number.

## Verification Performed

```text
npm run check
  build      tsc -p tsconfig.build.json             clean
  typecheck  tsc -p tsconfig.json --noEmit          clean
  lint       oxlint src tests skills                clean
  test       vitest run                             19 files, 225 passed, 1 skipped (226), ~6 s
  format     prettier --check .                     clean

FFMPEG_PATH/FFPROBE_PATH=missing npx vitest run     18 files passed, 1 skipped; 214 passed, 12 skipped
```

Manual probes against the built `dist/` (temp directories only):

```text
VIDEO_ANALYZER_REQUEST_TIMEOUT_MS=not-a-number node dist/cli.js --version   → INVALID_INPUT, exit 1   (finding 1)
… node dist/cli.js help                                                     → INVALID_INPUT, exit 1   (finding 1)
parseTimestampMatches('MATCH 42 — 3 speakers appear')                       → start 42, end 3         (finding 2)
extract_frames count=1,2,3,5,11,50,100 on a 6 s clip                         → exact counts: 1,2,3,5,11,50,100
extract_frames mode=scene on a static clip                                  → 0 frames, empty dir retained, data.frames: [] (finding 4)
extract_frames mode=interval intervalSec=0.5, MAX_FRAMES=5                  → 5 frames, truncated: true, warning names the budget
extract_frames mode=timestamps [1,99] on a 6 s clip                         → INVALID_INPUT naming 99s and 6.00s
extract_frames outputDir = existing file                                    → OUTPUT_FAILED, details.code ENOTDIR
isPrivateAddress('2002:7f00:1::' | '::127.0.0.1' | 'fec0::1')               → false, false, false      (finding 6)
FFPROBE_PATH=C:\definitely\missing\ffprobe.exe                              → DEPENDENCY_MISSING naming the path
.env with FFPROBE_PATH + PATH + ALLOW_PRIVATE_HOSTS in cwd                  → ignored; real ffprobe used
20 extracted frames at 1280 px                                              → 927 KB JPEG → 1.24 MB base64 (finding 3)
spawn(ComSpec, [...,'/c','shim.cmd','help','x&echo MARKER'])                 → argv arrived quoted, no shell injection
```

## Resolution Status

Findings 1–3 were fixed on 2026-11-11, in a follow-up commit. Findings 4–9 remain open.

| #   | Resolution                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `runCli` now parses argv first and defers `loadConfig` until after the `--version`, `help`, and `list` branches, so the diagnostic commands answer even when a setting is malformed. Operations and `mcp` still fail with `INVALID_INPUT` naming the setting. Covered by a new `cli.test.ts` case.                                           |
| 2   | `parseTimestampMatches` drops an end that is not after the start (an inverted or zero-length range is not a range), and the operation's duration check now covers `endSeconds` as well as `startSeconds`. Two parser tests and one operation test pin it; `operations.md` describes both rules.                                              |
| 3   | `loadImages` inlines the first frame and then stops at a 2 MB base64 budget (`INLINE_IMAGE_BUDGET_BYTES`); `mcpTools` reports the remaining frames as a text block with their paths, so nothing is lost. The CLI path is unchanged (paths only). Covered by a new `mcpTools.test.ts` case, and documented in `operations.md` and the README. |

Re-verified against the rebuilt `dist/`:

```text
VIDEO_ANALYZER_REQUEST_TIMEOUT_MS=not-a-number node dist/cli.js --version   → 0.1.0, exit 0
… node dist/cli.js help extract_frames                                      → operation schema, exit 0
… node dist/cli.js list                                                     → { ok: true, operations: [...] }, exit 0
… node dist/cli.js get_video_info --input …                                 → INVALID_INPUT naming the setting
parseTimestampMatches('MATCH 42 — 3 speakers appear')                       → start 42, no endSeconds
search_timestamp 'MATCH 5 30 — …' on a 20 s clip                            → warning about the 00:00:20.000 clip (unit test)
extract_frames over MCP, 20 noise frames at 1280 px                         → 3 inlined (1.88 MB base64), 17 reported by path
```

## Recommendations

1. ~~**Make the diagnostic commands configuration-independent.**~~ Done — see Resolution Status 1. The same shape protects `list` and the MCP startup message.
2. ~~**Treat model output as untrusted input at the parse boundary.**~~ Done for `endSeconds` — see Resolution Status 2.
3. ~~**Give the MCP image path a budget.**~~ Done — see Resolution Status 3.
4. **Close the two small hardening gaps while they are one-line checks:** the remaining IPv6 encodings in `isPrivateAddress` and the `Content-Length` comparison on download.
5. **Add CI.** One matrixed workflow running `npm run check` with ffmpeg installed pins the build, the Windows shim path, and the integration tests together; echo the skip count so a skipped run is visible.
6. **Keep the invariants that already work.** Single registry, closed error-code union, `.env` allowlist, one artifact directory per request, `execFile` with argument arrays. Each of them has already prevented a class of bug, and the findings above are all places where a branch drifted a little away from one.
