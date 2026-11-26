# Jira Worklogs

Turns a monthly JaTT timesheet export into Jira worklogs. You load the month, assign hours and texts to issues in one grid, review, and post everything in one go.

It is a small local web app with one dependency (`xlsx`) and no link to the JaTT code base, so it can be checked out on its own.

## Setup

Requires Node 20.6 or newer.

```bash
npm install
cp .env.example .env   # then set JIRA_URL and JIRA_PAT
npm start              # opens on http://localhost:5199
```

Create the PAT in Jira Data Center under *Profile → Personal Access Tokens*. It stays in `.env` on your machine. The browser only talks to the local server, which calls Jira.

To try it without a Jira, run `npm run mock`. It serves a fake Jira with a handful of DEMO issues and posts nothing anywhere. A worklog text containing `FAIL` makes the mock reject that worklog, so you can see how errors look.

## Monthly flow

1. **Export** the month from JaTT as Excel (the normal monthly report).
2. **Load** it: drop the `.xlsx` on the page and click *Open* on the position's sheet.
3. **Pick the issues** for the month: *Show assigned to me* lists everything assigned to you. *Find* takes an issue key or a search text for issues you aren't assigned to. Star an issue to pin it, and it's added automatically every month for that position.
4. **Fill the grid.** Days are rows, issues are columns.
   - Type hours as `1.5`, `1:30` or `1h 30m`.
   - Press **Enter in an empty cell**, or hover and click **⇥**, to book the rest of the day there.
   - **↑ copy** reuses the previous day's split, scaled to this day's hours. **÷** splits evenly across the issues that already have hours. **×** clears the day.
   - **Fill empty days with…** puts every day that has no hours yet onto one issue.
   - **Reset grid** starts the month over: it removes all unposted hours, texts and issue columns, then adds pinned issues and applies rules again. Worklogs already posted to Jira are kept.
   - The *Booked* column turns orange when a day doesn't add up to the JaTT hours.
   - Click a day's date to open it in the day-by-day view. A ✓ marks days you've saved there.
5. **Or go day by day.** *Day by day ▸* starts at the first day you haven't reviewed that doesn't add up. Each day shows its JaTT description and one already-open row per comma-separated part, e.g. *Format anpassungen, Betrieb, Vault Migration* gives three rows.
   - Each row has an issue (pre-selected when a mapping rule matches), hours (the unbooked time split evenly) and the part as its text, ready to extend. Snippets for the row's issue appear as buttons below it.
   - **⇥ rest** gives a row the hours that are left. *+ Add row* adds another booking, and *＋ other issue…* in the issue list adds an issue by key.
   - If you pick an issue for a part that no rule matched, **remember** is ticked, with the part as the pattern (you can edit it, e.g. `daily|planning`). Saving adds it as a mapping rule, so the next days are pre-mapped.
   - **Ctrl+Enter** saves and moves to the next day. The numbered buttons at the top jump to a day: green when it adds up, orange when it doesn't, filled when reviewed.
   - Existing bookings (from recurring entries, rules or the grid) show up as rows too. On days you haven't reviewed yet, parts that no booking's text mentions are added as extra rows.
6. **Write the texts.** Click **✎** next to a cell. The text starts with the description parts that belong to that issue (by mapping rule), or the whole description if no rule applies. Extend it, or insert a **snippet** you saved for that issue earlier. A blue ✎ means you changed the text.
7. **Review & post.** It shows hours per issue and the days that don't match JaTT, then creates one Jira worklog per cell. Each worklog starts at 09:00 on its day (`WORKLOG_START` changes the time).

Posted cells are locked and remembered. If some posts fail, fix the red cells and post again; the ones already posted are skipped.

## Mapping rules

Rules map JaTT descriptions to issues, so next month starts pre-filled. Add one from the cell editor: *Text contains `daily|standup|planning` → DEMO-110*.

When a month is opened for the first time, each comma-separated part of a day's description goes to the first rule it matches. If a day matches several issues, its hours are split evenly. *Mapping rules* lets you edit, reorder and delete rules. *Apply rules to empty days* runs them again on days that have no hours yet, or only recurring bookings.

## Recurring bookings

Use these for fixed slots such as a daily standup. *Recurring* in the toolbar sets, for each position: issue, hours, worklog text and weekdays (for example *DEMO-110, 0.25 h, "Daily standup", Mo–Fr except We*).

They are booked on every selected weekday that has JaTT hours, so days you didn't work are skipped. A booking is never larger than the time still free that day. They are applied automatically when a month is opened for the first time or reset, **before** the mapping rules. The rules then split only the remaining time, and a rule pointing at the same issue is skipped that day because the recurring booking covers it. *Apply to this month* in the dialog adds them to a month you've already started, skipping days that have hours on that issue.

## Where things are stored

Everything lives in `data/`, which git ignores:

- `data/config.json`: pinned issues and rules for each position, plus snippets for each issue.
- `data/drafts/<month>__<position>.json`: the grid for each month, including the Jira IDs of posted worklogs.

Re-opening the same month and position continues the draft. If you load a newer export, the JaTT hours and descriptions are refreshed and your bookings are kept.

## Settings (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `JIRA_URL` | (required) | Jira Data Center base URL |
| `JIRA_PAT` | (required) | Personal Access Token |
| `JIRA_ASSIGNED_JQL` | `assignee = currentUser() ORDER BY updated DESC` | Which issues *assigned to me* lists (up to 200) |
| `WORKLOG_START` | `09:00` | Start time used for every worklog |
| `PORT` | `5199` | Local port |
| `DATA_DIR` | `./data` | Where drafts and settings are stored |

## Development

`npm test` runs the Node tests. `test/fixtures/jatt-export.xlsx` is a real JaTT export. `lib/timesheet.js` is a port of JaTT's `src/utils/excelImport.ts`. If the JaTT export layout changes, update both.
