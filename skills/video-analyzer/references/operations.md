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
- a platform URL supported by `yt-dlp` (YouTube, Vimeo, TikTok, Bilibili, …)

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

```bash
node ./scripts/invoke.mjs transcribe_video '{"videoPath":"./interview.mp4","outputPath":"./interview.txt"}'
```

Limitations, by design:

- no speaker diarization
- no word-level timings
- `.srt` / `.vtt` output paths are rejected rather than filled with invented cues

If nothing is spoken, `data.noSpeech` is `true` and the summary says so.

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

Use this first when you need duration or dimensions to plan frames or redaction regions.

---

## extract_frames

Write JPEG frames to disk. No AI, no API key.

| Field            | Type                                            | Required                  | Notes                              |
| ---------------- | ----------------------------------------------- | ------------------------- | ---------------------------------- |
| `videoPath`      | string                                          | yes                       | Must contain a video stream        |
| `mode`           | `even` \| `interval` \| `timestamps` \| `scene` | no                        | Default `even`                     |
| `count`          | integer 1–500                                   | no                        | `even` mode, default 5             |
| `intervalSec`    | number > 0                                      | required for `interval`   | Seconds between frames             |
| `timestamps`     | number[]                                        | required for `timestamps` | Seconds, max 100 entries           |
| `sceneThreshold` | number 0.05–0.95                                | no                        | `scene` mode, default 0.35         |
| `maxImages`      | integer 1–100                                   | no                        | Page size, default 20              |
| `offset`         | integer ≥ 0                                     | no                        | Skip frames for pagination         |
| `outputDir`      | string                                          | no                        | Defaults to an auto-created folder |

```bash
node ./scripts/invoke.mjs extract_frames '{"videoPath":"./demo.mp4","mode":"scene","sceneThreshold":0.4}'
node ./scripts/invoke.mjs extract_frames '{"videoPath":"./demo.mp4","mode":"interval","intervalSec":5,"maxImages":10,"offset":10}'
```

`images[]` lists every returned JPEG with an absolute `path` and a `t=` label
where a timestamp is known. `data.hasMore` indicates another page exists.

Frames are written into a folder under the working directory (or
`VIDEO_ANALYZER_OUTPUT_DIR`). They are not deleted.

---

## redact_sensitive

Blur, pixelate, or black out regions.

| Field                 | Type                               | Required                       | Notes                                                 |
| --------------------- | ---------------------------------- | ------------------------------ | ----------------------------------------------------- |
| `videoPath`           | string                             | yes                            | Must contain a video stream                           |
| `effect`              | `blur` \| `pixelate` \| `blackout` | no                             | Default `blur`                                        |
| `regions`             | object[]                           | unless `detectionMode` is `ai` | `{x, y, width, height, startTime?, endTime?, label?}` |
| `detectionMode`       | `manual` \| `ai`                   | no                             | Default `manual`                                      |
| `allowRemoteAnalysis` | boolean                            | required for `ai`              | Consent to upload sampled frames                      |
| `sampleCount`         | integer 1–24                       | no                             | Frames for AI detection, default 8                    |
| `previewOnly`         | boolean                            | no                             | Return outlined preview frames instead of a render    |
| `outputPath`          | string                             | no                             | Where to write the video; must not equal the source   |

Manual, with a preview first:

```bash
node ./scripts/invoke.mjs redact_sensitive '{"videoPath":"./rec.mp4","regions":[{"x":40,"y":320,"width":420,"height":32}],"previewOnly":true}'
```

Then render:

```bash
node ./scripts/invoke.mjs redact_sensitive '{"videoPath":"./rec.mp4","effect":"blackout","regions":[{"x":40,"y":320,"width":420,"height":32,"startTime":5,"endTime":20}],"outputPath":"./rec-redacted.mp4"}'
```

AI-assisted detection (ask the user first):

```bash
node ./scripts/invoke.mjs redact_sensitive '{"videoPath":"./rec.mp4","detectionMode":"ai","allowRemoteAnalysis":true,"previewOnly":true}'
```

Coordinates are pixels in the source video. Values outside the frame are
clamped; obviously invalid regions raise `INVALID_INPUT`. `startTime`/`endTime`
limit redaction to a window; omitting both redacts the whole video.

Rendered output is H.264/AAC MP4 with fast-start, or the container implied by
`outputPath`'s extension.
