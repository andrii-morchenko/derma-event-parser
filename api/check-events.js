const cheerio = require('cheerio');
const nodemailer = require('nodemailer');

const URLS = [
  'https://dermamedical.co.uk/',
  'https://dermamedical.co.uk/events/'
];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseDates(text) {
  const patterns = [
    /(\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/gi,
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/gi,
    /(\d{4}-\d{2}-\d{2})/g,
    /(\d{1,2}\/\d{1,2}\/\d{4})/g,
    /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})/gi
  ];
  const found = new Set();
  patterns.forEach(p => {
    const matches = text.match(p);
    if (matches) matches.forEach(m => found.add(m.trim()));
  });
  return [...found];
}

function parseDate(str) {
  if (!str) return null;
  const cleaned = str.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function classifyDate(d) {
  if (!d) return 'unknown';
  const now = new Date();
  const warnDays = parseInt(process.env.WARN_DAYS || '7');
  const diffDays = (d - now) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return 'expired';
  if (diffDays <= warnDays) return 'expiring_soon';
  return 'upcoming';
}

async function fetchPage(url) {
  log(`Fetching: ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DermaEventParser/1.0)' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractEvents(html, url) {
  const $ = cheerio.load(html);
  const events = [];

  // Try structured event elements
  $('[class*="tribe-event"], [class*="event-item"], article.type-tribe_events').each((i, el) => {
    const title = $(el).find('[class*="tribe-event-title"], [class*="event-title"], h2, h3, h4').first().text().trim();
    const dateEl = $(el).find('[class*="tribe-event-date"], [class*="datetime"], time, .event-date').first();
    const dateText = dateEl.attr('datetime') || dateEl.text().trim();
    if (title || dateText) {
      events.push({ title: title || `Event ${i + 1}`, dateStr: dateText, source: url });
    }
  });

  // Fallback: <time> tags
  if (events.length === 0) {
    $('time').each((i, el) => {
      const dt = $(el).attr('datetime') || $(el).text().trim();
      const title = $(el).closest('article, section, li, div').find('h1,h2,h3,h4,a').first().text().trim() || `Event ${i + 1}`;
      if (dt) events.push({ title: title.substring(0, 100), dateStr: dt, source: url });
    });
  }

  // Last resort: raw date strings
  if (events.length === 0) {
    const bodyText = $('main, #content, .content, body').text();
    const dates = parseDates(bodyText);
    dates.slice(0, 15).forEach((ds, i) => {
      events.push({ title: `Date reference ${i + 1}`, dateStr: ds, source: url });
    });
  }

  return events.map(e => {
    const date = parseDate(e.dateStr);
    return { ...e, date, status: classifyDate(date) };
  });
}

async function sendEmail(expired, expiringSoon) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const recipients = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

  if (!user || !pass || recipients.length === 0) {
    log('Email not configured, skipping');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user, pass }
  });

  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
  let body = `Derma Medical Event Parser — Alert\nScanned: ${now} BST\n\n`;

  if (expired.length > 0) {
    body += `⚠️ EXPIRED EVENTS (${expired.length}):\n`;
    expired.forEach(e => { body += `  • ${e.title} — ${e.dateStr}\n    ${e.source}\n`; });
    body += '\n';
  }
  if (expiringSoon.length > 0) {
    body += `⏰ EXPIRING SOON (within ${process.env.WARN_DAYS || 7} days):\n`;
    expiringSoon.forEach(e => { body += `  • ${e.title} — ${e.dateStr}\n    ${e.source}\n`; });
    body += '\n';
  }
  body += 'This is an automated alert. Parser runs daily at 00:00 BST.\nhttps://dermamedical.co.uk/events/';

  await transporter.sendMail({
    from: `"Derma Event Parser" <${user}>`,
    to: recipients.join(', '),
    subject: `⚠️ Expired events on dermamedical.co.uk — ${new Date().toLocaleDateString('en-GB')}`,
    text: body
  });

  log(`Email sent to: ${recipients.join(', ')}`);
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  log('=== Starting event check ===');
  const allExpired = [];
  const allExpiringSoon = [];
  const summary = [];

  try {
    for (const url of URLS) {
      const html = await fetchPage(url);
      const events = extractEvents(html, url);
      const expired = events.filter(e => e.status === 'expired');
      const expiringSoon = events.filter(e => e.status === 'expiring_soon');
      const upcoming = events.filter(e => e.status === 'upcoming');

      allExpired.push(...expired);
      allExpiringSoon.push(...expiringSoon);
      summary.push({ url, total: events.length, expired: expired.length, expiringSoon: expiringSoon.length, upcoming: upcoming.length, events: events.slice(0, 20) });
      log(`${url}: ${events.length} events, ${expired.length} expired, ${expiringSoon.length} expiring soon`);
    }

    let emailSent = false;
    if (allExpired.length > 0 || allExpiringSoon.length > 0) {
      emailSent = await sendEmail(allExpired, allExpiringSoon);
    } else {
      log('All events current — no alert needed');
    }

    log('=== Check complete ===');
    return res.status(200).json({
      ok: true,
      scannedAt: new Date().toISOString(),
      totalExpired: allExpired.length,
      totalExpiringSoon: allExpiringSoon.length,
      emailSent,
      pages: summary
    });

  } catch (err) {
    log(`Error: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
