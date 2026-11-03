# Video Analyzer

Gemini-powered video and audio analysis you can use **either as an MCP server or as an agent Skill**.

Ask questions about a recording, summarise it, find when something happens, transcribe speech, read technical metadata, pull frames, and redact secrets on screen — from one shared core, exposed through two independent interfaces.

- **MCP interface** — tools discovered by MCP clients.
- **Skill interface** — an on-demand `SKILL.md` workflow that calls the local CLI. **No MCP server required.**

Neither interface depends on the other. Install one, or both.

## What It Does

| Operation          | Purpose                                                   | Needs Gemini |
| ------------------ | --------------------------------------------------------- | ------------ |
| `analyze_video`    | Answer a question about the video and its audio           | yes          |
| `summarize_video`  | Structured summary: overview, key moments, tone, gaps     | yes          |
| `search_timestamp` | Find when an event occurs (estimates, not frame-accurate) | yes          |
| `transcribe_video` | Plain-text speech-to-text                                 | yes          |
| `get_video_info`   | Duration, resolution, frame rate, codecs, size            | no           |
| `extract_frames`   | Frames by count, interval, timestamps, or scene changes   | no           |
| `redact_sensitive` | Blur / pixelate / blackout regions                        | optional     |

Inputs can be local paths, `file://` URIs, direct `http(s)` media URLs, or platform URLs supported by `yt-dlp`.

Deliberately **not** included: text-to-speech, image/video/music generation, multi-provider routing, and licensing or paid tiers.

## Requirements

