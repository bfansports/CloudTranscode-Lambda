# CloudTranscode-Lambda

## What This Is

CloudTranscode-Lambda is a Node.js AWS Lambda function that generates video thumbnails on S3 upload events. It's a lightweight, event-driven alternative to the CloudTranscode ECS workers for simple thumbnail generation. The function downloads a video from S3, uses FFmpeg to extract a thumbnail at 1 second, and uploads the PNG back to S3.

**Status**: Legacy/deprecated. The README warns: "This code works and create thumbnails using lambda. However for some reason sometime it fails on AWS but not locally. Some videos work though. Use Cloud Transcode !" The root cause is likely the `Range: bytes=0-1000000` header in `downloadStream()` that truncates large videos to ~1 MB. Consider this a proof-of-concept, not production-grade. The Node.js 0.10.33 runtime is EOL and cannot be deployed to current AWS Lambda.

## Tech Stack

- **Language**: Node.js 0.10.33 (EOL — AWS Lambda no longer supports this runtime)
- **AWS Services**: Lambda, S3
- **FFmpeg**: Bundled 64-bit Linux static build from John Van Sickle's builds
- **Dependencies**:
  - `fluent-ffmpeg` ~2.0 — FFmpeg wrapper (builds CLI commands, does NOT use shell execution)
  - `async` ^0.9.0 — async control flow (replaceable with native Promises)
  - `aws-sdk` ^2.1.24 — S3 operations (v2, maintenance-mode; current is v3)
  - `uuid` ^2.0.1 — imported but **never used** in code
- **Build tool**: Gulp 3 (downloads FFmpeg, packages dist.zip)

## Quick Start

```bash
# Setup (use Node 0.10.33 via nvm to match Lambda runtime)
nvm use 0.10.33
npm install

# Build deployment package
gulp  # Downloads FFmpeg, packages dist.zip

# Deploy (manual — no CI/CD pipeline exists)
# 1. Upload dist.zip to AWS Lambda console
# 2. Configure S3 event trigger on source bucket
# 3. Set IAM execution role with S3 read/write permissions

# Test locally
node sample.js  # Edit bucket/key in sample.js first
```

## Project Structure

- `index.js` — Lambda handler function (downloads video, generates thumbnail, uploads)
- `config.json` — Configuration (mostly unused — see Gotchas)
- `gulpfile.js` — Build tasks (download FFmpeg, package dist.zip)
- `sample.js` — Local test harness (simulates S3 event)
- `doc/` — Documentation images
- `dist/` — Build output (created by Gulp, gitignored)
- `build/` — Intermediate build files (FFmpeg tarball, gitignored)

## Lambda Functions

### `exports.handler(event, context)` — Main Entry Point

**Trigger:** S3 `ObjectCreated` event  
**Input:** S3 event JSON with `Records[0].s3.bucket.name` and `Records[0].s3.object.key`  
**Output:** PNG thumbnail uploaded to same bucket at `<prefix>/<hash>.png`  

**Processing pipeline (async.series):**
1. `downloadStream()` — Downloads video from S3 to `/tmp/<filename>`
   - WARNING: Uses `Range: bytes=0-1000000` — only fetches first ~1 MB
   - The `createReadStream()` may or may not respect this Range depending on SDK version
2. `createThumb()` — Runs FFmpeg via `fluent-ffmpeg` to extract frame at timestamp 1s
   - Output: `/tmp/<hash>.png` at `?x159` height (width auto-scaled)
3. `uploadFile()` — Uploads thumbnail to same S3 bucket with `image/png` content type and 1-year cache header

**Error path:** `context.fail(err)` on any step failure; `context.succeed()` on completion.

### Helper Functions

| Function | Purpose | Notes |
|----------|---------|-------|
| `downloadStream(bucket, file, cb)` | S3 getObject as stream | Has Range header bug (H-4 in FINDINGS.md) |
| `s3upload(params, filename, cb)` | Upload with progress logging | `fs.unlinkSync` is commented out — temp files leak |
| `uploadFile(src, bucket, key, contentType, cb)` | Wraps s3upload with readStream | Sets CacheControl: 1 year |
| `verifyAsset(file, cb)` | FFprobe metadata check | **Commented out** in handler — not called |
| `createThumb(file, cb)` | FFmpeg screenshot extraction | Hardcoded: 1s timestamp, ?x159 size |

## FFmpeg Integration

