# Production Security and Reliability Audit

**Project:** Aaroh Quiz Portal  
**Review date:** 2026-09-30  
**Scope:** Static review of the checked-out source, project specification, install metadata, and deployment documentation. Review covered Express routes, SQLite schema/use, browser code, password/session handling, imports/uploads, and operational guidance. No source changes were made.

## Executive assessment

**Not ready for a production exam without addressing the first four findings.** Student identity is the supplied phone number, but the server does not verify ownership; any person who knows a number can take over that student's active session and attempt. Browser answer persistence also has failure modes that can silently lose answers. Student sessions lack server-side expiry despite the documented one-day lifetime. The documented per-IP entry limit can block legitimate groups sharing a school or event network.

Positive controls found: SQL is parameterized in reviewed routes; admin and student credentials use random session tokens in `HttpOnly`, `SameSite=Strict` cookies; admin sessions have a server-side 12-hour bound; quiz deadlines and grading are server-side; the student API does not return correct answers; CSP, framing, MIME-sniffing, and referrer headers are set. I found no confirmed SQL injection or unescaped user-content XSS in the reviewed browser templates.

## Findings

### High — Live student entry reports that its database is not connected

**Evidence:** On 2026-09-30, the live entry form displayed: “No database is connected. In Vercel open this project, go to Storage, create or connect a Postgres (Neon) database, then redeploy.” The warning was visible during browser-only testing. No valid registration was submitted.

**Impact:** Registration and quiz access may be unavailable on the deployed site. The checked-out project uses SQLite (`db.js`), while this live error describes a Vercel Postgres/Neon dependency. That mismatch may indicate deployment drift or a separate live implementation; it is not explained by the repository reviewed here.

**Fix:** Check the deployed build's database binding and deployment commit/configuration. Confirm the backend health and complete a synthetic end-to-end registration only in a disposable staging environment before launch.

### Medium — Live announcements schedule fails to load

**Evidence:** On 2026-09-30, the live landing page at `https://aaroh-quiz-portal.vercel.app/` changed from “Loading schedule…” to “Could not load the schedule. Please refresh the page.” This was observed in the browser without submitting any data. The cause is unverified; the app's local source implements `GET /api/schedule` in `routes/student.js:66-71`.

**Impact:** Students cannot see announced quiz dates/times on the landing page, which can cause missed participation. The browser view does not establish whether the API is missing, returning an error, or temporarily unavailable.

**Fix:** Check the deployed API response and hosting configuration, then add a production health check and alert for schedule failures. Provide an explicit retry path and verify the live schedule after deploy.

### High — Student login is impersonation by phone number

**Evidence:** `routes/student.js:74-112` (`/enter`); `routes/student.js:14-30` (session check).

`/api/enter` accepts a name, school, phone, and fee answer, but does not verify phone ownership or require a pre-registered credential. For an existing, active phone, it revokes every current student session and issues a new session for that student. The existing profile is not changed, but the new session is authorized as that student.

**Impact:** A person who knows or guesses a student's number can evict the student, resume or start their attempt, change answers, or submit it. The per-IP limit slows only one source; distributed sources can continue. New numbers can also be claimed first, creating account squatting and fake registrations.

**Fix before launch:** Bind entry to a verified identity: for example, an organizer-issued one-time code or a pre-registered roster with a secure verification step. A phone number alone is an identifier, not an authenticator. Add abuse controls that do not treat all students behind one NAT as one account.

### High — Answers can be silently lost in storage-disabled browsers or at time-up

**Evidence:** `public/student.js:6-9, 214, 255-268, 363-395, 400-413`.

The pending-answer queue exists only in `localStorage`. Storage exceptions are swallowed; when storage is unavailable, `save()` cannot persist the queue and `flushPending()` reads an empty queue, so no answer request is sent. On time-up, `timeUp()` proceeds to `finish()` even if a network failure left answers queued; `finish()` deletes that queue. Manual submit can also finish after the answer-save request fails if the submit request itself succeeds.

**Impact:** Private browsing/storage policy, quota, or a transient outage can leave an attempt with missing answers and no visible recovery path. Client state may show a selected answer that the server never received.

**Fix before launch:** Keep an in-memory queue as the primary working state and treat browser persistence as an optional recovery layer. Before reporting successful submission, distinguish saved from unsaved answers; preserve the queue and give a clear failure state where recovery is possible. Add a regression check for storage throwing and answer-save failure at deadline.

### High — Entry rate limiting can reject legitimate cohorts

**Evidence:** `routes/student.js:74`; `lib/common.js:49-69`; `README.md:102-105`.

Student entry is capped at 15 requests per IP per 15 minutes. Students at a school, event venue, or mobile carrier may share one public IP, so the 16th legitimate student can be refused. Counters are in memory, so restarts reset them and multiple instances each enforce a separate limit. `TRUST_PROXY=true` trusts one proxy hop; if traffic can reach the app directly or the proxy does not overwrite forwarding headers, clients may spoof the IP used for throttling.

