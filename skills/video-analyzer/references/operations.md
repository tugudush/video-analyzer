# Operation Reference

Every operation is invoked as:

```bash
node ./scripts/invoke.mjs <operation> '<json>'
```

All operations accept the same top-level input mechanism: one JSON object. Use
`--json-file <path>` instead of an inline string when the shell mangles quotes or
backslashes. Add `--pretty` for readable JSON output.

`videoPath` accepts, for every operation:

- an absolute or relative local path
- a `file://` URI
- a direct `http(s)` media URL

Platform page downloads and yt-dlp fallback are disabled; use a local file or a direct media URL.

## Response Envelope

Success:

```json
{
  "operation": "get_video_info",
  "ok": true,
  "summary": "human-readable result",
  "data": { "structured": "payload" },
  "warnings": [],
  "images": [],
  "artifacts": []
}
```

Failure (also mirrored as text on stderr, with a nonzero exit code):

```json
{
  "ok": false,
  "error": { "code": "INPUT_NOT_FOUND", "message": "File not found: …", "hint": "…" }
}
```

---

## analyze_video

Answer a question about the video, using both picture and audio.

| Field       | Type   | Required | Notes                  |
| ----------- | ------ | -------- | ---------------------- |
| `videoPath` | string | yes      | Any supported input    |
| `question`  | string | yes      | The question to answer |

```bash
node ./scripts/invoke.mjs analyze_video '{"videoPath":"./demo.mp4","question":"What does the presenter claim about pricing?"}'
```

Returns `summary` containing the answer and `data.durationSeconds`.

Use for targeted questions. For a whole-video overview use `summarize_video`.

---

## summarize_video

Produce a structured summary: overview, key moments, dialogue/on-screen text, tone, and gaps.

| Field       | Type   | Required | Notes                                           |
| ----------- | ------ | -------- | ----------------------------------------------- |
| `videoPath` | string | yes      | Any supported input                             |
| `focus`     | string | no       | Aspect to emphasise, e.g. `"legal disclaimers"` |

```bash
node ./scripts/invoke.mjs summarize_video '{"videoPath":"./talk.mp4","focus":"performance numbers"}'
```

Timestamps inside the summary are approximate. Say so when relaying them.

---

## search_timestamp

Locate when an event occurs.

| Field       | Type   | Required | Notes                                |
| ----------- | ------ | -------- | ------------------------------------ |
| `videoPath` | string | yes      | Any supported input                  |
| `query`     | string | yes      | The event, phrase, or object to find |

```bash
node ./scripts/invoke.mjs search_timestamp '{"videoPath":"./demo.mp4","query":"the error dialog appears"}'
```

Returns `data.matches[]` with `startSeconds`, optional `endSeconds`, and a
`description`. When the model does not follow the `MATCH` format,
`data.raw` holds its prose answer and a warning is added.

Every result includes `data.durationSeconds`, and `data.raw` is always present for
a no-match or unparsed answer so the model's own wording is not lost. A match whose
start, or whose range end, is past the end of the clip cannot be real, so it is
reported with a warning rather than silently trusted. An end at or before its start
is not a range and is reported as a single timestamp.

Reads `NO_MATCH` as "not found". Always relay the estimate warning.
Verify a candidate time with `extract_frames` before cutting anything.

---

## transcribe_video

Plain-text speech-to-text.

| Field                | Type    | Required | Notes                                              |
| -------------------- | ------- | -------- | -------------------------------------------------- |
| `videoPath`          | string  | yes      | Audio or video file                                |
| `language`           | string  | no       | Hint such as `"Spanish"` or `"es-ES"`              |
| `translateToEnglish` | boolean | no       | Return English instead of the source language      |
| `outputPath`         | string  | no       | Also write a `.txt` file (parent dirs are created) |
| `overwrite`          | boolean | no       | Replace an existing `outputPath` (default `false`) |

```bash
node ./scripts/invoke.mjs transcribe_video '{"videoPath":"./interview.mp4","outputPath":"./interview.txt"}'
```

Limitations, by design:

- no speaker diarization
- no word-level timings
- `.srt` / `.vtt` output paths are rejected rather than filled with invented cues

`outputPath` is validated before the upload starts. It may never refer to the source
media, including through symlinks or hard links, and an existing file is only replaced
when `overwrite: true` is passed. It accepts a local path or a `file://` URI, and
missing parent directories are created. `overwrite` only applies when `outputPath` is
set, so re-running an example that writes to the same `.txt` needs `overwrite: true`.
An overwrite replaces the target directory entry using a staged file; it does not
follow a target symlink or change other hard links to the old file.

If nothing is spoken, `data.noSpeech` is `true` and the summary says so.
An empty or whitespace-only model response is an error, not evidence of silence.

The transcript is the result; `outputPath` is a convenience. If the write fails
(full disk, read-only volume, a directory in the way), the operation still returns
the text in `summary`, adds a warning naming the target and the OS error, and
reports `data.outputWritten: false` with no `artifacts` entry. When it succeeds,
`data.outputWritten` is `true` and `artifacts[]` names the file.

---

## get_video_info

Technical metadata via `ffprobe`. No AI, no API key.

| Field       | Type   | Required |
| ----------- | ------ | -------- |
| `videoPath` | string | yes      |

```bash
node ./scripts/invoke.mjs get_video_info '{"videoPath":"./demo.mp4"}'
```

