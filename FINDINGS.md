# CloudTranscode-Lambda — AI Security & Operational Audit

**Date:** 2026-02-17  
**Auditor:** Claude Opus 4.6 (Backend Developer agent)  
**Scope:** Full codebase — `index.js`, `gulpfile.js`, `sample.js`, `config.json`, `package.json`, `.github/workflows/`  
**Focus:** Command injection, IAM permissions, temp file handling, timeout management, error recovery, cost optimization  

---

## Critical

### C-1: Deprecated and EOL Node.js Runtime (v0.10.33)

**File:** `package.json`, `README.md`, `CLAUDE.md`  
**Risk:** Runtime removal, security vulnerabilities, no AWS support  

The Lambda function targets Node.js 0.10.33, which reached end-of-life in **October 2016** — nearly a decade ago. AWS Lambda dropped support for this runtime years ago. The function **cannot be deployed** to any current Lambda runtime without code changes.

**Impact:**
- The function cannot be deployed or updated on AWS Lambda today
- Node.js 0.10 has hundreds of known CVEs (OpenSSL, HTTP parser, V8)
- The `context.succeed()`/`context.fail()` API used in the handler was replaced by callback/async patterns in Node.js 4.x+
- The `aws-sdk` v2.1.24 is severely outdated (current is v3.x)

**Remediation:**
1. Rewrite handler to use the callback pattern (`exports.handler = function(event, context, callback)`) or async/await (Node.js 18+)
2. Upgrade `aws-sdk` to v3 (`@aws-sdk/client-s3`)
3. Replace `async` library with native `Promise.all()` / async-await
4. Test with Node.js 20.x or 22.x Lambda runtime
5. **Or:** Deprecate this function entirely in favor of CloudTranscode ECS workers (recommended — see C-3)

---

### C-2: FFmpeg Downloaded Over Unencrypted HTTP

**File:** `gulpfile.js`, line 14  
```javascript
var fileURL = 'http://johnvansickle.com/ffmpeg/builds/ffmpeg-git-64bit-static.tar.xz';
```

**Risk:** Supply-chain attack via man-in-the-middle  

The FFmpeg binary — which executes arbitrary media processing — is downloaded over **plain HTTP** during the build. An attacker on the network path (corporate proxy, public WiFi, compromised DNS) could substitute a malicious binary. This binary then ships inside `dist.zip` and runs in the Lambda function with full IAM permissions.

**Impact:**
- Arbitrary code execution in the Lambda environment
- Access to all S3 buckets the Lambda role can reach
- Potential lateral movement to other AWS resources

**Remediation:**
1. Switch to `https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-64bit-static.tar.xz`
2. Pin a specific version instead of `-git-` (floating latest)
3. Verify the download with a SHA256 checksum (publish checksum in repo)
4. Consider using an AWS Lambda Layer with a known-good FFmpeg build instead

---

### C-3: Function Is Acknowledged as Unreliable / Undeployable

**File:** `README.md` line 1  
> "This code works and create thumbnails using lambda. However for some reason sometime it fails on AWS but not locally. Some videos work though. Use Cloud Transcode !"

**Risk:** Data loss, silent failures in production  

The README itself tells users not to rely on this function. Combined with the EOL runtime (C-1), this function is effectively non-functional on current AWS infrastructure. If it is still wired to S3 events, it is silently failing on every invocation.

**Remediation:**
- **If still deployed:** Remove the S3 event trigger immediately. Check CloudWatch Logs for recent invocations.
- **If not deployed:** Archive the repo. Document in `docs/architecture.md` that CloudTranscode ECS workers are the sole media pipeline.
- If thumbnail generation via Lambda is still desired, rewrite from scratch on Node.js 20+ with proper error handling.

---

## High

### H-1: S3 Object Key Used Directly as Local Filename (Path Traversal)

**File:** `index.js`, lines 117-137  
```javascript
var srcKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
var file = prefix.splice(prefix.length-1, 1)[0];
// ...
dlStream.pipe(fs.createWriteStream("/tmp/"+file));
```

**Risk:** Path traversal, arbitrary file overwrite in Lambda `/tmp`  

The S3 object key is URL-decoded and used directly as a filename under `/tmp/`. A crafted S3 key containing `../` sequences (e.g., `folder/../../../etc/passwd`) could write files outside `/tmp/`. While Lambda's filesystem is ephemeral and sandboxed, this could:
- Overwrite the FFmpeg binary or `index.js` in the function's execution environment
- Cause unexpected behavior if the Lambda container is reused (warm start)

**Additionally:** The `file` variable is passed directly to `ffmpeg("/tmp/"+file)` (line 88) and `ffmpeg.ffprobe("/tmp/"+file)` (line 75). While `fluent-ffmpeg` uses these as file paths (not shell commands), any path traversal already succeeded at the download step.