**Impact:** A planned large group can be locked out, while a distributed attacker or multi-instance deployment can bypass the intended cap.

**Fix before launch:** Choose limits against expected cohort/NAT size and test an event-sized registration burst. Use a shared limiter if scaling beyond one process. Trust only the actual ingress proxy and prevent direct app access; verify its forwarded-IP behavior.

### High — Capacity and deadline-storm claim is unverified

**Evidence:** `db.js:8-12`; `lib/common.js:109-112`; `server.js:73-74`; `README.md:105`.

SQLite calls are synchronous, and the expiry sweep loads every expired attempt then finalizes them serially on the Node event loop. A large cohort sharing one close/deadline time can block all requests while those writes run. Each answer save also performs synchronous SQLite work. The README claim of support for “a couple of thousand” concurrent students has no load-test evidence in the repository.

**Impact:** Long pauses, request timeouts, late autosaves, and missed operational visibility during the exact deadline spike expected for a quiz.

**Fix before launch:** Load-test realistic concurrent autosaves and a mass-expiry event on the intended instance and disk. Publish a measured supported limit. Do not add replicas with independent SQLite files; move to coordinated shared state before multi-instance service.

### Medium — Student sessions do not expire on the server

**Evidence:** `routes/student.js:9, 14-30, 112`; documented lifetime: `PROJECT_SPEC.md:264`.

The student cookie is sent with a one-day `Max-Age`, but `requireStudent()` accepts any matching, unrevoked database session without checking `created_at` or `last_seen`. Cookie expiration only stops the normal browser from sending it. A copied token remains usable after one day until replaced, blocked, or manually logged out.

**Impact:** A stolen or exposed session can outlive the documented lifetime. Sessions also accumulate because expired student sessions are not removed.

**Fix:** Enforce server-side absolute expiry (and optionally idle expiry) in the shared student-auth middleware; revoke/clean expired rows. Keep the policy aligned with the quiz resume requirement.

### Medium — Cookie transport security and HSTS depend on operator memory

**Evidence:** `lib/common.js:43-46`; `server.js:35-46`; `README.md:102`.

Cookies receive `Secure` only when `COOKIE_SECURE=true`, and the app does not set HSTS. The README tells operators to enable `Secure`, but the default is insecure. The app itself does not require HTTPS.

**Impact:** A misconfigured public deployment may send session cookies over HTTP or permit downgrade exposure. This is configuration-dependent; a correctly configured TLS proxy reduces the risk.

**Fix:** Set `COOKIE_SECURE=true` in production, terminate HTTPS at a trusted ingress, redirect HTTP there, and set HSTS at the TLS edge after validating all hostnames/subdomains.

### Medium — Live question edits can change an in-progress attempt's meaning and score

**Evidence:** `routes/admin.js:135-146, 183-193`; `routes/student.js:209-245`; `lib/common.js:80-103`; `db.js:101-106`.

An attempt stores question IDs and option-index order, but not a snapshot of question text, options, correct answer, or marks. The question API reads current question rows, and grading also uses current correct answers and marks. Admins can edit or delete questions while a quiz is live. Deleting a question leaves answer rows behind because `answers.question_id` has no foreign key to `questions`; grading skips missing questions.

**Impact:** Students can see changed questions/options mid-attempt; saved option indices can map to different text; scores/totals can change after the attempt; deleting questions can silently omit results.

**Fix:** Freeze question content once any attempt starts, or snapshot the needed question data per attempt. Make the admin UI warn and block edits/deletes on live or completed quizzes unless a deliberate, audited correction workflow is used.

### Medium — Admin password changes leave existing sessions alive

**Evidence:** `routes/admin.js:23-26, 55-61`.

Changing the password updates only the password hash. Existing admin session tokens remain valid until their original 12-hour age limit.

**Impact:** A password change does not contain an already stolen admin session.

**Fix:** Revoke all admin sessions on password change, including the current session if the desired policy is reauthentication.

### Medium — Backup instructions do not produce a complete, verified restore

**Evidence:** `db.js:9-12`; `routes/admin.js:10-11, 195-203`; `README.md:105`.

SQLite runs in WAL mode, while the README says to back up only `data/aaroh.db`. Copying that file during service can omit committed WAL data. Question images are stored separately in `UPLOAD_DIR`; restoring only the database loses them.

**Impact:** A restore may lose recent registrations/results or leave image links broken.

**Fix:** Use SQLite's backup API or a controlled stop/checkpoint snapshot, include the upload directory, define backup retention, and perform a restore drill before the event.

### Medium — Personal data has no stated retention/deletion policy

**Evidence:** student and attempt schema in `db.js:27-108`; exports and student admin routes in `routes/admin.js`; backup guidance in `README.md:105`.

