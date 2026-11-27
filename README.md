# The December Correspondent

The ETN Christmas edition for December 2026, with desks in the UK, Cebu and Sydney. It runs as one Node service on Railway, backed by PostgreSQL.

## Running it
- **Live:** https://web-production-662343a2.up.railway.app
- **Railway variables:** `DATABASE_URL`, `SESSION_SECRET`, `PUBLIC_ORIGIN`, `NODE_ENV=production`, `PORT`, `EDITOR_EMAIL`, `EDITOR_NAME`, `EDITOR_ZONE`
- **On start:** migrations run, then an idempotent seed loads `data/calendar.csv` and creates the editor from `EDITOR_EMAIL`.
- **Health check:** `/healthz`

### Commands
Run these with `railway run`, or locally against a database.
```
node src/cli.js invite <email>      # a fresh one-time invitation link
node src/cli.js seed --overwrite    # reload calendar.csv, replacing doors edited on the desk
node src/cli.js rehearsal           # three fictional readers, an editor and a sample letter
node src/cli.js purge --yes         # 31 January: delete all personal data
```

## The editor's day
Go to **Editor's desk** on the site. From there you can:
- import readers by pasting the contents of `team.csv`, and issue each person their own invitation link
- add letters one at a time, or paste in `letters.csv`
- collect Christmas song requests (door 14 to 22) and paste the playlist link for door 24
- review contributions (relay lines on doors 3, 17 and 21 publish straight away; you can unpublish them)
- draw names after 09:00 UTC on 8 December
- add reserve parcels for anyone whose giver drops out

Never commit the real roster or real letters. Paste them into the desk instead.

## Rules the code enforces
- Each door opens at 07:00 local time for the reader's zone (Europe/London, Asia/Manila or Australia/Sydney), worked out on the server. Text from doors that haven't opened never leaves the server.
- An invitation link carries its token after the `#`, so the token isn't sent in the request or written to logs. Redeeming it needs a button press, it works once, and it can be replaced. Only token digests are stored.
- Personal pages are sent `no-store`, every form is checked for CSRF, all contributed text is escaped, and only https links are accepted. A link always shows where it goes before anyone opens it.
- Reading habits are never recorded: there are no read receipts, streaks or attendance figures.

## Tests
`npm test` runs the rehearsal from `data/build.md` against a throwaway local Postgres, using a test clock. The clock override is refused when `NODE_ENV=production`.
