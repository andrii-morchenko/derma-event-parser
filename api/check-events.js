const cheerio = require('cheerio');

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

  $('[class*="tribe-event"], [class*="event-item"], article.type-tribe_events').each((i, el) => {
    const title = $(el).find('[class*="tribe-event-title"], [class*="event-title"], h2, h3, h4').first().text().trim();
    const dateEl = $(el).find('[class*="tribe-event-date"], [class*="datetime"], time, .event-date').first();
    const dateText = dateEl.attr('datetime') || dateEl.text().trim();
    if (title || dateText) {
      events.push({ title: title || `Event ${i + 1}`, dateStr: dateText, source: url });
    }
  });

  if (events.length === 0) {
    $('time').each((i, el) => {
      const dt = $(el).attr('datetime') || $(el).text().trim();
      const title = $(el).closest('article, section, li, div').find('h1,h2,h3,h4,a').first().text().trim() || `Event ${i + 1}`;
      if (dt) events.push({ title: title.substring(0, 100), dateStr: dt, source: url });
    });
  }

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
      html += `<li style="margin-bottom:6px"><strong>${e.title}</strong><br>
        <span style="color:#999;font-size:13px">${e.dateStr} · <a href="${e.source}">${e.source}</a></span></li>`;
    });
    html += '</ul>';
  }

  if (expiringSoon.length > 0) {
    html += `<h3 style="color:#e67e22">Expiring soon (${expiringSoon.length})</h3><ul>`;
    expiringSoon.forEach(e => {
      html += `<li style="margin-bottom:6px"><strong>${e.title}</strong><br>
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