**How FFmpeg is bundled:**
1. `gulp download-ffmpeg` — Downloads static build over **HTTP** (not HTTPS) from `johnvansickle.com`
2. `gulp untar-ffmpeg` — Extracts tarball with `tar -xvf`
3. `gulp copy-ffmpeg` — Copies `ffmpeg` and `ffprobe` binaries to `dist/`
4. Both binaries ship inside `dist.zip` alongside `index.js` and `node_modules/`

**How FFmpeg is invoked:**
- `fluent-ffmpeg` builds CLI arguments and spawns FFmpeg as a child process
- PATH is extended at runtime: `process.env['PATH'] += ':' + process.env['LAMBDA_TASK_ROOT']`
- This allows `fluent-ffmpeg` to find the bundled `ffmpeg` binary
- No shell execution — `fluent-ffmpeg` uses `child_process.spawn()` internally, not `exec()`
- **Command injection risk is LOW** because filenames come from S3 keys and are used as file path arguments, not shell-interpolated. However, path traversal via crafted S3 keys is possible (see FINDINGS.md H-1).

**FFmpeg command generated (approximate):**
```
ffmpeg -i /tmp/<file> -vframes 1 -ss 1 -s ?x159 -f image2 /tmp/<hash>.png
```

## Dependencies

**External:**
- AWS S3 — source and destination for video/thumbnails
- FFmpeg static build — bundled in dist.zip, not installed separately

**Runtime (shipped in dist.zip):**
- `fluent-ffmpeg` — FFmpeg CLI wrapper
- `async` — waterfall/series control flow
- `uuid` — imported but unused (dead dependency)
- `aws-sdk` — S3 client (v2)

**Build-only (devDependencies):**
- `gulp` 3, `gulp-shell`, `gulp-flatten`, `gulp-install`, `gulp-zip`, `gulp-rename`, `gulp-util`
- `del`, `run-sequence`
- `aws-sdk` (also in devDeps for the upload task)

**Note:** `gulp-install` is listed in both `dependencies` and `devDependencies`. It should only be in `devDependencies`.

## API / Interface

**Input**: S3 ObjectCreated event (JSON). Lambda is triggered automatically when a video is uploaded to the source bucket.

**Output**: PNG thumbnail uploaded to the same bucket, same path, with `.png` extension replacing the video extension.

**Configuration** (`config.json`):
- `videoMaxWidth` — **NOT USED** in current code (hardcoded to `?x159` in index.js)
- `videoMaxDuration` — **NOT USED**
- `destinationBucket` — **NOT USED** (code uses source bucket as destination)
- `linkPrefix` — **NOT USED**
- `gzip` — **NOT USED**

All config fields are imported via `require('./config')` but none are referenced in the handler logic.

## Key Patterns

- **Event-driven**: Triggered by S3 ObjectCreated events. No polling.
- **Stateless**: Lambda function processes one video per invocation, no state persistence.
- **Synchronous pipeline**: Download -> FFmpeg -> Upload, all in one Lambda execution via `async.series`.
- **Thumbnail at 1 second**: Hardcoded to extract frame at timestamp 1 second. Not configurable.
- **Same-bucket output**: Thumbnail goes to same bucket as source video (ignoring config.json `destinationBucket`).

## Environment

