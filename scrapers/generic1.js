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

  // IMPORTANT: non-Google sources must open their own source website.
  // We do not route Justdial/IndiaMART/TradeIndia/Sulekha/Instagram/Facebook jobs through Google search.
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

function validChunkForSource(chunk, source) {
  const text = String(chunk || '').toLowerCase();
  if (source === 'justdial') return text.includes('justdial') || text.includes('jd');
  if (source === 'indiamart') return text.includes('indiamart') || text.includes('supplier') || text.includes('manufacturer');
  if (source === 'tradeindia') return text.includes('tradeindia') || text.includes('supplier') || text.includes('manufacturer');
  if (source === 'sulekha') return text.includes('sulekha') || text.includes('service');
  if (source === 'instagram') return text.includes('instagram.com') || text.includes('instagram');
  if (source === 'facebook') return text.includes('facebook.com') || text.includes('facebook');
  return true;
}

async function genericScrape({ browser, job, log }) {
  const source = String(job.source || 'generic').toLowerCase();
  const context = await browser.newContext({ locale: 'en-IN' });
  const page = await context.newPage();
  const url = buildSourceUrl(source, job);
  const max = Number(job.max_results || 100);
  const phoneRequired = Boolean(Number(job.phone_required || 0));
  const websiteRequired = Boolean(Number(job.website_required || 0));
  const leads = [];

  try {
    await log('info', `Selected source: ${sourceLabel(source)}`);
    await log('info', `Opening ${sourceLabel(source)} URL`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2800);

    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 1800).catch(() => {});
      await page.waitForTimeout(650);
    }

    const body = await page.locator('body').innerText({ timeout: 9000 }).catch(() => '');
    const linkText = await page.locator('a').evaluateAll((anchors) => anchors.map((a) => `${a.href || ''} ${a.textContent || ''}`).join('\n')).catch(() => '');
    const combined = `${body}\n${linkText}`;
    const chunks = combined
      .split(/\n{2,}|(?=https?:\/\/)|(?=www\.)/)
      .map(cleanText)
      .filter((x) => x.length > 28)
      // Do not reject records only because a source label is not visible in the text.
      // Many directory pages hide the brand text inside layouts, so strict filtering caused 0 leads.
      .slice(0, Math.max(max * 4, 120));

    for (const c of chunks) {
      const phone = cleanPhone(c);
      const email = emails(c)[0] || '';
      const websiteMatch = c.match(/https?:\/\/[^\s)]+|www\.[^\s)]+/i);
      const website = websiteMatch ? websiteMatch[0].replace(/[,.]$/, '') : '';
      if (phoneRequired && !phone) continue;
      if (websiteRequired && !website) continue;

      let name = cleanText(c.split(/\||•| - | – |,|\n/)[0]).slice(0, 120);
      if (!name || name.length < 3) name = `${sourceLabel(source)} Lead`;
      leads.push({
        business_name: name,
        phone_number: phone,
        whatsapp: phone,
        email,
        website,
        address: c.slice(0, 280),
        source,
        category: job.category,
        status: phone || email || website ? 'new' : 'needs_review'
      });
      if (leads.length >= max) break;
    }

    await log('success', `${sourceLabel(source)} extraction completed. Rows found: ${leads.length}`);
    return dedupe(leads);
  } finally {
    await context.close().catch(() => {});
  }
}

async function websiteScrape({ browser, job, log }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = /^https?:\/\//i.test(job.category) ? job.category : job.area_text;
  const leads = [];
  try {
    await log('info', 'Selected source: Website Contact Extractor');
    await log('info', 'Opening website ' + url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1000);
    const body = await page.locator('body').innerText({ timeout: 7000 }).catch(() => '');
    const links = await page.locator('a').evaluateAll(a => a.map(x => (x.href || '') + ' ' + (x.textContent || '')).join(' ')).catch(() => '');
    const phone = cleanPhone(body + ' ' + links);
    const email = emails(body + ' ' + links)[0] || '';
    leads.push({
      business_name: cleanText(await page.title().catch(() => url)) || url,
      phone_number: phone,
      whatsapp: phone,
      email,
      website: url,
      source: 'website',
      status: 'new'
    });
    return leads;
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { genericScrape, websiteScrape, buildSourceUrl, sourceLabel };
