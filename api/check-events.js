const cheerio = require('cheerio');

const URLS = [
  'https://dermamedical.co.uk/',
  'https://dermamedical.co.uk/events/'
];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

function parseDates(text) {
  const patterns = [
    new RegExp(`(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_NAMES})\\s+\\d{4})`, 'gi'),
    new RegExp(`((?:${MONTH_NAMES})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s*\\d{4})`, 'gi'),
    /(\d{4}-\d{2}-\d{2})/g,
    /(\d{1,2}\/\d{1,2}\/\d{4})/g,
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

// Try to find a meaningful title near a date string in the HTML
function findTitleNearDate(html, dateStr) {
  // Look for the date in context and grab nearby heading text
  const idx = html.indexOf(dateStr);
  if (idx === -1) return null;
  // Look back up to 600 chars for a heading or link text
  const before = html.substring(Math.max(0, idx - 600), idx);
  // Extract last heading or anchor text before the date
  const headingMatch = before.match(/(?:<h[1-6][^>]*>|<a[^>]*>)([\s\S]*?)(?:<\/h[1-6]>|<\/a>)/gi);
  if (headingMatch && headingMatch.length > 0) {
    const last = headingMatch[headingMatch.length - 1];
    const text = last.replace(/<[^>]+>/g, '').trim();
    if (text && text.length > 3 && text.length < 120) return text;
  }
  return null;
}

function extractEvents(html, url) {
  const $ = cheerio.load(html);
  const events = [];

  // 1. Try The Events Calendar / tribe plugin structure
  $('[class*="tribe-event"], article.type-tribe_events, .tribe_events_cat').each((i, el) => {
    const title = $(el).find('[class*="tribe-event-title"], h1, h2, h3').first().text().trim();
    const dateEl = $(el).find('[class*="tribe-event-date"], time, [class*="datetime"]').first();
    const dateText = dateEl.attr('datetime') || dateEl.text().trim();
    if (title || dateText) events.push({ title: title || null, dateStr: dateText, source: url });
  });

  // 2. Try WooCommerce / general product/event cards
  if (events.length === 0) {
    $('article, .elementor-post, .event, .product').each((i, el) => {
      const title = $(el).find('h1, h2, h3, h4, .title, .entry-title').first().text().trim();
      const dateEl = $(el).find('time, [class*="date"]').first();
      const dateText = dateEl.attr('datetime') || dateEl.text().trim();
      const dates = parseDates($(el).text());
      if (dates.length > 0) {
        events.push({ title: title || null, dateStr: dates[0], source: url });
      }
    });
  }

  // 3. Fallback: find all dates in page text, look for nearby title in HTML
  if (events.length === 0) {
    const bodyText = $('body').text();
    const dates = parseDates(bodyText);
    dates.slice(0, 20).forEach(ds => {
      const nearbyTitle = findTitleNearDate(html, ds);
      events.push({ title: nearbyTitle, dateStr: ds, source: url });
    });
  }

  // Build final event list with smart labels
  return events
    .filter(e => e.dateStr)
    .map(e => {
      const date = parseDate(e.dateStr);
      const status = classifyDate(date);
      // Format: use found title, or build a clean label from the date itself
      const label = e.title && e.title.length > 3
        ? e.title
        : `Event — ${e.dateStr}`;
      return { title: label, dateStr: e.dateStr, date, status, source: url };
    });
}

async function sendEmail(expired, expiringSoon) {
  const apiKey = process.env.RESEND_API_KEY;
  const recipients = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

  if (!apiKey || recipients.length === 0) {
    log('Resend not configured, skipping email');
    return false;
  }

  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });

  let html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#c0392b;margin-bottom:4px">⚠️ Derma Medical — Event Alert</h2>
      <p style="color:#666;margin-top:0">Scanned at ${now} BST</p>
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
  `;

  if (expired.length > 0) {
    html += `<h3 style="color:#c0392b">Expired events (${expired.length})</h3><ul>`;
    expired.forEach(e => {
      html += `<li style="margin-bottom:8px"><strong>${e.title}</strong><br>
        <span style="color:#999;font-size:13px">${e.dateStr} · <a href="${e.source}">${e.source}</a></span></li>`;
    });
    html += '</ul>';
  }

  if (expiringSoon.length > 0) {
    html += `<h3 style="color:#e67e22">Expiring soon (${expiringSoon.length})</h3><ul>`;
    expiringSoon.forEach(e => {
      html += `<li style="margin-bottom:8px"><strong>${e.title}</strong><br>
        <span style="color:#999;font-size:13px">${e.dateStr} · <a href="${e.source}">${e.source}</a></span></li>`;
    });
    html += '</ul>';
  }

  html += `
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
      <p style="color:#aaa;font-size:12px">Automated alert · runs daily at 00:00 BST · 
        <a href="https://dermamedical.co.uk/events/" style="color:#aaa">dermamedical.co.uk/events</a></p>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Derma Event Parser <noreply@dermamedical.co.uk>',
      to: recipients,
      subject: `⚠️ Expired events on dermamedical.co.uk — ${new Date().toLocaleDateString('en-GB')}`,
      html
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  log(`Email sent via Resend, id: ${data.id}`);
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
      allExpired.push(...expired);
      allExpiringSoon.push(...expiringSoon);
      summary.push({ url, total: events.length, expired: expired.length, expiringSoon: expiringSoon.length, events: events.slice(0, 20) });
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
