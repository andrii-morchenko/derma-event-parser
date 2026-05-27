# Derma Medical Event Parser

Serverless function deployed on Vercel that scans [dermamedical.co.uk](https://dermamedical.co.uk) daily at **00:00 BST**, detects expired or expiring events, and sends alert emails.

## How it works

- Vercel Cron Job triggers `/api/check-events` at `0 23 * * *` UTC (= 00:00 BST)
- Fetches homepage and `/events/` page, extracts event dates
- Sends alert email via SMTP if any expired or expiring-soon events are found
- Manual trigger: `GET /api/check-events`

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `NOTIFY_EMAILS` | Comma-separated recipients | *(required)* |
| `SMTP_HOST` | SMTP host | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username | *(required)* |
| `SMTP_PASS` | SMTP password / app password | *(required)* |
| `WARN_DAYS` | Days before expiry to warn | `7` |
| `CRON_SECRET` | Optional secret to protect the endpoint | — |