**Remediation:**
```javascript
var path = require('path');
var file = path.basename(srcKey); // Strip all directory components
// Or use a UUID:
var file = uuid.v4() + path.extname(srcKey);
```

---

### H-2: Overly Broad IAM Policy — `logs:*` on `*`

**File:** `README.md` (IAM policy example), lines 36-66  
```json
{
    "Effect": "Allow",
    "Action": ["logs:*"],
    "Resource": "arn:aws:logs:*:*:*"
}
```

**Risk:** Privilege escalation, log manipulation  

`logs:*` grants 30+ CloudWatch Logs actions including `DeleteLogGroup`, `PutSubscriptionFilter` (can exfiltrate logs to attacker-controlled destination), `CreateExportTask` (export logs to S3), and `PutDestination`. The resource `arn:aws:logs:*:*:*` covers every log group in every region.

**Remediation:**
```json
{
    "Effect": "Allow",
    "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
    ],
    "Resource": "arn:aws:logs:us-east-1:ACCOUNT_ID:log-group:/aws/lambda/FUNCTION_NAME:*"
}
```

---

### H-3: Temp Files Never Cleaned Up

**File:** `index.js`, lines 131-150  

The function downloads the video to `/tmp/<file>` and FFmpeg writes the thumbnail to `/tmp/<hash>.png`. Neither file is deleted after upload. There is even a commented-out `fs.unlinkSync(filename)` on line 47 that was intentionally disabled.

**Risk:**
- Lambda containers are reused (warm starts). `/tmp` persists across invocations.
- `/tmp` has a 512 MB limit (legacy runtimes). Accumulated files from warm-start reuse will eventually fill `/tmp`, causing subsequent invocations to fail with `ENOSPC`.
- A 748 MB video (as in `sample.js`) would exceed `/tmp` on its own.

**Remediation:**
```javascript
// In the final callback, after upload:
fs.unlinkSync("/tmp/" + file);      // delete downloaded video
fs.unlinkSync("/tmp/" + hash + ".png"); // delete generated thumbnail
```
Wrap in try-catch to avoid failing on cleanup errors.

---

### H-4: Partial Download — Only First 1 MB Retrieved

**File:** `index.js`, lines 23-26  
```javascript
var req = s3.getObject({
    Bucket: bucket,
    Key: file,
    Range: "bytes=0-1000000"
}, function(err, data) { ... });
```

**Risk:** FFmpeg receives a truncated video, produces corrupted or no thumbnail  

The `downloadStream` function issues an S3 `getObject` with `Range: "bytes=0-1000000"` — only the first ~1 MB. However, the actual download uses `req.createReadStream()` (line 37), which streams the full object. The `Range` header on the API call and the stream behavior create a conflict:
- The callback receives only 1 MB (truncated)
- The stream may or may not respect the Range header depending on SDK version

This is likely the root cause of the intermittent failures noted in the README. For small videos, 1 MB might contain the first second of video. For larger or higher-bitrate videos, 1 MB is insufficient and FFmpeg fails.

**Remediation:**
Remove the `Range` header entirely — download the full object:
```javascript
var req = s3.getObject({
    Bucket: bucket,
    Key: file
}, function(err, data) { ... });
```

---

### H-5: Outdated Dependencies with Known Vulnerabilities

**File:** `package.json`  

| Package | Pinned Version | Current | CVEs / Notes |
|---------|---------------|---------|---|
| `aws-sdk` | ^2.1.24 | 3.x | v2 is in maintenance mode; v2.1.24 is from 2014 |
| `fluent-ffmpeg` | ~2.0 | 2.1.3 | Tilde range locks to 2.0.x; misses bug fixes |
| `async` | ^0.9.0 | 3.x | 0.9 is from 2014; no security issues but missing 8 years of fixes |
| `uuid` | ^2.0.1 | 11.x | v2 uses Math.random() — not cryptographically secure |
| `gulp` | ^3.8.11 | 5.x | Gulp 3 has known issues |
| `gulp-install` | ^0.4.0 | — | Listed in both dependencies and devDependencies |

**Note:** `gulp-install` appears in both `dependencies` and `devDependencies`. It is a build tool and should only be in `devDependencies`. Shipping it in the Lambda package wastes space.

**Remediation:**
- If keeping the function: upgrade all dependencies to current major versions
- Remove `gulp-install` from `dependencies`
- Run `npm audit` after upgrade

---

## Medium

### M-1: No Input Validation on S3 Event

**File:** `index.js`, lines 114-128  

The handler assumes:
- `event.Records[0]` exists (crashes on malformed events)
- `event.Records[0].s3.object.key` exists (crashes on missing key)
- The file has an extension (the regex `file.replace(/\..+$/, '')` produces the original name if no extension)
- The file is a video (no MIME type or extension check)