The system retains names, phone numbers, schools, fee claims, answers, and conduct logs. The repository gives no retention period, automated purge, export/deletion request process, or policy for backups. Manual student deletion exists, but no corresponding backup lifecycle is documented.

**Impact:** A database or exported workbook leak exposes student PII and exam behavior; retaining it indefinitely increases impact and creates privacy obligations.

**Fix:** Define purpose and retention for each data class, restrict and protect exports/backups, and test end-to-end deletion including backups where applicable.

### Low/Medium — Anti-cheat controls are client-side signals, not enforcement

**Evidence:** `public/student.js:415-475`; server endpoints `routes/student.js:250-270`.

Fullscreen, focus/visibility, keyboard blocking, and violation reporting run in browser JavaScript. A student controlling the browser can disable or forge those events. The server correctly owns deadlines, attempt state, and grading, but cannot establish that a visibility event was honestly reported.

**Impact:** Warning counts can be avoided or fabricated; results should not treat them as proof of misconduct. This is a design limit of web clients, not a server-side authorization bypass.

**Fix:** Keep these events advisory and pair them with human review. Do not promise that screenshots, second devices, or browser modifications are prevented.

### Low/Medium — Image uploads trust the declared MIME type

**Evidence:** `routes/admin.js:195-203`.

Upload validation checks the data-URL prefix and decoded size, but not the file signature. The upload is admin-authenticated and uses a random filename with a fixed image extension, which limits direct exposure; still, content bytes can disagree with the declared type.

**Impact:** Unexpected content can be stored and served to students/admins as an image, risking broken rendering or browser-specific content handling.

**Fix:** Verify image signatures (and preferably decode/re-encode supported formats) before writing. Keep SVG and active content disallowed.

### Low — Malformed cookie encoding causes avoidable 500 responses

**Evidence:** `lib/common.js:33-41`; global error handler `server.js:64-70`.

`parseCookies()` calls `decodeURIComponent()` without handling malformed percent escapes. A malformed cookie on an authenticated route throws and returns a 500, with an internal error logged.

**Impact:** Repeated malformed requests can create error-log noise and unnecessary 500s, but do not bypass authentication.

**Fix:** Ignore malformed cookie values or return a normal unauthenticated response.

## Edge cases and failure points to cover before launch

- More than 15 students share one public IP during the same 15-minute window.
- Browser storage is disabled/full, an answer request fails, a student submits, or the timer expires while answers are still pending.
- A student changes browsers/devices or re-enters another person's phone number during an active attempt.
- Admin edits options/correct answers/marks or deletes a question after attempts exist; quiz deletion cascades all attempt history.
- Many attempts expire at the same timestamp; process restarts or disk fills during grading/autosave.
- The process is terminated during a SQLite WAL write, uploaded files are absent after restore, or two instances point at separate disks.
- `COOKIE_SECURE` is omitted, proxy trust is misconfigured, or public HTTP remains reachable.
- Imported workbook is unexpectedly large/malformed; question pool growth stresses parsing, synchronous work, and scoring queries.
- Exports and student activity remain in backups after manual deletion.

## Supply chain and verification limits

- `package-lock.json` pins dependency versions and integrity hashes; SheetJS is pinned to an exact CDN tarball in `package.json`.
- `better-sqlite3` has an install script in the lockfile. Setup instructions use plain `npm install`; no package-manager pin, install-script approval policy, CI audit workflow, or release check was found in tracked files.
- `npm audit --omit=dev` could not reach `registry.npmjs.org` (`EAI_AGAIN`), so current known-advisory status is **unverified**. Rerun the native audit from a networked release environment and triage reachable critical/high issues.
- A local HTTP probe could not run because dependencies are not installed (`Cannot find module 'express'`). The production landing page and student entry form were inspected in a browser. Only fabricated values were used in the form and then cleared; no valid registration or quiz action was completed. The live schedule and database warnings are recorded above. Direct API inspection and any dynamic security exploit test were not completed; an HTTP-check agent hit DNS resolution failure, and my direct browser API navigation hit `ERR_NETWORK_CHANGED`. Core code findings remain static source findings; confirm fixes with runtime regression checks before release.
- No deployment manifest, health/readiness endpoint, graceful-shutdown handler, tested restore procedure, or capacity test was found in the tracked project files.

## Recommended release order

1. Replace phone-only student authorization with verified identity and test takeover prevention.
2. Fix answer queue behavior for storage failures and failed saves at manual submit/time-up.
3. Enforce server-side student session expiry; revoke admin sessions on password change.
4. Load-test registration bursts, autosaves, and simultaneous expiry on the target host; set a tested capacity limit and correct proxy/rate-limit configuration.
5. Freeze question content per attempt; define safe edit/delete behavior and admin audit logging.
6. Set Secure cookies/HSTS at production ingress, test complete backups/restores, set PII retention, verify uploads, and complete dependency audit.
