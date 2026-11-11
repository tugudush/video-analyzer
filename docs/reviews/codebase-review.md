# Codebase review

Reviewed 2026-11-11 against commit `f3f28e7`. Scope: the shared operations, CLI and MCP adapters, media and Gemini services, filesystem/network helpers, documentation, and relevant tests. This is a risk-focused review, not a security certification.

## Resolution

All four findings below have been addressed. Startup cleanup now requires an application ownership marker and an exited owner process; older unmarked entries are intentionally left untouched. Gemini responses must finish normally before their text is returned or saved. Metadata and frame extraction consistently use the first video stream, and timestamp parsing preserves numeric descriptions.

After the fixes, `npm run check` passed: 276 tests passed and one Windows symlink test was skipped. Gemini completion handling was tested with simulated SDK responses, not a live provider.

## Original findings

### P1 — Startup cleanup can delete unrelated directories

The original `sweepStaleTempDirs` in [`fsUtils.ts`](../../src/utils/fsUtils.ts) recursively removed every directory in the system temp root whose name started with `video-analyzer-` and whose directory mtime was older than 24 hours. The prefix was not proof of ownership or inactivity: an unrelated directory, or an active directory whose contents change without updating the directory mtime, could satisfy the test. The sweep runs on the first CLI operation and MCP startup ([CLI](../../src/adapters/cli.ts), [MCP](../../src/adapters/mcpServer.ts)).

**Evidence:** In an isolated temp root, a directory named `video-analyzer-unrelated-project` containing a file was removed after its directory mtime was set two days old.

**Recommendation:** Restrict cleanup to a private, application-owned namespace with an ownership marker and a reliable liveness mechanism; never recursively delete an arbitrary prefix match. Add tests for unrelated matching directories and active work.

### P2 — Truncated Gemini output is accepted as complete

The original `GoogleGenAiApi.generateContent` in [`gemini.ts`](../../src/services/gemini.ts) returned any nonempty `response.text` without checking the candidate's finish reason. If Gemini returned partial text with `MAX_TOKENS` or another abnormal finish, the operations presented it as a complete answer. In particular, [`transcribe_video`](../../src/operations/transcribeVideo.ts) could write the incomplete transcript to the requested file without a warning.

**Evidence:** A simulated SDK response with text `partial transcript` and `finishReason: MAX_TOKENS` returned the text normally. The SDK exposes `MAX_TOKENS` as a candidate finish reason; no live Gemini call was made.

**Recommendation:** Preserve and inspect finish metadata at the SDK boundary. Fail explicitly or expose an unmistakable partial-result warning for non-complete responses, including before saving transcripts. Cover truncated and normal responses with SDK-boundary tests.

### P2 — Metadata and frame extraction can select different video streams

`getMediaMetadata` in [`ffmpeg.ts`](../../src/services/ffmpeg.ts) reported the first video stream, but frame extraction invoked FFmpeg without explicitly mapping that stream. FFmpeg could select a different default stream. Users could therefore receive codec, dimensions, and frame rate for one stream while extracted frames came from another.

**Evidence:** A generated two-stream MKV with a 64×64 first stream and a 128×128 second stream marked default produced metadata reporting 64×64, but timestamp extraction produced a 128×128 frame.

**Recommendation:** Define a stream-selection policy and use the same selected stream for metadata and every extraction mode, or expose all streams and the one selected. Add a multi-stream integration fixture.

### P2 — Timestamp parser consumes numeric descriptions as end times

The original `parseTimestampMatches` in [`searchTimestamp.ts`](../../src/operations/searchTimestamp.ts) interpreted a number after a dash as a potential range end, even when it began the description. `MATCH 42 — 3 speakers appear` lost `3`; `MATCH 42 — 50 people enter` became a fabricated 42–50 second range and lost `50`. The original test expected the first loss.

**Recommendation:** Disambiguate ranges from descriptions using a well-defined response format, preserve the complete description, and test numeric descriptions both below and above the starting timestamp.

## Validation and coverage

- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run format:check` passed on Windows with Node 26 and FFmpeg available.
- The test run reported 268 passed and one skipped test; the skipped Windows symlink case requires privileges. FFmpeg integration tests ran.
- The cleanup, timestamp parsing, and multi-stream findings were reproduced locally with isolated fixtures. The Gemini finish-reason case used a simulated SDK response; live provider behavior and credentials were not tested.

## Strengths and remaining limitations

- A shared registry and execution path support CLI/MCP parity, and the suite covers local media, cancellation, frame paging, and upload reuse.
- Remote downloads validate redirects and enforce size limits. As the README notes, DNS resolution is not pinned to the connection, so this is best-effort SSRF protection rather than a complete network boundary.
- Gemini output remains model-generated and timestamp estimates need independent verification. Automated tests with mocked provider responses do not establish live model quality or provider compatibility.
