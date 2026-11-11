## Review — Prevent transcript output from overwriting source media

**Verdict: approve, with minor suggestions.** The ordering is right (all target validation happens before `prepareMedia` and before any upload), the alias check covers the realistic vectors (identical path, `file://` source, relative spelling, symlink, hard link), and every refusal asserts both "source bytes unchanged" and "no upload attempted". I ran `typecheck`, `lint`, `format:check` and `test` on the branch: all green (118 passed / 10 skipped; 9 new tests, 1 skipped on Windows).

Nothing here blocks the merge. Ordered by how much I'd care.

**Status: resolved.** Every item below was addressed in `5c77bb9` on this branch; the per-item summary is also posted on the PR ([comment](https://github.com/tugudush/video-analyzer/pull/15#issuecomment-6790703230)). Re-verified after the fixes: `typecheck`, `lint` and `format:check` green, `test` at 127 passed / 10 skipped. Each item keeps its original wording, followed by how it was resolved.

### Should fix (small)

1. **`skills/video-analyzer/references/troubleshooting.md` is now stale.** The `INVALID_INPUT` entry still says _"The JSON did not match the schema."_ That is no longer the whole truth — a well-formed input now also returns `INVALID_INPUT` for a source alias, an existing target without `overwrite`, and a directory target. Since that file tells the reader to "use the code to decide what to do next", add those cases with their fixes (`overwrite: true`, pick a different path), otherwise the agent-facing guidance points only at JSON schema errors. **Resolved:** `INVALID_INPUT` now covers both causes, with a table mapping each refusal message to its fix.

2. **`src/operations/transcribeVideo.ts:31` still promises "Parent directories are created"** — nothing creates them; that is the still-open P2 finding #13 in `docs/reviews/codebase-review.md`. This PR retouches exactly that line and adds the natural home for the fix, `resolveTranscriptTarget()` (`:86`), which already runs before the upload. An `await ensureDir(path.dirname(target))` there plus a nested-directory test closes #13 and makes the sentence true; otherwise drop the claim. As written the PR ships a doc line it knows to be false. **Resolved:** `resolveTranscriptTarget()` calls `ensureDir(path.dirname(target))` as its last step, before the upload; a nested-directory test covers it and P2 #13 is marked resolved.

### Worth considering

3. **The no-overwrite guarantee is check-then-write.** `stat` at `:104`, `writeFile` at `:167`: a target that appears in between is still silently clobbered, and a hard link created in between still truncates the source. `writeFile(target, text, { flag: overwrite ? 'w' : 'wx' })` makes the no-overwrite case atomic; map `EEXIST` / `EISDIR` back to the same `INVALID_INPUT` messages. (Probed: on Windows a directory gives `EEXIST` from `wx`, on Linux `EISDIR`, so the explicit `isDirectory` check is still worth keeping for the better message.) **Resolved:** `writeTranscript()` writes with `flag: 'wx'` when `overwrite` is false and maps `EEXIST` / `EISDIR` to the same `INVALID_INPUT` errors; the directory pre-check stays for the clearer message.

4. **`tests/unit/transcribeVideo.test.ts:119` skips on Windows**, which is exactly where alias detection is most likely to differ (case folding, junctions). A _symlinked-directory ancestor_ test built with `symlink(dir, link, 'junction')` needs no elevation on Windows — I verified it works here — and additionally exercises the "deepest existing ancestor" branch of `canonicalPath()`. Note the `nested/../sample.mp4` case at `:104` only re-tests `path.resolve`'s lexical normalisation, since `path.resolve` already collapses `..` before the helper sees it. **Resolved:** new `refuses an alias reached through a symlinked directory` test builds the link with `symlink(dir, linkDir, 'junction')`, and `canonicalPath()`'s ancestor branch is covered directly in `tests/unit/fsUtils.test.ts`.

5. **A `file://` URI as `outputPath` is accepted but not normalised.** `path.resolve('file:///C:/tmp/x.mp4')` yields `C:\…\file:\C:\tmp\x.mp4`, so the call fails later with an opaque `INTERNAL`/`ENOENT`. Either run `outputPath` through `normalizeLocalPath()` too, or reject a `file://` value explicitly. **Resolved:** `outputPath` is normalised with `normalizeLocalPath()`, and a test covers a `file://` target.

6. **`overwrite` without `outputPath` is silently ignored** — fine, but a note in the `describe` or the `operations.md` row would prevent "I passed overwrite and it still refuses" confusion. Same for re-runs: the SKILL.md example (`transcribe_video … "outputPath":"./interview.txt"`) now fails the second time unless `overwrite: true` is added. **Resolved:** noted in the zod `describe` ("Only used together with outputPath") and in `operations.md`, including the re-run consequence.

### Nits

7. `src/utils/fsUtils.ts:54` — `foldForCompare` is redundant on Windows (`realpath()` already returns the on-disk spelling) and can produce a false positive in a per-directory case-sensitive NTFS folder (`foo.txt` vs `FOO.txt`). The device/inode fallback covers the case-insensitive case on its own. Harmless, just not load-bearing. **Resolved:** `foldForCompare` removed — `realpath` plus the device/inode pair do the work, with mixed-case parity asserted in a test.

8. `docs/reviews/codebase-review.md` — the `#L25` anchor in the P2 #13 finding now points at `translateToEnglish` (`outputPath` starts at `:27`) because the schema grew. The new `#L131` / `#L98` anchors are accurate today; dropping line anchors altogether would stop this drifting on every edit. **Resolved:** every `#L<n>` anchor dropped from `codebase-review.md`; none remain.

9. `canonicalPath()` / `isSameFile()` are new exported helpers with no direct unit tests — they are only covered through the operation tests. A small `tests/unit/fsUtils.test.ts` would let the edge cases (nonexistent segment chain, casing, hard link) be asserted without the Gemini double. **Resolved:** new `tests/unit/fsUtils.test.ts` with six direct tests.

10. Error-code taste: `OUTPUT_FAILED` arguably fits a refused overwrite better than `INVALID_INPUT`, but `INVALID_INPUT` is consistent with "the caller passed something unusable". No action needed if you prefer it. **Resolved:** `INVALID_INPUT` kept, with the rationale recorded above the error builders; `OUTPUT_FAILED` stays reserved for the write itself.

### Nice touches

- Validating the target before `prepareMedia` means a doomed remote download no longer happens for a bad target, and the deferred `assertNotSourceAlias` at `:140` correctly costs only a `realpath` in what is effectively an unreachable case.
- `artifacts[].path` now reports the resolved target instead of re-resolving a possibly relative input — a small latent inconsistency removed.
- Subtitle rejection moved into the resolver with `SUBTITLE_EXTENSIONS` — same behaviour, one place.
- The throws happen before the `try`, so `finally { prepared.media.cleanup() }` is unaffected by the new early exits.
- Tests assert `uploadFile` was not called as well as the source bytes, so they keep holding even if the message or code changes.
