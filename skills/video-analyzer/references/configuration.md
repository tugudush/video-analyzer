# Configuration

Set these in the environment where the CLI runs. The Skill inherits the ambient
environment, so exporting them in the shell (or in the MCP client config, for the
MCP interface) is enough.

## How the key reaches the CLI

```text
agent shell  ──> node scripts/invoke.mjs  ──spawn──> video-analyzer CLI  ──> process.env
```

`invoke.mjs` spawns the CLI without an `env` override, so the CLI sees exactly the
environment your agent had. Three ways to supply `GEMINI_API_KEY`, in precedence
order:

1. **Real environment variable** — highest priority.

   Windows: set a **user** variable, either in _System Properties → Environment Variables → User variables → New_, or from PowerShell:

   ```powershell
   [Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'your-key', 'User')
   ```

   Restart VS Code afterwards. Windows writes the registry entry immediately, but a process only
   receives an environment snapshot at startup, and the integrated terminal inherits VS Code's
   environment rather than the registry — so restarting the terminal alone changes nothing.
   Type the value without surrounding quotes and without a trailing space; both yield an invalid key.

   macOS / Linux:

   ```bash
   echo 'export GEMINI_API_KEY="your-key"' >> ~/.zshrc   # or ~/.bashrc
   ```

   Or launch the agent from a shell that already exported it.

2. **`.env` in the working directory** — read once at startup. Only fills
   variables that are unset or blank, so it can never override a real export.
   Lines may use `export KEY=value`, quotes, and `#` comments. Malformed lines are
   skipped silently, and escape sequences are not interpreted.

   ```bash
   cp .env.example .env    # then set GEMINI_API_KEY
   ```

3. **MCP config `env` block** — applies to the MCP server only. The Skill path
   never reads it, because the Skill runs the CLI directly.

Verify without revealing the value:

```bash
node ./scripts/invoke.mjs list    # works regardless of the key
```

Then run any AI operation; `CONFIG_MISSING` in the response means the key is not
reaching the CLI.

## Required for AI operations

| Variable         | Purpose                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY` | Gemini API key. Required by `analyze_video`, `summarize_video`, `search_timestamp`, and `transcribe_video`. |

Get a key from <https://aistudio.google.com/app/apikey>.

Local operations (`get_video_info`, `extract_frames`)
work without it.

## Model

| Variable       | Default            | Purpose                                                       |
| -------------- | ------------------ | ------------------------------------------------------------- |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model ID for all AI calls. Must handle video and audio input. |

If the configured model is unavailable for your account, the API error is surfaced
verbatim. No silent model substitution happens.

## Limits

| Variable                            | Default  | Purpose                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VIDEO_ANALYZER_MAX_FRAMES`         | `100`    | Frame budget for `extract_frames`: `interval` mode stops at it and scene mode uses it as a lower ceiling. AI operations always send the whole media file to Gemini, so this does not change their behaviour. `0` removes the configured ceiling, but a 500-frame hard ceiling per extraction still applies, and scene mode is capped at 200 regardless. |
| `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`    | `2048`   | Maximum size of a remote download.                                                                                                                                                                                                                                                                                                                      |
| `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS` | `300000` | Deadline for a single Gemini call: the upload request, each file-status poll, or a generation request. An upload or poll is also bounded by what is left of `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`, and the shorter of the two applies. A stalled call fails with `GEMINI_TIMEOUT`, and the hint names the setting that applied.                            |
| `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`  | `600000` | Total budget for uploading the media and waiting for it to become `ACTIVE`. The clock starts before the upload, so a slow upload leaves less time for processing.                                                                                                                                                                                       |
| `VIDEO_ANALYZER_POLL_INTERVAL_MS`   | `2000`   | Upload status poll interval.                                                                                                                                                                                                                                                                                                                            |

## Output

| Variable                    | Default           | Purpose                                                                         |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `VIDEO_ANALYZER_OUTPUT_DIR` | current directory | Base directory for `video-analyzer-output/` folders that hold extracted frames. |

## Binaries

| Variable       | Default   | Purpose             |
| -------------- | --------- | ------------------- |
| `FFMPEG_PATH`  | `ffmpeg`  | ffmpeg executable.  |
| `FFPROBE_PATH` | `ffprobe` | ffprobe executable. |

The legacy `YT_DLP_PATH`, `YT_DLP_MAX_RESOLUTION`, `YT_DLP_COOKIES_FILE`, and `YT_DLP_IMPERSONATE` settings have no effect while platform downloads are disabled.

## Network

| Variable                             | Default | Purpose                                                                                         |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` | `false` | Allow loopback, private, link-local, and metadata addresses. Only enable for media you control. |

## Diagnostics

| Variable                   | Default       | Purpose                                                                                  |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `VIDEO_ANALYZER_LOG_LEVEL` | `warn`        | `silent`, `error`, `warn`, `info`, or `debug`. `info`/`debug` stream progress to stderr. |
| `VIDEO_ANALYZER_CLI_PATH`  | auto-detected | Explicit path to `dist/cli.js` for the Skill launcher.                                   |

## Example

```bash
export GEMINI_API_KEY="…"
export VIDEO_ANALYZER_OUTPUT_DIR="$HOME/video-output"
node ./scripts/invoke.mjs list
```
