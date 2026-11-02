# Grade Calculator

A small web app for students. Add your subjects, list each graded component (quizzes, midterm, final…) with its weight, and enter scores as you get them. It shows your **current grade** and tells you **what average you need on the rest** to hit your target.

<!-- Add a screenshot here: ![Grade Calculator screenshot](docs/screenshot.png) -->

## Features

- Multiple subjects, each with its own target grade
- Weighted components with scores and custom "out of" values (e.g. 45/50)
- Live results: current grade, best possible grade, how much of the grade is done
- "What do I need?" calculator: the average required on ungraded work to reach your target, or a clear message if the target is already secured or out of reach
- Warns when your weights don't add up to 100%
- View grades as a percentage, US letter/GPA (4.0), or a 1.0–5.0 scale (preference is remembered)
- Accounts: sign up and log in, and each student sees only their own subjects
- Edits save automatically; data is stored in a local SQLite file
- Light and dark mode, works on phone screens

## Tech stack

| Part      | Choice                                         |
| --------- | ---------------------------------------------- |
| Front end | HTML, CSS, vanilla JavaScript                  |
| Back end  | Node.js (built-in `http` module, REST API)     |
| Database  | SQLite via Node's built-in `node:sqlite`       |
| Tests     | Node's built-in test runner                    |

There are **no npm dependencies**, so there is nothing to install.

## Getting started

Requires **Node.js 22.13 or newer**.

```bash
git clone <your-repo-url>
cd grade-calculator
npm start
```

Then open <http://localhost:3000>. Set a different port with `PORT=8080 npm start`.

## Running the tests

```bash
npm test
```

## How the math works

Each component has a weight `w` (percent of the final grade) and a score `s` out of `m`.

- Points earned so far: `earned = Σ w × (s / m)` over graded components
- Current grade: `earned / gradedWeight × 100`
- Needed on the rest: `(target / 100 × totalWeight − earned) / remainingWeight × 100`

If the needed average is 0 or less, the target is secured. If it is over 100, it's out of reach. The logic lives in [`public/calc.js`](public/calc.js) and is covered by unit tests.

> The 1.0–5.0 conversion table is one common example. Schools differ, so edit `PH_SCALE` in `public/calc.js` to match yours.

## API

Account endpoints:

| Method | Endpoint             | Description                                         |
| ------ | -------------------- | --------------------------------------------------- |
| POST   | `/api/register`      | Create an account and log in `{ username, password }` |
| POST   | `/api/login`         | Log in `{ username, password }`                     |
| POST   | `/api/logout`        | Log out (ends the session on the server)            |
| GET    | `/api/me`            | The logged-in user, or 401                          |

Every `/api/subjects` and `/api/components` endpoint below needs a logged-in session and only ever touches that user's own data.

| Method | Endpoint                          | Description                          |
| ------ | --------------------------------- | ------------------------------------ |
| GET    | `/api/subjects`                   | List subjects with their components  |
| POST   | `/api/subjects`                   | Create a subject `{ name, target }`  |
| PUT    | `/api/subjects/:id`               | Update name and/or target            |
| DELETE | `/api/subjects/:id`               | Delete a subject and its components  |
| POST   | `/api/subjects/:id/components`    | Add `{ name, weight, score, maxScore }` |
| PUT    | `/api/components/:id`             | Update a component                   |
| DELETE | `/api/components/:id`             | Delete a component                   |

## Accounts and security

- Passwords are hashed with scrypt and a random salt per user. The plain password is never stored.
- Login sets a random session token in an `HttpOnly`, `SameSite=Lax` cookie (30 days). Only a SHA-256 hash of the token is stored in the database, and logging out deletes it.
- The cookie gets the `Secure` flag automatically when the app is served over HTTPS.
- Every database query is scoped to the logged-in user, so one student can't read or change another's data. This is covered by tests.
- Repeated failed logins for the same username and IP are temporarily blocked, and account creation is limited per IP.
- Wrong username and wrong password give the same error message.

If you ran an earlier version without accounts, its old subjects don't belong to any account and stay hidden. Delete `data.db` to start fresh.

### Deploying

- Use a host with a persistent disk, since the SQLite file (`data.db`) has to survive restarts. Set `DB_PATH` to a path on that disk.
- Serve it over HTTPS (most hosts do this for you).
- Behind a reverse proxy, set `TRUST_PROXY=1` so rate limiting sees each visitor's real IP.

## Project structure

```
grade-calculator/
├── server.js        # HTTP server, REST routes, static files
├── db.js            # SQLite setup and schema
├── public/
│   ├── index.html
│   ├── style.css
│   ├── calc.js      # grade math (shared with tests)
│   └── app.js       # UI and API calls
└── test/
    ├── calc.test.js
    └── api.test.js
```

## Ideas for next steps

- Change password and delete account
- Export to CSV / print view
- Semester GPA across all subjects, with credit units
- Drop-the-lowest-quiz rules
- Deploy it (Render, Railway, or Fly.io all work with a Node app)