`data` contains `durationSeconds`, `container`, `sizeBytes`, `bitRate`,
`hasVideo`, `hasAudio`, `video{codec,width,height,fps,pixelFormat}` and
`audio{codec,sampleRate,channels}`.

Use this first when you need duration or dimensions to plan frames.
For media with multiple video streams, the metadata and every frame extraction
mode use the first video stream, even if a different stream is marked default.

---

## extract_frames

Write JPEG frames to disk. No AI, no API key.

| Field            | Type                                            | Required                  | Notes                                              |
| ---------------- | ----------------------------------------------- | ------------------------- | -------------------------------------------------- |
| `videoPath`      | string                                          | for new extractions       | Must contain a video stream                        |
| `frameSetDir`    | string                                          | for a saved page          | `data.outputDir` from an earlier extraction        |
| `mode`           | `even` \| `interval` \| `timestamps` \| `scene` | no                        | Default `even`                                     |
| `count`          | integer 1–500                                   | no                        | `even` mode, default 5                             |
| `intervalSec`    | number ≥ 0.1                                    | required for `interval`   | Seconds between frames                             |
| `timestamps`     | number[]                                        | required for `timestamps` | Seconds, max 100 entries                           |
| `sceneThreshold` | number 0.05–0.95                                | no                        | `scene` mode, default 0.35                         |
| `maxImages`      | integer 1–100                                   | no                        | Page size, default 20                              |
| `offset`         | integer ≥ 0                                     | no                        | Skip frames for pagination                         |
| `outputDir`      | string                                          | no                        | Parent folder; each request writes a new subfolder |

```bash
node ./scripts/invoke.mjs extract_frames '{"videoPath":"./demo.mp4","mode":"scene","sceneThreshold":0.4}'
node ./scripts/invoke.mjs extract_frames '{"videoPath":"./demo.mp4","mode":"interval","intervalSec":5,"maxImages":10}'
# Use the first response's data.outputDir for the next page:
node ./scripts/invoke.mjs extract_frames '{"frameSetDir":"./frames/frames-...","maxImages":10,"offset":10}'
```

`images[]` lists every returned JPEG with an absolute `path` and a timestamp
label where one is known. `data.hasMore` indicates another page exists.
Paging with `frameSetDir` reads the saved frame set without accessing the source
or rerunning ffmpeg. Supply only `frameSetDir`, `offset`, and `maxImages` for
saved pages. Passing `videoPath` and an `offset` without `frameSetDir` remains a
new extraction, with the corresponding download, processing and disk costs.
Frames retain their aspect ratio, with a 1280-pixel longest-edge limit and no
upscaling.

Over MCP the frames are returned as inline image content, capped at 2 MiB of
base64 per result. Each inline image is preceded by its path and label. Frames
that do not fit, including the first, are listed by path instead; the CLI
envelope always carries paths only. Lower `maxImages` when every frame has to
be inline, except that an individually oversized frame cannot be inlined.

`interval` mode stops at the frame budget (`VIDEO_ANALYZER_MAX_FRAMES`, default
100, hard ceiling 500) while ffmpeg is writing, starting from `t=0`. When the
interval would produce more frames than that, only the first `budget` frames are
written, the response adds a warning and `data.truncated: true`, and the pages
describe that shorter list. `maxImages` limits the returned page, never how many
frames are produced.

Each `t=` label in `interval` mode is an approximate sampling-grid time, not
the presentation time of the source frame selected by ffmpeg. Every page includes
a warning about this distinction. A clip shorter than the interval returns one
frame.

`timestamps` mode validates the whole array against the media duration before the
first ffmpeg call. A value at or beyond the end of the clip is rejected as
`INVALID_INPUT` with the offending value and the duration in the message, instead
of failing the run and stranding the frames the valid values produced. For each
valid time, extraction selects the first frame at or after it, or the final frame
if the seek reaches the end. The labels and `data.timestamps` describe requested
times, not the selected frames' presentation times; every page warns about this.
The end-of-clip fallback may require decoding from the beginning. If an
extraction fails for any other reason, the artifact folder created for the
request is removed on a best-effort basis, so a reported `outputDir` contains a
complete set.

An `offset` at or past `data.totalFrames` returns no images, `hasMore: false`, and
a summary saying the page is past the frames this request produced. An `outputDir`
(or `VIDEO_ANALYZER_OUTPUT_DIR`) that cannot be created is `OUTPUT_FAILED` naming
the setting, not an internal error.

`interval` mode also reports `data.expectedFrames` (an estimate based on media
duration and interval) and `data.frameBudget` (the budget that was applied), so a
caller can decide whether to re-run without parsing the warning.
`data.truncated` is `true` whenever the written frames do not cover the whole
estimated sampling grid, whether due to the budget or a shorter output from
ffmpeg. In `scene` mode it means the list hit the scene ceiling (200 frames, or
the configured budget when smaller).

Ceilings per extraction: `even` and `interval` stop at 500 frames, `scene` at
200, and `timestamps` at 100 entries. No input raises these.

Frames and a paging manifest are written into a folder under the working directory
(or `VIDEO_ANALYZER_OUTPUT_DIR`). They persist until you delete that folder.
For a new extraction, `data.outputDir` is a newly created subfolder: supplying
`outputDir` names its parent. The manifest and JPEGs must remain intact for
`frameSetDir` pagination. Missing or invalid saved data is reported as an error;
previous frame sets are not overwritten by later extractions.