**Required IAM permissions** (Lambda execution role — see FINDINGS.md H-2 for least-privilege version):
- `s3:GetObject` on source bucket
- `s3:PutObject` on destination bucket
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` on the function's log group

**Lambda configuration:**
- Memory: Use maximum allocation (CPU is proportional; FFmpeg is CPU-bound)
- Timeout: Adjust based on video size. Must exceed download + FFmpeg + upload time.
- Runtime: Node.js 0.10.33 (deprecated; requires Node.js 18+ or 20+ to deploy today)
- `/tmp` storage: 512 MB limit on legacy runtimes (10 GB on newer). Videos larger than this will fail.

**S3 event configuration:**
- Source bucket must have event notification for ObjectCreated events
- **IMPORTANT:** Use suffix filter (`.mp4`, `.mkv`, etc.) to prevent thumbnail uploads from re-triggering the function

<!-- Ask: What's the current Lambda memory and timeout configuration in production? Has this been upgraded to a newer Node.js runtime? -->

## Deployment

**Build process:**
1. Run `gulp` to execute build tasks:
   - Clean dist directory
   - Download FFmpeg static build for 64-bit Linux (WARNING: over HTTP, not HTTPS)
   - Extract and copy `ffmpeg` and `ffprobe` binaries to dist/
   - Copy `index.js` and `config.json` to dist/
   - Run `npm install --production` in dist/ (excludes dev dependencies)
   - Zip everything into `dist.zip`

2. Upload `dist.zip` to AWS Lambda console or via AWS CLI

**Automated deployment:** None. The `gulp upload` task exists but uses deprecated Lambda SDK methods (`uploadFunction`, `Mode` parameter) and hardcodes `us-east-1`.

**CI/CD:** Only a GitHub Actions workflow for S3 backup (`.github/workflows/github-backup.yml`), which triggers on `develop` branch — **not** the default `master` branch.

**Deployment environments:**
<!-- Ask: Is this Lambda function deployed in multiple AWS accounts (dev, qa, prod)? How are deployments triggered (manual, CI/CD)? -->

## Testing

**Local testing:**
1. Modify `sample.js` with real bucket name and object key
2. Run `node sample.js`
3. Requires AWS credentials with S3 access in environment or `~/.aws/credentials`

**Production testing:**
1. Upload a video to the source bucket
2. Check CloudWatch Logs for Lambda execution logs
3. Verify thumbnail appears in S3 at the expected path

**No automated tests**: `package.json` scripts section has placeholder test command that exits 1.

## Gotchas

- **Unreliable / likely broken**: README warns this "sometime it fails on AWS but not locally." Root cause is likely the `Range: bytes=0-1000000` header in `downloadStream()` that truncates downloads to ~1 MB. This is enough for small/low-bitrate videos but fails for larger ones.
- **Node.js 0.10.33 is EOL**: AWS Lambda no longer supports this runtime. The function cannot be deployed today without a rewrite.
- **`context.succeed/fail` API is deprecated**: Modern Lambda uses callback pattern or async/await. Must rewrite handler signature.
- **Config.json is entirely unused**: All five config fields are imported but never referenced. The code uses hardcoded values instead (`?x159` size, source bucket as destination).
- **Temp files never cleaned up**: Downloaded video and generated thumbnail persist in `/tmp/` across warm starts. Will eventually fill the 512 MB limit.
- **Same-bucket output can retrigger Lambda**: If S3 event trigger doesn't filter by suffix, uploading the `.png` thumbnail triggers another invocation.
- **URL encoding**: S3 object keys in events are URL-encoded. Spaces may be replaced with `+`. The code handles this correctly.
- **Path traversal risk**: S3 object key is used as filename under `/tmp/` without sanitization. Crafted keys with `../` could write outside `/tmp/`.
- **FFmpeg downloaded over HTTP**: Supply-chain risk. The build downloads FFmpeg over plain HTTP without checksum verification.
- **Unused imports**: `uuid`, `crypto`, `zlib`, `stream` are all imported but never used.
- **`gulp-install` in dependencies**: Should be devDependencies only — it ships in the Lambda package unnecessarily.
- **GitHub Actions backup triggers on `develop`**: Default branch is `master`. Backups never run.
- **Memory for large videos**: The `sample.js` test file references a 748 MB video — this exceeds Lambda's `/tmp` limit.

## Known Security Issues

See `FINDINGS.md` for the full audit. Key items:
- **C-2**: FFmpeg binary downloaded over HTTP (MITM risk)
- **H-1**: Path traversal via unsanitized S3 key used as local filename
- **H-2**: IAM policy uses `logs:*` on `*` (over-privileged)
- **L-1**: Real bucket names and principal IDs in `sample.js`

## Relationship to Other Repos

- **CloudTranscode** (ECS) — Production media pipeline. Uses Step Functions + ECS workers for transcoding. This Lambda repo is a lightweight fallback/proof-of-concept.
- **CloudTranscode-FFMpeg-presets** — Encoding profiles for the ECS pipeline. Not used by this Lambda.
- **bFAN-LambdaLayers-js** — Lambda Layers for Node.js. Could provide a modern FFmpeg layer to replace the bundled binary approach.

<!-- Ask: Why does this sometimes fail on AWS but not locally? Are there CloudWatch Logs showing specific error patterns? -->
<!-- Ask: Is this Lambda still in use, or has it been replaced by CloudTranscode ECS workers? -->
<!-- Ask: Should we deprecate this repo and migrate to CloudTranscode for all thumbnail generation? -->
