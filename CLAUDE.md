# CloudTranscode-Lambda

## What This Is

CloudTranscode-Lambda is a Node.js AWS Lambda function that generates video thumbnails on S3 upload events. It's a lightweight, event-driven alternative to the CloudTranscode ECS workers for simple thumbnail generation. The function downloads a video from S3, uses FFmpeg to extract a thumbnail at 1 second, and uploads the PNG back to S3.

**Status**: Legacy/unreliable. The README warns: "This code works and create thumbnails using lambda. However for some reason sometime it fails on AWS but not locally. Some videos work though. Use Cloud Transcode !" Consider this a fallback or proof-of-concept rather than production-grade.

## Tech Stack

- **Language**: Node.js 0.10.33 (legacy AWS Lambda runtime — may need upgrade)
- **AWS Services**: Lambda, S3
- **FFmpeg**: Bundled 64-bit Linux build from John Van Sickle's static builds
- **Dependencies**:
  - `fluent-ffmpeg` ~2.0 — FFmpeg wrapper
  - `async` ^0.9.0 — async control flow
  - `aws-sdk` ^2.1.24 — S3 operations
  - `uuid` ^2.0.1 — unique identifiers
- **Build tool**: Gulp (downloads FFmpeg, packages dist.zip)

## Quick Start

```bash
# Setup (use Node 0.10.33 via nvm to match Lambda runtime)
nvm use 0.10.33
npm install

# Build deployment package
gulp  # Downloads FFmpeg, packages dist.zip

# Deploy (manual)
# 1. Upload dist.zip to AWS Lambda console
# 2. Configure S3 event trigger on source bucket
# 3. Set IAM execution role with S3 read/write permissions

# Test locally
node sample.js  # Edit bucket/key in sample.js first
```

## Project Structure

- `index.js` — Lambda handler function (downloads video, generates thumbnail, uploads)
- `config.json` — Configuration (max width, duration, destination bucket, gzip)
- `gulpfile.js` — Build tasks (download FFmpeg, package dist.zip)
- `sample.js` — Local test harness (simulates S3 event)
- `doc/` — Documentation images
- `dist/` — Build output (created by Gulp, not in repo)

## Dependencies

**External:**
- AWS S3 — source and destination for video/thumbnails
- FFmpeg static build — bundled in dist.zip, not installed separately

## API / Interface

**Input**: S3 ObjectCreated event (JSON). Lambda is triggered automatically when a video is uploaded to the source bucket.

**Output**: PNG thumbnail uploaded to the same bucket, same path, with `.png` extension replacing the video extension.

**Configuration** (`config.json`):
- `videoMaxWidth` — thumbnail width (height auto-scaled to maintain aspect ratio)
- `videoMaxDuration` — not used in current code
- `destinationBucket` — target S3 bucket (default: same as source)
- `linkPrefix` — not used in current code
- `gzip` — not used in current code

## Key Patterns

- **Event-driven**: Triggered by S3 ObjectCreated events. No polling.
- **Stateless**: Lambda function processes one video per invocation, no state persistence.
- **Synchronous processing**: Downloads entire video to `/tmp`, processes, uploads thumbnail. All in one Lambda execution.
- **Thumbnail at 1 second**: Hardcoded to extract frame at timestamp 1 second. Not configurable via input.
- **Same-bucket output**: Thumbnail is uploaded to the same bucket as the source video, same directory structure.

## Environment

**Required IAM permissions** (Lambda execution role):
- `s3:GetObject` on source bucket
- `s3:PutObject` on destination bucket
- `logs:*` on CloudWatch Logs (for debugging)

**Lambda configuration:**
- Memory: Use maximum allocation (CPU is bundled with memory; FFmpeg is CPU-bound)
- Timeout: Adjust based on video size. Default may be too short.
- Runtime: Node.js 0.10.33 (deprecated; upgrade recommended)

**S3 event configuration:**
- Source bucket must have event notification configured to trigger Lambda on ObjectCreated:Post or ObjectCreated:Put events

<!-- Ask: What's the current Lambda memory and timeout configuration in production? Has this been upgraded to a newer Node.js runtime? -->

## Deployment

**Build process:**
1. Run `gulp` to execute build tasks:
   - Clean dist directory
   - Download FFmpeg static build for 64-bit Linux
   - Extract and copy `ffmpeg` and `ffprobe` binaries to dist/
   - Copy `index.js` and `config.json` to dist/
   - Run `npm install --production` in dist/ (excludes dev dependencies)
   - Zip everything into `dist.zip`

2. Upload `dist.zip` to AWS Lambda console or via AWS CLI

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

- **Unreliable**: README warns this "sometime it fails on AWS but not locally." Root cause unknown. May be related to Lambda timeout, memory limits, or video format edge cases.
- **Node.js 0.10.33 is deprecated**: AWS Lambda no longer supports this runtime. Must upgrade to Node.js 18+ or 20+.
- **URL encoding**: S3 object keys in events are URL-encoded. Spaces may be replaced with `+`. The code handles this: `decodeURIComponent(key.replace(/\+/g, " "))`.
- **Error handling**: Not using `context.fail(error)` will cause the function to run until timeout. Current code handles this correctly.
- **Memory allocation**: Lambda bundles CPU and memory. For FFmpeg, allocate maximum memory for better CPU performance.
- **Execution time limit**: Lambda has a maximum execution time. Large videos may hit timeout.
- **Temp storage**: Lambda `/tmp` directory has 512 MB limit (512 MB for older runtimes, 10 GB for newer). Videos larger than this will fail.
- **Hardcoded thumbnail timing**: Always extracts frame at 1 second. Not configurable. Videos shorter than 1 second will fail.
- **No retry logic**: If FFmpeg fails, the Lambda invocation fails. No automatic retry unless configured at S3 event or Lambda level.
- **FFmpeg version**: Static build version is not pinned in gulpfile.js. May download different versions over time.

<!-- Ask: Why does this sometimes fail on AWS but not locally? Are there CloudWatch Logs showing specific error patterns? -->
<!-- Ask: Is this Lambda still in use, or has it been replaced by CloudTranscode ECS workers? -->
<!-- Ask: Should we deprecate this repo and migrate to CloudTranscode for all thumbnail generation? -->