Any non-video file uploaded to the source bucket (images, documents, text files) will trigger Lambda, download the file, and fail in FFmpeg — wasting execution time and cost.

**Remediation:**
```javascript
// Validate event structure
if (!event.Records || !event.Records[0] || !event.Records[0].s3) {
    return context.fail('Invalid S3 event');
}

// Filter by video extensions
var videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv'];
var ext = path.extname(file).toLowerCase();
if (videoExtensions.indexOf(ext) === -1) {
    return context.succeed('Skipping non-video file: ' + file);
}
```

---

### M-2: No Lambda Timeout Awareness

**File:** `index.js`  

The function has no awareness of its remaining execution time. For large videos, the download + FFmpeg processing + upload chain could exceed the Lambda timeout. When Lambda times out:
- No cleanup happens (temp files remain)
- No meaningful error is logged
- The S3 event may be retried (default: up to 2 retries), causing repeated failures

**Remediation:**
```javascript
// Check remaining time before expensive operations
var remainingMs = context.getRemainingTimeInMillis();
if (remainingMs < 30000) { // 30s safety margin
    return context.fail('Insufficient time remaining: ' + remainingMs + 'ms');
}
```

---

### M-3: Infinite Retry Loop Risk

**File:** `index.js` — output path logic, line 144  
```javascript
uploadFile("/tmp/"+hash+".png", dstBucket, prefix+"/"+hash+".png", ...)
```

The thumbnail is uploaded to the **same bucket** as the source video. If the S3 event trigger is configured for `ObjectCreated:*` (all create events), uploading the `.png` thumbnail will trigger another Lambda invocation. That invocation will:
1. Download the PNG
2. Fail in FFmpeg (not a video)
3. Call `context.fail()`
4. S3 retries the event (up to 2 times)

This creates unnecessary Lambda invocations and cost. With certain S3 event configurations, it could cascade.

**Remediation:**
- Configure S3 event trigger with a **suffix filter** (e.g., `.mp4`, `.mkv`) to exclude `.png` files
- Or use a separate destination bucket (as the README originally suggested)
- Or add the extension check from M-1

---

### M-4: GitHub Actions Workflow Triggers on Wrong Branch

**File:** `.github/workflows/github-backup.yml`, line 5  
```yaml
on:
  push:
    branches:
      - develop
```

The backup workflow triggers on the `develop` branch, but the repo's default branch is `master`. Pushes to `master` are never backed up to S3.

**Remediation:**
Change to `master` (or add both branches if `develop` is also used):
```yaml
on:
  push:
    branches:
      - master
```

---

### M-5: Hardcoded AWS Region in Gulp Upload

**File:** `gulpfile.js`, line 82  
```javascript
AWS.config.region = 'us-east-1';
```

The `upload` gulp task hardcodes `us-east-1`. If the Lambda function is deployed in a different region, the upload task silently targets the wrong region.

**Remediation:**
Read from environment variable or config:
```javascript
AWS.config.region = process.env.AWS_REGION || 'us-east-1';
```

---

### M-6: Deprecated Lambda API in Gulp Upload

**File:** `gulpfile.js`, line 112  
```javascript
lambda.uploadFunction(params, function(err, data) { ... });
```

`uploadFunction` is a deprecated Lambda API method (removed in SDK v3). The current API is `updateFunctionCode`. The `Mode` parameter (line 106) also does not exist in current Lambda APIs.

---

## Low

### L-1: Sensitive Information in Sample Test File

**File:** `sample.js`, lines 22-26  
```javascript
bucket: {
    name: "sportarchive-dev-orgs",
    ownerIdentity: {principalId: "aws-sa-dev"},
    arn: "arn:aws:s3:::sportarchive-dev-orgs"
}
```

The sample file contains a real bucket name (`sportarchive-dev-orgs`), a real principal ID (`aws-sa-dev`), and a real ARN. While not secrets, they reveal infrastructure naming conventions and account identifiers.

**Remediation:** Replace with placeholder values (as the README example does).

---

### L-2: Unused Config Fields

**File:** `config.json` / `index.js`  

The following `config.json` fields are imported but never used in `index.js`:
- `videoMaxWidth` (283) — the code uses hardcoded `"?x159"` instead
- `videoMaxDuration` — never referenced
- `linkPrefix` — never referenced
- `gzip` — never referenced
- `destinationBucket` — never referenced (code uses `srcBucket` as destination)

**Impact:** Misleading for maintainers. Someone might change `config.json` expecting behavior changes.

**Remediation:** Either use the config values in code or remove unused fields.

---

### L-3: Hardcoded Thumbnail Size

**File:** `index.js`, line 93  
```javascript
size: "?x159"
```

The thumbnail height is hardcoded to 159px. The `config.json` has `videoMaxWidth: 283` which is never used. This should be configurable.

