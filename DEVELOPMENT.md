# Development notes

Notes for continuing work on the Aaroh Quiz portal: how to run it and the decisions already made. See README.md for the full feature list and deployment.

## Run locally

Needs Node.js 18+ (tested on Node 24).

```powershell
npm install
$env:PORT=3100; npm start
```

- Student site: `http://localhost:3100`
- Admin panel: the secret address printed at startup (stored in the database, so it stays the same across restarts)
- The first start creates the `admin` account. Set `$env:ADMIN_PASSWORD='...'` before the very first start to choose the password; otherwise a random one is printed once.
- The database is Postgres. Locally it is PGlite (a Postgres engine inside Node, files in `data/pg`); on Vercel it is the connected Neon database (`POSTGRES_URL`). Same SQL for both. Deleting `data/pg` resets the local copy (quizzes, students, admin account, admin path).
- `data/aaroh.db` is the old SQLite file from before the move to Vercel. `node scripts/import-sqlite.js` copies it into whichever Postgres is configured.
- **Vercel has no disk and no background timer**, so: question images are stored in the database (or Vercel Blob if connected), rate limits are counted in the database, and overdue quizzes are auto-submitted on the student's next request and on any admin request (plus a daily cron) rather than by a 15-second timer. Locally the 15-second timer still runs.
- There is no build step and no auto-reload: after changing server files (`server.js`, `db.js`, `lib/`, `routes/`), stop and start the server again. Changes to `public/` and `admin/` only need a browser refresh (Ctrl+F5, static files are cached for 1 hour).

## Code map

| Path | What it does |
|---|---|
| `server.js` | Express setup, security headers, secret admin path, first admin account |
| `db.js` | Postgres connection (hosted or local PGlite), query helpers, schema (created on start with `CREATE TABLE IF NOT EXISTS`) |
| `api/index.js`, `vercel.json` | Vercel entry point and routing |
| `scripts/import-sqlite.js` | One-time copy of the old SQLite data into Postgres |
| `lib/common.js` | Password hashing, cookies, rate limits, grading (`finalizeAttempt`), auto-submit sweep |
| `routes/student.js` | Student API: enter details, lobby, start, questions, autosave, warnings, submit |
| `routes/admin.js` | Admin API: quizzes, questions, students, live monitor, results, attempt details |
| `public/` | Student site (`index.html`, `student.js`, `student.css`, `img/` landing images) |
| `admin/` | Admin panel (`index.html`, `admin.js`, `admin.css`) |

Plain HTML/CSS/JavaScript on the front end (no framework). SheetJS (`xlsx` package) is served to the admin panel only, for Excel import/export.

## Decisions already made (keep unless the organisers change them)

- **No spot registration. Approved list of paid students.** Admin → Approved list takes an Excel/CSV of Name, Mobile, School. When the list has any numbers, only those mobiles can enter ("This number is not registered. Contact the organisers."); while it is empty, anyone can. Students still answer "Did you pay the ₹50 fee?" (Yes/No), which never blocks on its own.
- **One quiz per mobile number, in total.** A number that has submitted any quiz can't enter again or start another one. Re-entering while a quiz is in progress resumes it and logs "Logged in on another device". Admin can delete a student (or use "Allow retake") to let them start again.
- **Profile = created when the student enters details.** Status shown to admin: Waiting (not started), Doing (in progress), Completed (submitted).
- **Time window:** opens at the start time; each student gets `duration` minutes but never past the closing time. Everything unfinished auto-submits at the closing time, even if the page is closed (server sweep every 15 s).
- **Students never see marks, right/wrong answers or results.** Correct answers never leave the server.
- **Quiz screen:** numbered question tab, Previous / Save & next, autosave on every choice, mark for review ("flagged"), timer turns red in the last 5 minutes, submit any time.
- **Admin sees per student:** score, right, wrong, unanswered, flagged, each question with their answer and the correct one, and the activity (anti-cheat) log. Excel exports include name, mobile, school, paid answer and all counts.
- **Landing page:** full-screen `public/img/bg2.png`, transparent IIIT Kottayam logo `public/img/iiitk-logo.png` in the top-left corner, one Login button.
- **Look:** student site and admin panel share one minimal palette: black surfaces, a single yellow accent (`#ffcc00`), off-white text, grey secondary text. No gradients or decorative animation. The Aaroh logo (`public/img/aaroh-logo.png`, white on transparent) sits in the top-right corner of every page. Question tab: filled yellow = answered, orange ring = marked for review.
- **Cache busting:** CSS/JS are cached for 1 hour, so bump the `?v=` number on their links in `public/index.html` and `admin/index.html` after changing them.

## Testing a change quickly

1. Admin panel → Quizzes → New quiz with "Opens at" a minute from now and a short window; tick Published.
2. Questions → Bulk upload `sample-questions.csv`.
3. Open the student site in another browser (or a private window), enter test details, take the quiz.
4. Check Students, Live and Results in the admin panel, then delete the test quiz and test students.
