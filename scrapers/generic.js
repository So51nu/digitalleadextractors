const { cleanText, cleanPhone, emails, dedupe } = require('../utils/clean');

function slugifyText(value) {
  return String(value || '')
    .replace(/https?:\/\//gi, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function sourceLabel(source) {
  return ({
    google_maps: 'Google Maps',
    justdial: 'Justdial',
    indiamart: 'IndiaMART',
    tradeindia: 'TradeIndia',
    sulekha: 'Sulekha',
    instagram: 'Instagram Business',
    facebook: 'Facebook Pages',
    website: 'Website Contact Extractor'
  })[source] || source;
}

function buildSourceUrl(source, job) {
  const category = String(job.category || '').trim() || 'business';
  const area = String(job.area_text || job.area || job.location || '').trim();
  const city = String(job.city || '').trim() || 'Mumbai';
  const qPlain = [category, area, city].filter(Boolean).join(' ');
  const q = encodeURIComponent(qPlain);
  const sourceSafe = String(source || '').toLowerCase();
  const catSlug = slugifyText(category);
  const areaSlug = slugifyText(area);
  const citySlug = slugifyText(city || 'Mumbai');

  if (sourceSafe === 'google_maps') return `https://www.google.com/maps/search/${q}`;
  if (sourceSafe === 'justdial') return `https://www.justdial.com/${citySlug}/${catSlug}${areaSlug ? '-in-' + areaSlug : ''}`;
  if (sourceSafe === 'indiamart') return `https://dir.indiamart.com/search.mp?ss=${q}`;
  if (sourceSafe === 'tradeindia') return `https://www.tradeindia.com/search.html?keyword=${q}`;
  if (sourceSafe === 'sulekha') return `https://www.sulekha.com/${catSlug}/${citySlug}${areaSlug ? '?q=' + encodeURIComponent(area) : ''}`;
  if (sourceSafe === 'instagram') return `https://www.instagram.com/explore/search/keyword/?q=${q}`;
  if (sourceSafe === 'facebook') return `https://www.facebook.com/search/pages/?q=${q}`;
  if (sourceSafe === 'website') return /^https?:\/\//i.test(category) ? category : `https://${category}`;
  return `https://www.google.com/maps/search/${q}`;
}

function extractPhones(text) {
  const t = String(text || '');
  const matches = [];
  const patterns = [
    /(?:\+91[\s\-.]?)?[6-9]\d[\d\s\-.]{8,14}/g,
    /(?:0?22|0?20|0?250|0?251|0?2522|0?2527|0?2524)[\s\-.]?\d[\d\s\-.]{5,10}/g,
    /tel:([^\s"'<>]+)/gi
  ];
  for (const p of patterns) {
    for (const m of t.matchAll(p)) {
      const raw = m[1] || m[0];
      const cleaned = cleanPhone(raw);
      if (cleaned) matches.push(cleaned);
    }
  }
  return Array.from(new Set(matches));
}

function extractWebsites(text, source) {
  const urls = Array.from(new Set(String(text || '').match(/https?:\/\/[^\s)"'<>]+|www\.[^\s)"'<>]+/gi) || []))
    .map(u => u.replace(/[,.]+$/, ''));
  return urls.filter(u => {
    const l = u.toLowerCase();
    if (source === 'justdial') return l.includes('justdial.com') || !/(facebook|instagram|google|youtube)/.test(l);
    return true;
  }).slice(0, 5);
}

function leadFromChunk(chunk, source, job, fallbackName='') {
  const c = cleanText(chunk);
  if (!c || c.length < 8) return null;
  const phones = extractPhones(c);
  const email = emails(c)[0] || '';
  const websites = extractWebsites(c, source);
  let name = fallbackName || cleanText(c.split(/\||•| - | – |,|\n/)[0]).slice(0, 130);
  name = name.replace(/^(call|show number|website|contact)\s*/i, '').trim();
  if (!name || name.length < 3) name = `${sourceLabel(source)} Lead`;
  const phone = phones[0] || '';
  return {
    business_name: name,
    phone_number: phone,
    whatsapp: phone,
    email,
    website: websites[0] || '',
    address: c.slice(0, 450),
    source,
    category: job.category,
    status: phone || email || websites[0] ? 'new' : 'needs_review'
  };
}

async function clickPublicRevealButtons(page, log, source) {
  const labels = ['show number', 'view number', 'call', 'contact', 'phone'];
  let clicked = 0;
  for (const label of labels) {
    const loc = page.locator(`text=/${label}/i`);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 8); i++) {
      try {
        await loc.nth(i).click({ timeout: 1200 });
        clicked++;
        await page.waitForTimeout(650);
      } catch {}
    }
  }
  if (clicked) await log('info', `${sourceLabel(source)} public reveal/contact buttons clicked: ${clicked}`);
}

async function collectDomLeads(page, source, job, max) {
  return await page.evaluate(({ source, job, max }) => {
    function text(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
    function hrefs(el) { return Array.from(el.querySelectorAll('a')).map(a => (a.href || '') + ' ' + (a.textContent || '')).join(' '); }
    const selectorMap = {
      justdial: '[class*="result"],[class*="store"],[class*="listing"],[class*="jsx"],li,section,article',
      indiamart: '[class*="card"],[class*="listing"],[class*="prd"],[class*="seller"],li,section,article',
      tradeindia: '[class*="product"],[class*="supplier"],[class*="listing"],li,section,article',
      sulekha: '[class*="listing"],[class*="business"],[class*="card"],li,section,article',
      facebook: 'a[href*="facebook.com"],div[role="article"],div[aria-label],section,article',
      instagram: 'a[href*="instagram.com"],article,section,div[role="button"]',
      website: 'body'
    };
    const nodes = Array.from(document.querySelectorAll(selectorMap[source] || 'li,section,article,div'));
    const rows = [];
    const seen = new Set();
    for (const el of nodes) {
      const s = (text(el) + ' ' + hrefs(el)).trim();
      if (s.length < 20) continue;
      const key = s.slice(0, 160).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(s);
      if (rows.length >= max * 4) break;
    }
    return rows;
  }, { source, job, max }).catch(() => []);
}

async function genericScrape({ browser, job, log }) {
  const source = String(job.source || 'generic').toLowerCase();
  const context = await browser.newContext({ locale: 'en-IN', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' });
  const page = await context.newPage();
  const url = buildSourceUrl(source, job);
  const max = Number(job.max_results || 100);
  const leads = [];

  try {
    await log('info', `Selected source: ${sourceLabel(source)}`);
    await log('info', `Opening ${sourceLabel(source)} URL: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => log('warning', `${sourceLabel(source)} initial load warning: ${e.message}`));
    await page.waitForTimeout(3500);

    await clickPublicRevealButtons(page, log, source);

    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 1800).catch(() => {});
      await page.waitForTimeout(850);
      if (i === 3) await clickPublicRevealButtons(page, log, source);
    }

    const body = await page.locator('body').innerText({ timeout: 12000 }).catch(() => '');
    const links = await page.locator('a').evaluateAll((anchors) => anchors.map((a) => `${a.href || ''} ${a.textContent || ''}`).join('\n')).catch(() => '');
    const html = await page.content().catch(() => '');
    const combined = `${body}\n${links}\n${html}`;

    if (/captcha|unusual traffic|verify you are human|temporarily blocked/i.test(body.slice(0, 2500))) {
      await log('warning', `${sourceLabel(source)} appears captcha/block protected. Public extraction will continue only from visible HTML.`);
    }
    if (/log in|login|sign in/i.test(body.slice(0, 2500)) && ['facebook','instagram'].includes(source)) {
      await log('warning', `${sourceLabel(source)} is showing a login wall. Saving public profile/page rows only if visible.`);
    }

    let chunks = await collectDomLeads(page, source, job, max);
    const fallbackChunks = combined
      .split(/\n{2,}|(?=https?:\/\/)|(?=www\.)|(?=\+91)|(?=\b[6-9]\d{9}\b)/)
      .map(cleanText)
      .filter(x => x.length > 24)
      .slice(0, Math.max(max * 6, 180));
    chunks = [...chunks, ...fallbackChunks];

    await log('info', `${sourceLabel(source)} visible/public rows found: ${chunks.length}`);

    for (const c of chunks) {
      const lead = leadFromChunk(c, source, job);
      if (!lead) continue;
      // For non-Google sources we save visible business/profile rows even when phone is hidden.
      // Phone/email/website/contact links are enriched when visible in public DOM/HTML.
      if (!lead.phone_number && !lead.email && !lead.website && source !== 'facebook' && source !== 'instagram') {
        // Keep only rows that look like business/listing rows to avoid noisy site text.
        if (!/contact|call|address|supplier|dealer|service|shop|store|manufacturer|business|company|furniture|real estate|marketing/i.test(lead.address)) continue;
      }
      leads.push(lead);
      if (leads.length >= max) break;
    }

    const clean = dedupe(leads).slice(0, max);
    if (!clean.length) {
      await log('warning', `${sourceLabel(source)} found 0 usable public rows. Page may require login/captcha or has no visible directory results for this query.`);
    } else {
      const withPhone = clean.filter(x => x.phone_number).length;
      const withEmail = clean.filter(x => x.email).length;
      const withWeb = clean.filter(x => x.website).length;
      await log('success', `${sourceLabel(source)} extraction completed. Rows found: ${clean.length}; phones: ${withPhone}; emails: ${withEmail}; websites/profile URLs: ${withWeb}`);
    }
    return clean;
  } finally {
    await context.close().catch(() => {});
  }
}

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).toString(); } catch { return ''; }
}

function sameHost(a, b) {
  try { return new URL(a).hostname.replace(/^www\./,'') === new URL(b).hostname.replace(/^www\./,''); } catch { return false; }
}

async function websiteScrape({ browser, job, log }) {
  const start = normalizeUrl(job.category) || normalizeUrl(job.area_text) || normalizeUrl(job.website) || '';
  const context = await browser.newContext({ locale: 'en-IN' });
  const page = await context.newPage();
  const max = Number(job.max_results || 100);
  const visited = new Set();
  const queue = [];
  const leads = [];
  try {
    await log('info', 'Selected source: Website Contact Extractor');
    if (!start) throw new Error('Website URL is required in Category / Keyword field for Website extractor. Example: https://example.com');
    queue.push(start);
    await log('info', 'Starting website crawl from ' + start);

    while (queue.length && visited.size < 12 && leads.length < max) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);
      await log('info', `Opening website page ${visited.size}: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => log('warning', `Website page load warning: ${e.message}`));
      await page.waitForTimeout(1000);
      const title = cleanText(await page.title().catch(() => url));
      const body = await page.locator('body').innerText({ timeout: 9000 }).catch(() => '');
      const html = await page.content().catch(() => '');
      const linkText = await page.locator('a').evaluateAll(a => a.map(x => (x.href || '') + ' ' + (x.textContent || '')).join('\n')).catch(() => '');
      const all = `${body}\n${linkText}\n${html}`;
      const phones = extractPhones(all);
      const emailList = emails(all);

      if (phones.length || emailList.length || /contact|enquiry|phone|mobile|address/i.test(all)) {
        leads.push({
          business_name: title || new URL(url).hostname,
          phone_number: phones[0] || '',
          whatsapp: phones[0] || '',
          email: emailList[0] || '',
          website: url,
          address: cleanText(body).slice(0, 600),
          source: 'website',
          category: job.category,
          status: phones[0] || emailList[0] ? 'new' : 'needs_review'
        });
      }

      const links = await page.locator('a').evaluateAll((anchors) => anchors.map(a => ({ href: a.href || '', text: (a.textContent || '').trim() }))).catch(() => []);
      for (const l of links) {
        if (!l.href || !sameHost(start, l.href)) continue;
        if (!/contact|about|enquiry|support|reach|location|branch|office|get-in-touch|connect/i.test(`${l.href} ${l.text}`)) continue;
        const cleanHref = l.href.split('#')[0];
        if (!visited.has(cleanHref) && !queue.includes(cleanHref)) queue.push(cleanHref);
      }
    }

    if (!leads.length) {
      // Save at least the site row for manual review, because site was reachable but contact was not visible.
      leads.push({
        business_name: cleanText(await page.title().catch(() => start)) || new URL(start).hostname,
        phone_number: '',
        whatsapp: '',
        email: '',
        website: start,
        address: 'Website crawled. No public phone/email found on visible pages.',
        source: 'website',
        category: job.category,
        status: 'needs_review'
      });
    }
    const finalRows = dedupe(leads).slice(0, max);
    await log('success', `Website crawler completed. Pages crawled: ${visited.size}; rows found: ${finalRows.length}`);
    return finalRows;
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { genericScrape, websiteScrape, buildSourceUrl, sourceLabel };