---

### L-4: Inconsistent Error Handling Between Download and Processing

**File:** `index.js`  

The download stream has two error paths that can both fire:
1. The `getObject` callback (line 28) logs the error but does not call `cb`
2. The `req.on('error')` handler (line 32) calls `cb` with an error
3. The `dlStream.on('end')` handler (line 134) calls `cb(null, ...)` on success

If both the error callback and the end event fire, `cb` is called twice, which causes `async.series` to behave unpredictably.

---

### L-5: Console Logging of Full S3 Response

**File:** `index.js`, line 29  
```javascript
else console.log(data); // successful response
```

Logs the entire S3 `getObject` response (including potentially large metadata) to CloudWatch. This increases logging costs and may expose internal metadata.

---

### L-6: `uuid` Dependency Imported but Never Used

**File:** `index.js`, line 12  
```javascript
var uuid = require('uuid');
```

The `uuid` module is imported but never called anywhere in the code. Dead dependency that adds to the deployment package size.

---

### L-7: `crypto`, `zlib`, and `stream` Modules Imported but Unused

**File:** `index.js`, lines 7-9  
```javascript
var zlib = require('zlib');
var crypto = require('crypto');
var stream = require('stream');
```

Three built-in modules are imported and never used. Dead imports.

---

## Agent Skill Improvements

### S-1: Backend Developer Skill — Media Pipeline Awareness

The backend developer agent should be aware that `CloudTranscode-Lambda` is legacy/deprecated and should direct users to the ECS-based `CloudTranscode` for production media processing. Add to the backend-dev skill knowledge base:
- CloudTranscode-Lambda: legacy Node.js Lambda for thumbnail generation, NOT production-grade
- CloudTranscode: production ECS-based pipeline with Step Functions orchestration
- For new thumbnail needs, use CloudTranscode or consider a modern Lambda approach with Lambda Layers for FFmpeg

### S-2: DevOps Skill — Deployment Pipeline Gap

This repo has no CI/CD pipeline for Lambda deployment. The gulp upload task is deprecated and non-functional. The DevOps agent should flag repos with manual deployment processes during audit rounds.

### S-3: Hub Skill — Submodule Staleness Detection

The hub should track which repos target EOL runtimes. A periodic audit that checks `package.json` engine requirements and Dockerfile base images across all 43 submodules would catch issues like this before they become blockers.

### S-4: CTO Skill — Deprecation Decisions

This repo needs a clear deprecation decision. The CTO agent should be equipped to identify repos that are:
1. Acknowledged as unreliable by their own README
2. Targeting EOL runtimes
3. Superseded by other services (CloudTranscode ECS)

And recommend formal deprecation with archived status.

---

## Positive Observations

### P-1: Correct URL Decoding of S3 Keys

**File:** `index.js`, line 118  
```javascript
decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "))
```

Properly handles the S3 event key encoding quirk where spaces become `+` signs. This is a common gotcha that many Lambda-S3 integrations miss.

### P-2: Proper Error Propagation to Lambda

**File:** `index.js`, lines 147-149  
```javascript
if (err) context.fail(err);
else context.succeed(util.inspect(results, {depth: 5}));
```

Correctly uses `context.fail()` and `context.succeed()` (for the v0.10 runtime) to signal completion. Not calling these would cause the function to run until timeout.

### P-3: Cache-Control Header on Upload

**File:** `index.js`, line 63  
```javascript
CacheControl: 'max-age=31536000' // 1 year
```

Sets a 1-year cache header on uploaded thumbnails. Good practice for immutable content served via CDN.

### P-4: Existing CLAUDE.md is Thorough

The existing `CLAUDE.md` was well-written with accurate status warnings, gotcha documentation, and knowledge-gap placeholders (`<!-- Ask: ... -->`). This audit builds on that foundation.

### P-5: Clean Separation of Concerns

Despite its issues, the codebase has a clean separation: download -> process -> upload, with each step as a named function. This makes the code easy to audit and would be straightforward to modernize.

---

## Summary

| Severity | Count | Key Theme |
|----------|-------|-----------|
| Critical | 3 | EOL runtime, supply-chain risk, acknowledged unreliability |
| High | 5 | Path traversal, IAM over-privilege, temp file leak, truncated download, outdated deps |
| Medium | 6 | No input validation, no timeout awareness, retry loops, wrong branch, hardcoded region, deprecated API |
| Low | 7 | Leaked infra names, unused config/imports, hardcoded values, inconsistent errors |

**Primary recommendation:** Formally deprecate this repository. The ECS-based CloudTranscode pipeline is the production solution. If Lambda-based thumbnailing is needed, build a new function from scratch on Node.js 20+ with a Lambda Layer for FFmpeg, proper input validation, and Infrastructure-as-Code deployment.
