# Derma Medical Event Parser

Automatically scans [dermamedical.co.uk](https://dermamedical.co.uk) every day at **00:00 BST**, detects expired or expiring events, and sends an alert email with screenshots.

## What it does

1. Fetches the homepage and `/events/` page using Puppeteer
2. Extracts all event dates and checks them against today's date (BST)
3. Flags events that are expired or expiring within `WARN_DAYS` days
4. Sends an alert email with a screenshot attached

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `NOTIFY_EMAILS` | Comma-separated recipient emails | *(required)* |
| `SMTP_HOST` | SMTP server host | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username / sender email | *(required)* |
| `SMTP_PASS` | SMTP password or app password | *(required)* |
| `WARN_DAYS` | Days before expiry to warn | `7` |
| `CRON_EXPR` | Cron schedule expression | `0 0 * * *` |

## Deployment (Railway)

1. Connect this GitHub repo in Railway
2. Set the environment variables above in Railway's Variables tab
3. Railway will auto-deploy and the parser runs on schedule

## Local development

```bash
npm install
cp .env.example .env
# edit .env with your values
node index.js
```
