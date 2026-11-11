## Review — Bound interval frame extraction during production

**PR:** [#16](https://github.com/tugudush/video-analyzer/pull/16) · head `10-p2-enforce-size-and-frame-budgets-for-platform-downloads-and-interval-extraction` → `main` · one commit (`cf9a810`).

**Verdict: approve, with minor suggestions.** The budget is enforced at the right layer: it reaches ffmpeg as `-frames:v`, so production stops instead of the response being trimmed, and `maxImages` stays a paging control. The reinterpretation of `0` as "no configured ceiling" is stated consistently everywhere a user would look (README, `.env.example`, CLI help, `configuration.md`, `findings-and-plan.md`, and the input-schema description), and the warning distinguishes the configured budget from the hard ceiling and gives different advice for each. On this branch `typecheck`, `lint` and `format:check` are green, and `test` reports 138 passed / 11 skipped.

Scope note: the branch name also covers platform-download size budgets, but the only changed behaviour is interval extraction. That is correct — `yt-dlp` and the platform path are gone, so `downloadToFile` is the only downloader — and the PR adds the two tests that half of the finding was missing (declared `Content-Length`, and a body with no `Content-Length` that only outgrows the limit mid-stream). `codebase-review.md` records the split accurately.

**Status: resolved.** Every item below was addressed in `14396ff` on this branch. Re-verified after the fixes: `typecheck`, `lint` and `format:check` green, `test` at 143 passed / 11 skipped (`tests/unit/extractFrames.test.ts` now has 14 tests, 5 of them new). Each item keeps its original wording, followed by how it was resolved; the line references point at `cf9a810`, the commit that was reviewed.

### Should fix (small)

1. **`data.truncated` is `false` for a truncated `scene` result.** `truncated` is declared at `src/operations/extractFrames.ts:121`, set from the interval result at `:138`, and emitted unconditionally at `:193` and `:227`. The scene branch only warns (`:175`) and never assigns it, so a scene list clipped at the 200-frame ceiling reports `"truncated": false`. Either assign `truncated = result.truncated` there, or scope the field to interval mode and say so in `operations.md`. No test covers scene truncation, which is why this survived. **Resolved:** the scene branch assigns `truncated = result.truncated`; new tests assert both the clipped scene list (`totalFrames: 2, truncated: true` with a ceiling warning) and the complete one (`truncated: false`, no warnings).

2. **The hard-ceiling branch misfires when `VIDEO_ANALYZER_MAX_FRAMES` is exactly `500`.** At `:143-146`, `atHardCeiling` requires `maxFrames === 0 || maxFrames > MAX_FRAMES_PER_EXTRACTION`. A configured `500` resolves to a budget of 500 and falls into the _configured-budget_ branch, whose advice — "Raise VIDEO_ANALYZER_MAX_FRAMES" — cannot help, because the value is already clamped to the ceiling. `<= 0 || >=` is the right test, and `500` is exactly the value a careful reader is most likely to set. **Resolved:** the condition is now `maxFrames <= 0 || maxFrames >= MAX_FRAMES_PER_EXTRACTION`, with a test that a configured `500` gets the hard-ceiling advice and not "Raise VIDEO_ANALYZER_MAX_FRAMES".

3. **`resolveFrameBudget(0.5)` returns `0`, and `-frames:v 0` means unlimited.** `Math.min(Math.floor(configured), MAX_FRAMES_PER_EXTRACTION)` at `src/services/ffmpeg.ts:184` floors any value below 1 to zero. `readInt` in `loadConfig` only admits integers so this is unreachable through env config today, but the helper is exported, unit-tested and documented as "the effective frame budget"; a fractional value would disable the very cap it exists to enforce. `Math.max(1, Math.min(Math.floor(configured), MAX_FRAMES_PER_EXTRACTION))` closes it. **Resolved:** the clamp is wrapped in `Math.max(1, …)`, and `resolveFrameBudget(0.5) === 1` is asserted next to the existing `0`/negative/`NaN` cases.

4. **`Config.maxFrames` still documents the old meaning.** `src/config.ts:17` says "Frame ceiling for AI-assisted sampling. `0` means no fixed ceiling." Every user-facing document this PR touched now says "frame budget … 500-frame hard cap", and the `codebase-review.md` status paragraph leans on that wording. The interface comment is the one place still describing the previous contract. **Resolved:** `Config.maxFrames` now documents the budget, the `0` meaning and the 500-frame hard ceiling, matching the user-facing docs.

### Worth considering

5. **Put `expectedFrames` (and `frameBudget`) in `data`, not only in the warning text.** `IntervalExtractionResult` already carries both, and the operation throws them away after formatting prose. The Skill's procedure tells the agent to relay warnings, but an agent deciding whether to re-run or page needs those numbers structurally; making it parse them back out of a sentence is what `data` is for. **Resolved:** `interval` results carry `data.expectedFrames` and `data.frameBudget` (in both the framed and empty-result shapes), documented in `operations.md` and asserted in a unit test.

6. **`truncated` is derived from the expectation, not from what happened.** `truncated: expectedFrames > frameBudget` (`ffmpeg.ts:305`) claims the budget stopped extraction even when ffmpeg produced fewer frames than the budget for an unrelated reason (a short decode, a container whose duration overstates the media). `expectedFrames > paths.length` describes the response truthfully in both cases, and both numbers are already in hand. **Resolved:** truncation is now `expectedFrames > paths.length`, and the warning reports the frames actually written ("extraction stopped after N frames against the B-frame budget"), so the prose and the flag agree.

7. **Three ceilings now exist for one setting, and two are inline literals.** Interval/hard ceiling 500 (`MAX_FRAMES_PER_EXTRACTION`), `even` count max 500 (a literal in the schema), scene 200 (`Math.min(sceneBudget, 200)`, plus another `200` in the warning). Using the constant for the schema `.max()` and naming the scene ceiling would keep `operations.md` honest as they drift. Relatedly, the warning's "use mode `even`" advice is correct but `even` is also capped at 500 — it re-spreads the clip rather than dumping every frame, and there is now no per-call way to exceed 500 frames at all. Worth stating explicitly. **Resolved:** `MAX_SCENE_FRAMES` names the 200-frame ceiling, `count` reuses `MAX_FRAMES_PER_EXTRACTION`, and `operations.md` lists all three ceilings (500 for `even`/`interval`, 200 for `scene`, 100 timestamps) and states that no input raises them.

8. **A second `ffprobe` per interval extraction.** `prepareMedia` already returned `prepared.metadata`, and the warning at `:147` uses `prepared.metadata.durationSeconds`, while `extractFramesAtInterval` probes again (`ffmpeg.ts:271`) to compute `expectedFrames`. Passing the duration in would remove a subprocess and make the two numbers provably identical. `extractFramesEvenly` has the same shape, so this is a pre-existing pattern rather than a new defect. **Resolved:** `FrameExtractionOptions.durationSeconds` lets the operation pass the duration it already probed, so `even` and `interval` no longer run a second `ffprobe`; the fallback keeps direct service callers working.

9. **`MediaSource` still advertises `'platform'`.** `src/services/mediaInput.ts:10` keeps the union member although nothing produces it any more. Small, but the PR's own status text says "`yt-dlp` and the platform paths are gone". **Resolved:** `MediaSource` is now `'local' | 'direct'`.

10. **Link P2 #12 (reused output directories) into the new status paragraph.** `listFrames` still returns every `.jpg` in `outputDir`, so a budgeted re-run into a dirty directory returns old frames and `truncated` then describes a directory rather than an extraction. The new `truncated` + `totalFrames` pair can disagree in a way that reads as a budgeting bug; one sentence pointing at #12 keeps the two findings connected. **Resolved:** the `codebase-review.md` status paragraph now points at [#12](#p2-reusing-a-frame-output-directory-returns-stale-files) and states that stale-directory mixing remains open.

### Nits

11. `tests/unit/extractFrames.test.ts:133` and `:150` — "explains the hard ceiling when the configured budget is uncapped" and "applies the hard ceiling when the configured budget is uncapped" assert different things under near-identical names. Renaming one after what it checks (`reports the expected count…`, `passes the hard cap to ffmpeg…`) would make a future failure easier to triage. **Resolved:** renamed to "reports the expected count when the hard ceiling applies" and "passes the hard cap to ffmpeg when the configured budget is uncapped".

12. Pre-existing, spotted while reading the branch: the scene warning at `:177` interpolates `sceneBudget || 200`, but the applied limit is `Math.min(sceneBudget, 200)`. With `VIDEO_ANALYZER_MAX_FRAMES=300` it reports a "300-frame safety ceiling" while clipping at 200. **Resolved:** the warning interpolates `sceneLimit`, the value actually applied, so the same configuration now reports a 200-frame ceiling.

### Nice touches

- `-frames:v` sits as an output option after the filter chain and before the pattern, so it bounds the encoder instead of the returned page.
- `rejects a sub-minimum intervalSec before producing any frame` is meaningful because `executeOperation` does **not** validate — only the CLI and MCP adapters call `inputSchema.parse` — so the test proves the new service-level guard in `ffmpeg.ts`, not just the schema.
- The fake `execFile` honours `-frames:v` and writes files, so the assertions are about what landed on disk, not only about the argument list.
- `resolveFrameBudget` has its own unit block covering `0`, negative, `NaN` and clamping.
- The download tests use `Response` with and without `Content-Length`, which is exactly the pair the streaming guard exists for.
- `operations.md` explains how `maxImages` relates to the budget — the interaction this change is most likely to confuse later.

### Verification

- `npm run typecheck`, `npm run lint`, `npm run format:check`: green.
- `npm test`: 15 files passed, 1 skipped; 138 tests passed, 11 skipped.
- `tests/integration/localMedia.test.ts` skipped in full on this machine — neither `ffmpeg` nor `ffprobe` is installed — so the new budgeted integration case did not execute here, and the `-frames:v` behaviour is verified only against the unit fake. Worth one CI run with ffmpeg available before merge.
