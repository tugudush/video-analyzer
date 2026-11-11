# Video Analyzer

Gemini-powered video and audio analysis you can use **either as an MCP server or as an agent Skill**.

Ask questions about a recording, summarise it, find when something happens, transcribe speech, read technical metadata, and pull frames — from one shared core, exposed through two independent interfaces.

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

Inputs can be local paths, `file://` URIs, or direct `http(s)` media URLs. Platform page downloads and yt-dlp fallback are disabled because their network destinations cannot be validated; use a local file or direct media URL instead.

Deliberately **not** included: text-to-speech, image/video/music generation, multi-provider routing, and licensing or paid tiers.

## Requirements

- Node.js 22 or newer
- FFmpeg (includes `ffprobe`) on `PATH`, or `FFMPEG_PATH` / `FFPROBE_PATH`
- `GEMINI_API_KEY` — only for AI operations ([get a key](https://aistudio.google.com/app/apikey))

## Install

```bash
git clone <repo-url>
cd video-analyzer
npm install
npm run build
npm install -g .  # optional: puts `video-analyzer` and `video-analyzer-mcp` on PATH
```

Without a global install, use `node /path/to/video-analyzer/dist/cli.js` wherever this document shows `video-analyzer`.

What you actually need depends on how you use the package:

| Setup                                                                            | `npm install` | `npm run build` | Global  |
| -------------------------------------------------------------------------------- | ------------- | --------------- | ------- |
| MCP server                                                                       | yes           | yes             | no      |
| Skill kept in this repo (`skills/video-analyzer`)                                | yes           | yes             | no      |
| Skill copied to a user-level folder (`~/.copilot/skills`, `~/.claude/skills`, …) | yes           | yes             | **yes** |
| Skill copied to a user-level folder, with `VIDEO_ANALYZER_CLI_PATH` set          | yes           | yes             | no      |

`npm run build` is never skippable: `dist/cli.js` and `dist/mcp.js` are compiler output and are not checked in.

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

   # Agent-agnostic — personal (read by Copilot, Cursor, Codex, and OpenCode; not by Claude Code or Antigravity)
   mkdir -p ~/.agents/skills
   cp -r skills/video-analyzer ~/.agents/skills/
   ```

   `.agents/skills/` (project) is read by Copilot, Cursor, Codex, OpenCode, and Antigravity. `~/.agents/skills/` (personal) is read by Copilot, Cursor, Codex, and OpenCode, but not by Claude Code or Antigravity.

   **User-level (global) installs need one extra command.** A Skill copied into `~/.copilot/skills` or `~/.claude/skills` no longer sits next to `dist/cli.js`, so the launcher falls back to a `video-analyzer` command on `PATH`. Build the CLI, then expose it:

   ```bash
   # Run inside the repo clone
   npm install
   npm run build
   npm install -g .    # or: npm link
   ```

   The global command points back at the checkout, so keep the clone (at least `dist/` and `node_modules/`) in place — deleting it breaks the global `video-analyzer` binary. To remove it, run `npm uninstall -g video-analyzer` (or `npm unlink -g video-analyzer` after `npm link`).

   If you would rather not install a global command, set `VIDEO_ANALYZER_CLI_PATH` in step 3 instead. That still requires `npm install` and `npm run build`, because `dist/cli.js` loads its dependencies from the checkout's `node_modules/`.

   > A Skill left at `skills/video-analyzer` inside this repo needs neither of the above: the launcher finds the build by relative path.

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

3. Point the launcher at your build if the CLI is neither in this repo nor on `PATH`:

   ```bash
   export VIDEO_ANALYZER_CLI_PATH=/absolute/path/to/video-analyzer/dist/cli.js
   ```

   On Windows set it as a user variable and restart VS Code, so the agent process inherits it:

   ```powershell
   [Environment]::SetEnvironmentVariable('VIDEO_ANALYZER_CLI_PATH', 'C:\dev\video-analyzer\dist\cli.js', 'User')
   ```

4. Invoke it:
   - **VS Code / Copilot** — run `/video-analyzer`, or just ask about a video; the Skill description covers analysis, summarization, transcription, timestamp search, metadata, and frames.
   - **Claude Code** — ask the same way; the Skill is discovered from `.claude/skills/` or `~/.claude/skills/` and Claude invokes its bundled `scripts/invoke.mjs`.

Check it works:

```bash
# Skill kept in this repo
node skills/video-analyzer/scripts/invoke.mjs list

# User-level Skill (VS Code / Copilot); use ~/.claude/skills/... for Claude Code
node ~/.copilot/skills/video-analyzer/scripts/invoke.mjs list
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
```

Full argument reference: [`skills/video-analyzer/references/operations.md`](skills/video-analyzer/references/operations.md).

## Configuration

| Variable                             | Default              | Purpose                                                                                               |
| ------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`                     | —                    | Required for AI operations                                                                            |
| `GEMINI_MODEL`                       | `gemini-3.8-flash`   | Model for all AI calls                                                                                |
| `VIDEO_ANALYZER_MAX_FRAMES`          | `100`                | Frame budget for sampling and extraction (scene capped at 200); `0` keeps only the 500-frame hard cap |
| `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`     | `2048`               | Remote download size limit                                                                            |
| `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS`  | `300000`             | Deadline for each Gemini call: upload request, status poll, or generation                             |
| `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`   | `600000`             | Budget for uploading the media and waiting for `ACTIVE`; the clock starts before the upload           |
| `VIDEO_ANALYZER_POLL_INTERVAL_MS`    | `2000`               | Upload status poll interval                                                                           |
| `VIDEO_ANALYZER_OUTPUT_DIR`          | cwd                  | Base directory for generated artifacts                                                                |
| `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` | `false`              | Allow private/loopback media hosts                                                                    |
| `VIDEO_ANALYZER_LOG_LEVEL`           | `warn`               | `silent`/`error`/`warn`/`info`/`debug`                                                                |
| `VIDEO_ANALYZER_CLI_PATH`            | auto                 | CLI path used by the Skill launcher                                                                   |
| `FFMPEG_PATH` / `FFPROBE_PATH`       | `ffmpeg` / `ffprobe` | Binaries                                                                                              |

The legacy `YT_DLP_PATH`, `YT_DLP_MAX_RESOLUTION`, `YT_DLP_COOKIES_FILE`, and `YT_DLP_IMPERSONATE` settings have no effect while platform downloads are disabled.

Details: [`skills/video-analyzer/references/configuration.md`](skills/video-analyzer/references/configuration.md).

## Errors

Every failure uses a stable code: `INVALID_INPUT`, `CONFIG_MISSING`, `DEPENDENCY_MISSING`, `INPUT_NOT_FOUND`, `UNSUPPORTED_INPUT`, `URL_REJECTED`, `DOWNLOAD_FAILED`, `MEDIA_PROCESSING_FAILED`, `GEMINI_UPLOAD_FAILED`, `GEMINI_PROCESSING_FAILED`, `GEMINI_REQUEST_FAILED`, `GEMINI_TIMEOUT`, `OUTPUT_FAILED`, `INTERNAL`.

Recovery guidance: [`skills/video-analyzer/references/troubleshooting.md`](skills/video-analyzer/references/troubleshooting.md).

## Known Limitations

- **Single provider.** If Gemini is down or out of quota, AI operations fail with a clear error. There is no fallback provider by design.
- **Timestamps are estimates.** `search_timestamp` reflects Gemini's internal sampling. Confirm with `extract_frames` before cutting.
- **Transcription is plain text.** No speaker diarization and no per-cue timings; `.srt`/`.vtt` targets are rejected rather than fabricated.
- **Sensitive media leaves the machine** for AI operations.
- **SSRF protection is best-effort.** Hostnames are resolved and every redirect hop is revalidated, but the resolve→connect window is not pinned, so DNS rebinding is theoretically possible. Private hosts are blocked unless explicitly opted in.
- **External platform downloads are disabled.** The private-host opt-in applies only to direct HTTP downloads and does not enable yt-dlp; URLs with embedded credentials remain blocked.
- **Frame extraction writes to disk.** Returned image paths persist until you delete them.

## Architecture

```text
MCP client ──> MCP adapter ─┐
                            ├──> operation registry ──> services ──> Gemini / FFmpeg
Agent Skill ──> CLI adapter ─┘
```

The registry (`src/operations/registry.ts`) is the single source of truth for names, schemas, and handlers. Capability parity between the two interfaces is structural, and enforced by `tests/contract/parity.test.ts`.

See [`findings-and-plan.md`](findings-and-plan.md) for the original design rationale.

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
