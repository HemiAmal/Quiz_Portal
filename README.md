# Aaroh Quiz

A secure online quiz portal for the Aaroh Space & Tech Quiz. Students use it in a phone or laptop browser with no app to install. Organisers run everything from a hidden admin panel.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-password' npm start
```

On Windows PowerShell: `$env:ADMIN_PASSWORD='choose-a-strong-password'; npm start`

The first start prints two things. Keep both private:

- the **admin panel address**, e.g. `http://localhost:3000/control-3f9a1c2b7d4e/`
- the admin username (`admin`) and, if you didn't set `ADMIN_PASSWORD`, a generated password

Students open `http://localhost:3000/`. Nothing on the student side links to the admin panel, and `/admin` returns "Not found".

## Landing page images

The landing page uses two images from `public/img/`:

- `bg.png`: the full-screen background
- `iiitk-logo.png`: the IIIT Kottayam logo shown in the top-left corner

Replace either file to change it. If one is missing, the page still works (plain space background, no logo).

## How students take the quiz

1. The landing page has one **Start quiz** button. There is no spot registration.
2. The student enters their **name, mobile number and school**, and answers **"Did you pay the ₹50 registration fee?"** (Yes/No). Nobody is blocked on that answer. It is saved so you can compare it with your paid list after the quiz.
3. Entering the details creates the student's **profile**. Each mobile number can take the quiz **only once**. If the phone dies mid-quiz, entering the same details again resumes the same attempt (and the admin sees "Logged in on another device").
4. The student waits in the lobby until the opening time, then starts. Questions are a random set, in random order, for each student.
5. During the quiz: a numbered tab at the top jumps to any question, **Previous / Save & next** move between questions, each answer is saved as soon as it's chosen, and questions can be **marked for review**. The timer turns **red in the last 5 minutes**.
6. The student can **submit early**. Otherwise the quiz auto-submits when their time runs out or at the closing time, whichever comes first.
7. Students never see their score or which answers were right or wrong.

## Setting the time window

In **Quizzes → New quiz** set **Opens at**, **Duration** and **Closes at**. Example: opens 7:00 PM, duration 60 minutes, closes 8:30 PM.

- A student who starts at 7:00 gets the full hour (until 8:00).
- A student who starts late, say 7:50, gets only until 8:30.
- At 8:30 every unfinished quiz is submitted automatically, even if the student closed the page.

## Quiz-day checklist

1. **Quizzes → New quiz.** Set the times as above, how many questions each student gets, and the number of app/tab switches that triggers auto-submit (0 = never). Tick **Published**.
2. **Questions → Bulk upload.** Use **Download Excel template**, or start from `sample-questions.csv` (20 Space & Tech questions). You can also add questions one by one, with images.
3. Share the student link.
4. **Students** lists every profile as it is created, with status **Waiting** (entered details, not started), **Doing** (taking the quiz) or **Completed** (submitted). It refreshes every 5 seconds. Click a name to see their right, wrong, unanswered and flagged questions.
5. **Live** shows who is taking the quiz, how far they've got, their time left and any warnings.
6. Afterwards, **Results** ranks students by score (ties go to whoever finished faster). **Export all** / **Export shortlist** and **Students → Export Excel** download Excel files with name, mobile, school, the paid answer, score, right, wrong, unanswered, flagged and times.

## Anti-cheating measures

| Measure | How it works |
|---|---|
| One attempt per mobile number | A number that has submitted cannot enter again |
| One device at a time | Entering the same details on another device logs out the first one and records "Logged in on another device" |
| App/tab switch detection | Each switch shows a warning and is logged. After the limit you set, the quiz auto-submits |
| Full screen on laptops | Leaving full screen counts as a switch (phones can't be forced into full screen) |
| Shuffled questions and options | Every student gets a different order, so "Q5 is B" is useless |
| Random subset | e.g. 30 questions per student from a pool of 60 |
| Answers checked on the server | Correct answers never reach the student's device |
| Server-controlled timer | Changing the phone clock or reloading doesn't add time. Unfinished attempts auto-submit at the deadline even if the page is closed |
| Copy/paste/right-click blocked | Attempts are logged. Printing the page shows nothing |
| Name watermark | The student's name and mobile number are faintly tiled over the quiz, so a leaked screenshot shows who took it |

**Limits:** no website can fully block screenshots or stop a student using a second phone or getting help from someone nearby. These measures deter cheating and flag it for you to review. They can't guarantee zero cheating. On some phones, pulling down the notification bar or an incoming call also counts as leaving the screen, so a limit of 3 or more is kinder than 1.

## Admin features

- Dashboard with profile counts, how many said they paid, and who is doing or has completed the quiz
- Quizzes with opening time, duration and closing time
- Question bank per quiz with categories, difficulty, marks and images, plus Excel/CSV bulk upload
- Students: live status, per-student answer details, block, delete (lets that number start again), export to Excel
- Settings: rename the portal, change password
- **Allow retake** (in a student's Details) deletes their attempt if they had a genuine technical problem

## Putting it online

The app stores everything in Postgres, so it runs on Vercel.

1. Push the project to GitHub and import the repo in Vercel. `vercel.json` already sets the routing, so leave the build settings empty.
2. In the project's **Storage** tab, create a Postgres (Neon) database and connect it to the project. That adds `POSTGRES_URL` for you.
3. In **Settings → Environment Variables**, add the variables below, then redeploy.

| Variable | Purpose |
|---|---|
| `ADMIN_USER` | Username for the first admin (default `admin`). Only used when the database has no admin yet |
| `ADMIN_PASSWORD` | Password for the first admin. Only used when the database has no admin yet |
| `ADMIN_PATH` | Secret admin path, e.g. `/control-a8f3k2`. Set it, otherwise you have to read the generated one from the logs |
| `CRON_SECRET` | Any random string; protects the scheduled clean-up endpoint |

Optional: connect a **Blob** store as well and question images go there (`BLOB_READ_WRITE_TOKEN`). Without it they are kept in the database, which is fine for a quiz's worth of pictures.

Secure cookies and the proxy setting are switched on automatically on Vercel.

**Bringing existing data along.** To copy the quizzes, questions, students and admin account from an older `data/aaroh.db` into the hosted database, run this once on your computer with the connection string from the database's page in Vercel (the pooled one):

```powershell
$env:POSTGRES_URL='postgres://...'; node scripts/import-sqlite.js
```

**On your own machine** nothing needs setting: `npm start` uses a built-in local Postgres (PGlite) that keeps its files in `data/pg`. Set `POSTGRES_URL` only if you want your machine to use the hosted database.

Attempts whose time has run out are submitted the next time that student's page talks to the server, and whenever an organiser opens any page of the admin panel. A daily scheduled job catches the rest.

## Project layout

```
server.js          app setup, security headers, secret admin path
db.js              Postgres schema and query helpers
lib/common.js      passwords, codes, rate limits, grading
routes/student.js  student API (enter details, quiz, autosave, warnings)
routes/admin.js    admin API
public/            student website (public/img has the landing images)
admin/             admin panel
```
