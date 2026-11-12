# Codebase review

## Live-run findings — 2026-11-12

Recorded while answering a real request end to end: "analyze
`https://www.youtube.com/watch?v=JAGPK-UCp60`" on Windows with Node 26.11.1,
ffmpeg/ffprobe 9.0.2, `@google/genai` 2.32.0, and `yt-dlp` 2026.07.04. Both
findings are documentation/contract gaps, not media-pipeline defects: every
operation returned a correct envelope, and `get_video_info`, `summarize_video`,
`transcribe_video`, and `extract_frames` all ran against the real Gemini API and
the real ffmpeg build.

| Finding                                                  | Severity | Status      |
| -------------------------------------------------------- | -------- | ----------- |
| Platform URLs have no documented workflow for the caller | P3       | ✅ Resolved |
| `summarize_video` timestamps carry no envelope warning   | P3       | Open        |

### P3 — Platform URLs have no documented workflow for the caller

The prohibition itself is stated three times ([README](../../README.md#L23),
[troubleshooting.md](../../skills/video-analyzer/references/troubleshooting.md#L63),
[README](../../README.md#L304)) and enforced correctly. Passing the YouTube watch
URL returns

```json
{
  "code": "UNSUPPORTED_INPUT",
  "message": "The URL did not return media.",
  "hint": "Use a direct media URL or a local file. Platform page downloads are disabled because their destinations cannot be validated."
}
```

after downloading the HTML page and discarding it. What is missing is the _next_
step: [SKILL.md](../../skills/video-analyzer/SKILL.md) tells the agent to "confirm
the user gave a usable input", but neither it nor
[troubleshooting.md](../../skills/video-analyzer/references/troubleshooting.md)
says what to do when the input _is_ a platform page — which is the most likely
first request this tool will ever receive. Here the media was fetched out of band
with `yt-dlp` and the local file passed to the CLI, which worked for every
operation.

Two operational details are worth capturing wherever that guidance lands:

- `yt-dlp`'s default extraction (the `android_vr` client) failed with
  `HTTP Error 403: Forbidden` on both the muxed 360p MP4 (format `18`) and the
  720p DASH pair (`398+140`); `--extractor-args "youtube:player_client=web_safari,ios,mweb"`
  succeeded on the first attempt.
- The 360p `18` stream is 21.1 MB for 7 minutes, so a typical link costs a
  multi-second download before analysis even starts.

**Resolved on 2026-11-12 — first as documentation, then as a feature.** The finding
started as a docs gap and ended as a behaviour change: a platform page URL is now
resolved automatically. When a remote URL answers with a document instead of media,
[mediaInput.ts](../../src/services/mediaInput.ts) hands the final URL to the new
[ytdlp.ts](../../src/services/ytdlp.ts) service and analyzes the download.

- Scope and guardrails: one video per call, capped at `YT_DLP_MAX_RESOLUTION`
  (720p), H.264/AAC preferred, bounded by `VIDEO_ANALYZER_DOWNLOAD_MAX_MB` and the
  request timeout, `--ignore-config` so a user config cannot inject options, and a
  YouTube player-client fallback that cleared the 403 recorded above.
- Settings: `YT_DLP_PATH`, `YT_DLP_MAX_RESOLUTION`, `YT_DLP_COOKIES_FILE`, and
  `YT_DLP_IMPERSONATE` are parsed again (they were inert when this review was
  written) and are environment-only, because they name an executable, a credential
  file, or a network identity.
- [README](../../README.md#getting-media-from-a-platform) documents installation,
  the settings, and the failure ladder; [SKILL.md](../../skills/video-analyzer/SKILL.md),
  [troubleshooting.md](../../skills/video-analyzer/references/troubleshooting.md#platform-download-failed),
  and [configuration.md](../../skills/video-analyzer/references/configuration.md)
  follow.
- The claim above that the rejection was "enforced correctly" is now historical:
  only a _non-document_ non-media response (an image, a JSON endpoint) is still
  rejected outright.
- Trade-off accepted: yt-dlp's own requests are outside the SSRF guard, which
  validates only the URL this tool contacts. That is stated in the README's Known
  Limitations rather than hidden.

### P3 — `summarize_video` timestamps carry no envelope warning

[operations.md](../../skills/video-analyzer/references/operations.md#L80) instructs
the caller to "say so when relaying them", and the model's prose said "All
timestamps are approximate", but `warnings` was `[]`. `search_timestamp` always
adds an estimate warning; `summarize_video` emits timestamped Key Moments and does
not, so a caller that relays `summary` verbatim — the normal Skill path — has
nothing in the envelope telling it to hedge.

The drift is material rather than cosmetic. The summary placed Gabriel Barkay's
_BAR_ article on screen at "~05:35–06:09"; a frame extracted at `t=335` shows the
presenter on camera, and the article first appears at `t=350` (~5:50). The 5:05
Garden Tomb website shot, checked the same way, was accurate. A static warning on
`summarize_video` (as `search_timestamp` already adds) would make the hedge
unavoidable instead of dependent on the model volunteering it.

### Checked and cleared

- `extract_frames` warns about requested-vs-presented timestamps in both the
  envelope and stderr — the behaviour the summary operation lacks, and correct
  here.
- `Container: mov,mp4,m4a,3gp,3g2,mj2` is the documented shape
  ([README](../../README.md#L220)), not a raw ffprobe value leaking through.
- The installed Skill copy under `~/.agents/skills/video-analyzer` is
  byte-identical to [skills/video-analyzer](../../skills/video-analyzer) (5/5
  files). The launcher fell through to the PATH shim because `HERE/../../..` is
  not the checkout, and both reported `0.1.0`, so no version skew occurred — but
  note that a Skill installed outside the repo always runs the published binary,
  never `dist/cli.js`.
- `transcribe_video` reported `characters: 7404` for a written file of 7405 bytes
  (trailing newline), so the two counts are consistent rather than duplicated.