- Node.js 22 or newer
- FFmpeg (includes `ffprobe`) on `PATH`, or `FFMPEG_PATH` / `FFPROBE_PATH`
- `yt-dlp` — only for platform URLs such as YouTube
- `GEMINI_API_KEY` — only for AI operations ([get a key](https://aistudio.google.com/app/apikey))

## Install

```bash
git clone <repo-url>
cd video-analyzer
npm install
npm run build
npm link        # optional: puts `video-analyzer` and `video-analyzer-mcp` on PATH
```

Without `npm link`, use `node /path/to/video-analyzer/dist/cli.js` wherever this document shows `video-analyzer`.

## Use as MCP

Add a server entry to your MCP client. VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "videoAnalyzer": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/video-analyzer/dist/mcp.js"],
      "env": {
        "GEMINI_API_KEY": "your-key"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add \
  --env GEMINI_API_KEY=your-key \
  videoAnalyzer -- node /absolute/path/to/video-analyzer/dist/mcp.js
```

Or project-scoped, by committing a `.mcp.json` at the repo root (Claude Code picks it up automatically):

```json
{
  "mcpServers": {
    "videoAnalyzer": {
      "command": "node",
      "args": ["/absolute/path/to/video-analyzer/dist/mcp.js"],
      "env": { "GEMINI_API_KEY": "your-key" }
    }
  }
}
```

Restart the client, then ask for something like _"Summarize ./demo.mp4"_.

> Keep configuration files with API keys out of source control.

## Use as a Skill

The Skill lives in [`skills/video-analyzer`](skills/video-analyzer) and runs the CLI directly — it does **not** talk to the MCP server.

1. Copy the folder into a Skill location. The same folder works for VS Code / Copilot and for Claude Code:

   ```bash
   # VS Code / Copilot — project-scoped (committed with the repo)
   mkdir -p .github/skills
   cp -r skills/video-analyzer .github/skills/

   # VS Code / Copilot — personal, across all workspaces
   mkdir -p ~/.copilot/skills
   cp -r skills/video-analyzer ~/.copilot/skills/

   # Claude Code — project-scoped
   mkdir -p .claude/skills
   cp -r skills/video-analyzer .claude/skills/

   # Claude Code — personal
   mkdir -p ~/.claude/skills
   cp -r skills/video-analyzer ~/.claude/skills/
   ```

   Agent-agnostic locations also work: `.agents/skills/` (project) and `~/.agents/skills/` (personal).

   > A copied Skill sits outside this repo, so the launcher cannot find `dist/cli.js` by relative path — it falls back to a global `video-analyzer` binary. Either install the CLI (`npm link` or `npm i -g .`) or set `VIDEO_ANALYZER_CLI_PATH` in step 3.

2. Provide `GEMINI_API_KEY` to the process that runs the agent. The launcher inherits its parent environment, so set it wherever your agent runs commands.

   **Windows** — either the Environment Variables dialog (_Win+R_ → `sysdm.cpl` → Advanced → Environment Variables → **User variables** → New, name `GEMINI_API_KEY`), or PowerShell writing that same user variable:

   ```powershell
   [Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'your-key', 'User')
   ```

   **macOS / Linux:**

   ```bash
   echo 'export GEMINI_API_KEY="your-key"' >> ~/.zshrc   # or ~/.bashrc
   ```

   **Any OS — `.env`** in the directory the agent runs from. The CLI reads it at startup, and real environment variables always take precedence:

   ```bash
   cp .env.example .env    # then set GEMINI_API_KEY
   ```

   > **After setting a Windows environment variable, restart VS Code.** Windows stores it immediately, but a process only receives an environment snapshot when it starts. Restarting just the terminal is not enough — the integrated terminal inherits VS Code's environment, not the registry.
   >
   > Enter the value without surrounding quotes and check for a trailing space; either makes the key invalid.
   >
   > The `env` block in an MCP config applies **only** to the MCP server. The Skill path never reads it — it inherits the process environment instead. If you use both interfaces, set the key in the OS environment (or `.env`) so both see it.

3. Point the launcher at your build if the CLI is not on `PATH`:

   ```bash
   export VIDEO_ANALYZER_CLI_PATH=/absolute/path/to/video-analyzer/dist/cli.js
   ```

4. Invoke it:
   - **VS Code / Copilot** — run `/video-analyzer`, or just ask about a video; the Skill description covers analysis, summarization, transcription, timestamp search, metadata, frames, and redaction.
   - **Claude Code** — ask the same way; the Skill is discovered from `.claude/skills/` or `~/.claude/skills/` and Claude invokes its bundled `scripts/invoke.mjs`.

Check it works:

```bash
node skills/video-analyzer/scripts/invoke.mjs list
```

## Use the CLI Directly

```bash
video-analyzer list
video-analyzer help extract_frames
video-analyzer get_video_info --input '{"videoPath":"./demo.mp4"}' --pretty
video-analyzer get_video_info --input-file args.json
cat args.json | video-analyzer get_video_info
```

Every call prints one JSON envelope on stdout and writes diagnostics to stderr:

```json
{
  "operation": "get_video_info",
  "ok": true,
  "summary": "Container: mov,mp4,...\nDuration: 00:00:06.000\n...",
  "data": { "durationSeconds": 6, "hasVideo": true, "hasAudio": true },
  "warnings": [],
  "images": [],
  "artifacts": []
}
```

On failure the exit code is non-zero and stdout carries:

```json
{ "ok": false, "error": { "code": "INPUT_NOT_FOUND", "message": "…", "hint": "…" } }
```

### Examples

```bash
# Question about content
video-analyzer analyze_video --input '{"videoPath":"./demo.mp4","question":"What pricing is shown?"}'

# Summary with a focus
video-analyzer summarize_video --input '{"videoPath":"./talk.mp4","focus":"security claims"}'

# When does something happen?
video-analyzer search_timestamp --input '{"videoPath":"./demo.mp4","query":"the error dialog appears"}'

# Transcript to a file
video-analyzer transcribe_video --input '{"videoPath":"./interview.m4a","outputPath":"./interview.txt"}'

# Frames at specific times
video-analyzer extract_frames --input '{"videoPath":"./demo.mp4","mode":"timestamps","timestamps":[3,12.5,30],"outputDir":"./frames"}'

# Preview a redaction, then render it
video-analyzer redact_sensitive --input '{"videoPath":"./rec.mp4","regions":[{"x":40,"y":320,"width":420,"height":32}],"previewOnly":true}'
video-analyzer redact_sensitive --input '{"videoPath":"./rec.mp4","effect":"blackout","regions":[{"x":40,"y":320,"width":420,"height":32}],"outputPath":"./rec-redacted.mp4"}'
```

Full argument reference: [`skills/video-analyzer/references/operations.md`](skills/video-analyzer/references/operations.md).

## Configuration

| Variable                             | Default              | Purpose                                   |
| ------------------------------------ | -------------------- | ----------------------------------------- |
| `GEMINI_API_KEY`                     | —                    | Required for AI operations                |
| `GEMINI_MODEL`                       | `gemini-3.8-flash`   | Model for all AI calls                    |
| `VIDEO_ANALYZER_MAX_FRAMES`          | `100`                | AI frame ceiling; `0` removes the ceiling |
| `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`     | `2048`               | Remote download size limit                |
| `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS`  | `300000`             | Gemini request timeout                    |
| `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`   | `600000`             | Upload → `ACTIVE` timeout                 |
| `VIDEO_ANALYZER_POLL_INTERVAL_MS`    | `2000`               | Upload status poll interval               |
| `VIDEO_ANALYZER_OUTPUT_DIR`          | cwd                  | Base directory for generated artifacts    |
| `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` | `false`              | Allow private/loopback media hosts        |
| `VIDEO_ANALYZER_LOG_LEVEL`           | `warn`               | `silent`/`error`/`warn`/`info`/`debug`    |
| `VIDEO_ANALYZER_CLI_PATH`            | auto                 | CLI path used by the Skill launcher       |
| `FFMPEG_PATH` / `FFPROBE_PATH`       | `ffmpeg` / `ffprobe` | Binaries                                  |
| `YT_DLP_PATH`                        | `yt-dlp`             | Platform downloader                       |
| `YT_DLP_MAX_RESOLUTION`              | —                    | Preferred max height                      |
| `YT_DLP_COOKIES_FILE`                | —                    | Cookies for private sources               |
| `YT_DLP_IMPERSONATE`                 | —                    | Browser to impersonate                    |

Details: [`skills/video-analyzer/references/configuration.md`](skills/video-analyzer/references/configuration.md).

## Errors

Every failure uses a stable code: `INVALID_INPUT`, `CONFIG_MISSING`, `DEPENDENCY_MISSING`, `INPUT_NOT_FOUND`, `UNSUPPORTED_INPUT`, `URL_REJECTED`, `DOWNLOAD_FAILED`, `MEDIA_PROCESSING_FAILED`, `GEMINI_UPLOAD_FAILED`, `GEMINI_PROCESSING_FAILED`, `GEMINI_REQUEST_FAILED`, `GEMINI_TIMEOUT`, `CONSENT_REQUIRED`, `OUTPUT_FAILED`, `INTERNAL`.

Recovery guidance: [`skills/video-analyzer/references/troubleshooting.md`](skills/video-analyzer/references/troubleshooting.md).

## Known Limitations

- **Single provider.** If Gemini is down or out of quota, AI operations fail with a clear error. There is no fallback provider by design.
- **Timestamps are estimates.** `search_timestamp` reflects Gemini's internal sampling. Confirm with `extract_frames` before cutting.
- **Transcription is plain text.** No speaker diarization and no per-cue timings; `.srt`/`.vtt` targets are rejected rather than fabricated.
- **Sensitive media leaves the machine** for AI operations. AI-assisted redaction additionally requires an explicit `allowRemoteAnalysis: true`.
- **SSRF protection is best-effort.** Hostnames are resolved and every redirect hop is revalidated, but the resolve→connect window is not pinned, so DNS rebinding is theoretically possible. Private hosts are blocked unless explicitly opted in.
- **Frame extraction writes to disk.** Returned image paths persist until you delete them.

## Architecture

```text
MCP client ──> MCP adapter ─┐
                            ├──> operation registry ──> services ──> Gemini / FFmpeg / yt-dlp
Agent Skill ──> CLI adapter ─┘
```

The registry (`src/operations/registry.ts`) is the single source of truth for names, schemas, and handlers. Capability parity between the two interfaces is structural, and enforced by `tests/contract/parity.test.ts`.

See [`findings-and-plan.md`](findings-and-plan.md) for the design rationale and [`progress.md`](progress.md) for implementation status.

## Development

```bash
npm run typecheck    # tsc --strict, includes tests
npm run lint         # oxlint (src, tests, skills)
npm run lint:fix     # oxlint --fix
npm test             # vitest (unit, contract, integration, skill)
npm run format       # prettier
npm run check        # typecheck + lint + tests + format check
```

Integration tests generate their own media fixtures with ffmpeg and **skip silently** when ffmpeg is unavailable, so a green run without ffmpeg means 15 tests did not execute. Check the skip count if that matters.

### Why oxlint instead of ESLint

`typescript-eslint@8` refuses to load on TypeScript 7 (`does not support TS 7.0`) and declares `typescript: ">=4.8.4 <6.1.0"`, so ESLint cannot parse this repo's TypeScript. oxlint parses TypeScript itself with no dependency on the compiler API and runs as a single binary.

The trade-off is real: **oxlint has no type-aware rules**, so things like `no-floating-promises` and `no-misused-promises` are not checked. `tsc --strict` covers nullability and exhaustiveness but not unawaited promises. Expect to migrate to ESLint + `typescript-eslint` once TS 7 support lands; `.oxlintrc.json` maps over almost one-to-one.

`no-console` is an error on purpose: stdout must stay machine-readable for the CLI envelope and the MCP stdio transport, so diagnostics go to stderr.

## Licence

MIT
