const cron = require('node-cron');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');
const fs = require('fs');

const CONFIG = {
  urls: [
    'https://dermamedical.co.uk/',
    'https://dermamedical.co.uk/events/'
  ],
  recipients: (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean),
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  },
  warnDays: parseInt(process.env.WARN_DAYS || '7'),
  timezone: 'Europe/London'
};

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function parseDates(text) {
  const patterns = [
    /(\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/gi,
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/gi,
    /(\d{4}-\d{2}-\d{2})/g,
    /(\d{1,2}\/\d{1,2}\/\d{4})/g,
    /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/gi
  ];
  const found = new Set();
  patterns.forEach(p => {
    const matches = text.match(p);
    if (matches) matches.forEach(m => found.add(m.trim()));
  });
  return [...found];
}

function parseDate(str) {
  const cleaned = str.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function classifyDate(d) {
  if (!d) return 'unknown';
  const now = new Date();
  const diffDays = (d - now) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return 'expired';
  if (diffDays <= CONFIG.warnDays) return 'expiring_soon';
  return 'upcoming';
}

function extractEventItems($) {
  const events = [];
  // Try The Events Calendar / tribe plugin structure
  $('[class*="tribe-event"], [class*="event-item"], article.type-tribe_events').each((i, el) => {
    const title = $(el).find('[class*="tribe-event-title"], h2, h3, .event-title').first().text().trim();
    const dateText = $(el).find('[class*="tribe-event-date"], [class*="datetime"], time, .event-date').first().text().trim()
      || $(el).find('[datetime]').attr('datetime') || '';
    if (title || dateText) events.push({ title: title || 'Event ' + (i + 1), dateText });
  });
  // Fallback: look for <time> elements
  if (events.length === 0) {
    $('time').each((i, el) => {
      const dt = $(el).attr('datetime') || $(el).text().trim();
      const title = $(el).closest('article, li, div').find('h1,h2,h3,h4').first().text().trim() || 'Event';
      if (dt) events.push({ title, dateText: dt });
    });
  }
  return events;
}

async function scanPage(browser, url) {
  log(`Scanning: ${url}`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (compatible; DermaEventParser/1.0)');
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch (e) {
    log(`Warning loading ${url}: ${e.message}`);
  }

  const html = await page.content();
  const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
  await page.close();

  const $ = cheerio.load(html);
  const bodyText = $('body').text();
  const structuredEvents = extractEventItems($);
  const allDateStrings = parseDates(bodyText);

  const results = [];

  if (structuredEvents.length > 0) {
    structuredEvents.forEach(ev => {
      const d = parseDate(ev.dateText);
      const status = classifyDate(d);
      results.push({ title: ev.title, dateStr: ev.dateText, date: d, status, source: url });
    });
  } else {
    allDateStrings.slice(0, 20).forEach((ds, i) => {
      const d = parseDate(ds);
      const status = classifyDate(d);
      results.push({ title: `Date reference ${i + 1}`, dateStr: ds, date: d, status, source: url });
    });
  }

  log(`  Found ${results.length} events/dates on ${url}`);
  return { url, events: results, screenshot };
}

async function sendAlert(expired, expiringSoon, screenshots) {
  if (!CONFIG.smtp.user || !CONFIG.smtp.pass) {
    log('SMTP not configured — skipping email');
    return;
  }
  if (CONFIG.recipients.length === 0) {
    log('No recipients configured — skipping email');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: CONFIG.smtp.host,
    port: CONFIG.smtp.port,
    secure: CONFIG.smtp.port === 465,
    auth: { user: CONFIG.smtp.user, pass: CONFIG.smtp.pass }
  });

  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
  let body = `Derma Medical Event Parser — Alert\nScanned at: ${now} BST\n\n`;

  if (expired.length > 0) {
    body += `⚠️  EXPIRED EVENTS (${expired.length}):\n`;
    expired.forEach(e => { body += `  • ${e.title} — ${e.dateStr} [${e.source}]\n`; });
    body += '\n';
  }
  if (expiringSoon.length > 0) {
    body += `⏰  EXPIRING SOON within ${CONFIG.warnDays} days (${expiringSoon.length}):\n`;
    expiringSoon.forEach(e => { body += `  • ${e.title} — ${e.dateStr} [${e.source}]\n`; });
    body += '\n';
  }
  body += 'Screenshots attached.\n\nThis is an automated alert. Parser runs daily at 00:00 BST.';

  const attachments = screenshots.map((s, i) => ({
    filename: `screenshot-${i + 1}.png`,
    content: Buffer.from(s, 'base64'),
    contentType: 'image/png'
  }));

  try {
    await transporter.sendMail({
      from: `"Derma Event Parser" <${CONFIG.smtp.user}>`,
      to: CONFIG.recipients.join(', '),
      subject: `⚠️ Expired events on dermamedical.co.uk — ${new Date().toLocaleDateString('en-GB')}`,
      text: body,
      attachments
    });
    log(`Alert email sent to: ${CONFIG.recipients.join(', ')}`);
  } catch (e) {
    log(`Email send failed: ${e.message}`);
  }
}

async function runCheck() {
  log('=== Starting event check ===');
  let browser;
  try {
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ],
      headless: 'new'
    });

    const allExpired = [];
    const allExpiringSoon = [];
    const screenshots = [];

    for (const url of CONFIG.urls) {
      const { events, screenshot } = await scanPage(browser, url);
      const expired = events.filter(e => e.status === 'expired');
      const expiringSoon = events.filter(e => e.status === 'expiring_soon');
      allExpired.push(...expired);
      allExpiringSoon.push(...expiringSoon);
      if (expired.length > 0 || expiringSoon.length > 0) {
        screenshots.push(screenshot);
      }
      log(`  Expired: ${expired.length}, Expiring soon: ${expiringSoon.length}`);
    }

    if (allExpired.length > 0 || allExpiringSoon.length > 0) {
      log(`Action needed: ${allExpired.length} expired, ${allExpiringSoon.length} expiring soon`);
      await sendAlert(allExpired, allExpiringSoon, screenshots);
    } else {
      log('All events are current — no alert needed');
    }
  } catch (e) {
    log(`Error during check: ${e.message}`);
  } finally {
    if (browser) await browser.close();
  }
  log('=== Check complete ===');
}

// Schedule: 00:00 BST = 23:00 UTC (standard time) / 23:00 UTC in summer (BST = UTC+1)
// We use TZ=Europe/London and run at midnight in that zone
const cronExpr = process.env.CRON_EXPR || '0 0 * * *';
log(`Derma Medical Event Parser starting...`);
log(`Scheduled: ${cronExpr} (${CONFIG.timezone})`);
log(`URLs: ${CONFIG.urls.join(', ')}`);
log(`Recipients: ${CONFIG.recipients.join(', ') || '(none configured)'}`);

cron.schedule(cronExpr, () => {
  log('Cron triggered');
  runCheck();
}, { timezone: CONFIG.timezone });

// Run immediately on startup
runCheck();
