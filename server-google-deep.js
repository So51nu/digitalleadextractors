const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.LEADOS_API_KEY || "";
const APP_API_URL = process.env.APP_API_URL || "";

const PARALLEL_WORKERS = Number(process.env.PARALLEL_WORKERS || 5);
const MAX_TOTAL_RESULTS = Number(process.env.MAX_TOTAL_RESULTS || 5000);
const MAX_RESULTS_PER_QUERY = Number(process.env.MAX_RESULTS_PER_QUERY || 180);
const MAX_QUERY_COMBINATIONS = Number(process.env.MAX_QUERY_COMBINATIONS || 160);
const SCROLL_ROUNDS = Number(process.env.SCROLL_ROUNDS || 35);
const DETAIL_CONCURRENCY_PER_WORKER = Number(process.env.DETAIL_CONCURRENCY_PER_WORKER || 2);
const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() !== "false";
const WEBSITE_PHONE_LOOKUP = String(process.env.WEBSITE_PHONE_LOOKUP || "true").toLowerCase() === "true";
const INCLUDE_NO_PHONE = String(process.env.INCLUDE_NO_PHONE || "false").toLowerCase() === "true";
const SAVE_BATCH_SIZE = Number(process.env.SAVE_BATCH_SIZE || 20);
const SEARCH_DELAY_MS = Number(process.env.SEARCH_DELAY_MS || 900);
const DETAIL_DELAY_MS = Number(process.env.DETAIL_DELAY_MS || 350);
const AUTO_COMPLETE_MINUTES = Number(process.env.AUTO_COMPLETE_MINUTES || 15);

const activeJobs = new Set();

function log(...args) { console.log("[LeadOS Parallel V7]", ...args); }

function auth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!API_KEY || key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

async function callPhp(action, payload = {}) {
  if (!APP_API_URL) throw new Error("APP_API_URL missing in .env");
  const response = await fetch(APP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ action, ...payload })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("PHP API returned non-JSON: " + text.slice(0, 300)); }
  if (!response.ok || !data.ok) throw new Error(data.detail || data.error || "PHP API failed");
  return data;
}

function pick(job, keys, fallback = "") {
  for (const k of keys) {
    if (job && job[k] !== undefined && job[k] !== null && String(job[k]).trim() !== "") return String(job[k]).trim();
  }
  return fallback;
}

function uniq(arr) {
  const seen = new Set();
  return arr.map(x => String(x || "").trim()).filter(Boolean).filter(x => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function expandCategory(input) {
  const raw = String(input || "business").trim();
  const lower = raw.toLowerCase();
  let out = [raw];

  if (lower.includes("digital") || lower.includes("marketing")) {
    out.push(
      "digital marketing agency","digital marketing company","digital marketing services",
      "seo agency","seo company","seo services","social media marketing agency",
      "social media agency","smm agency","advertising agency","creative agency",
      "branding agency","google ads agency","ppc agency","performance marketing agency",
      "web design company","website development company","lead generation company"
    );
  }

  if (lower.includes("salon") || lower.includes("spa")) {
    out.push(
      "salon","spa","salon spa","beauty salon","hair salon","unisex salon",
      "beauty parlour","massage spa","day spa","thai spa","nail salon",
      "skin clinic","wellness spa","body massage center","men salon","women salon"
    );
  }

  if (lower.includes("real estate") || lower.includes("property")) {
    out.push(
      "real estate agent","real estate consultant","property consultant","property dealer",
      "real estate broker","estate agent","property agent","real estate agency","property broker"
    );
  }

  raw.split(/[,\|\/]+|\s+and\s+|\s+/i).map(s => s.trim()).filter(s => s.length > 2).forEach(s => out.push(s));
  return uniq(out);
}

function expandLocations(areaRaw) {
  const raw = String(areaRaw || "").trim();
  const lower = raw.toLowerCase();

  const andheriToBorivali = [
    "Andheri West","Andheri East","Versova","DN Nagar","Lokhandwala Andheri","Oshiwara",
    "Jogeshwari West","Jogeshwari East","Goregaon West","Goregaon East","Malad West","Malad East",
    "Kandivali West","Kandivali East","Borivali West","Borivali East"
  ];

  const bandraToMira = [
    "Bandra West","Bandra East","Khar West","Khar East","Santacruz West","Santacruz East",
    "Vile Parle West","Vile Parle East","Juhu","Andheri West","Andheri East","Versova",
    "Jogeshwari West","Jogeshwari East","Oshiwara","Goregaon West","Goregaon East",
    "Malad West","Malad East","Kandivali West","Kandivali East","Borivali West","Borivali East",
    "Dahisar West","Dahisar East","Mira Road","Bhayandar West","Bhayandar East"
  ];

  if ((lower.includes("bandra") && lower.includes("mira")) || lower.includes("bandra to mira")) return bandraToMira;
  if (lower.includes("andheri") && lower.includes("borivali")) return andheriToBorivali;

  const split = raw.split(/,|\n|\||;/).map(s => s.trim()).filter(Boolean);
  return split.length ? split : ["Mumbai"];
}

function getRadius(job) {
  const val = pick(job, ["radius", "radius_km", "search_radius", "distance"], "");
  const n = Number(String(val).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function buildQueries(categories, locations, radiusKm) {
  const out = [];
  const patterns = radiusKm
    ? ["{cat} in {loc} Mumbai", "{cat} near {loc} Mumbai", "{cat} within {radius} km of {loc} Mumbai"]
    : ["{cat} in {loc} Mumbai", "{cat} near {loc} Mumbai", "{loc} {cat}", "best {cat} in {loc} Mumbai"];

  for (const loc of locations) {
    for (const cat of categories) {
      for (const p of patterns) out.push(p.replace("{cat}", cat).replace("{loc}", loc).replace("{radius}", radiusKm || ""));
    }
  }

  return uniq(out).slice(0, MAX_QUERY_COMBINATIONS).map(q => ({
    query: q,
    location: locations.find(l => q.toLowerCase().includes(l.toLowerCase())) || ""
  }));
}

function splitIntoChunks(arr, count) {
  const chunks = Array.from({ length: count }, () => []);
  arr.forEach((item, index) => chunks[index % count].push(item));
  return chunks.filter(c => c.length);
}

function cleanText(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

function cleanPhone(raw) {
  const text = String(raw || "");
  const patterns = [
    /(?:\+91[\s-]?)?[6-9]\d{9}/g,
    /(?:022|0250|0251|02522|02527|02524|021|020)[\s-]?\d{6,8}/g,
    /0[1-9][0-9][\s-]?\d{6,8}/g
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[0]) return cleanText(m[0]);
  }
  return "";
}

async function firstText(page, selectors, timeout = 1100) {
  for (const sel of selectors) {
    try {
      const txt = await page.locator(sel).first().innerText({ timeout });
      if (cleanText(txt)) return cleanText(txt);
    } catch {}
  }
  return "";
}

async function firstAttr(page, selectors, attr, timeout = 1100) {
  for (const sel of selectors) {
    try {
      const val = await page.locator(sel).first().getAttribute(attr, { timeout });
      if (cleanText(val)) return cleanText(val);
    } catch {}
  }
  return "";
}

async function getPhoneFromWebsite(context, website) {
  if (!WEBSITE_PHONE_LOOKUP || !website || !/^https?:\/\//i.test(website)) return "";
  const page = await context.newPage();
  try {
    await page.goto(website, { waitUntil: "domcontentloaded", timeout: 8000 });
    await page.waitForTimeout(600);
    const tel = await page.locator('a[href^="tel:"]').evaluateAll(els => els.map(a => `${a.getAttribute("href") || ""} ${a.textContent || ""}`).join(" ")).catch(() => "");
    let phone = cleanPhone(tel);
    if (phone) return phone;
    const body = await page.locator("body").innerText({ timeout: 2500 }).catch(() => "");
    return cleanPhone(body);
  } catch { return ""; }
  finally { await page.close().catch(() => {}); }
}

async function acceptConsent(page) {
  for (const b of ['button:has-text("Accept all")','button:has-text("I agree")','button:has-text("Accept")','button:has-text("Reject all")']) {
    try {
      const btn = page.locator(b).first();
      if (await btn.count()) {
        await btn.click({ timeout: 900 }).catch(() => {});
        await page.waitForTimeout(400);
        return;
      }
    } catch {}
  }
}

async function scrollResults(page) {
  const feed = page.locator('div[role="feed"]').first();
  let previous = 0;
  let stable = 0;

  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    const count = await page.locator('a[href*="/maps/place/"]').count().catch(() => 0);
    if (count >= MAX_RESULTS_PER_QUERY) break;
    if (count === previous) stable++;
    else stable = 0;
    previous = count;
    if (stable >= 6 && count > 0) break;

    try {
      if (await feed.count()) await feed.evaluate(el => { el.scrollTop = el.scrollHeight; });
      else await page.mouse.wheel(0, 4500);
    } catch { await page.mouse.wheel(0, 4500); }

    await page.waitForTimeout(450);
  }
}

async function collectCards(page) {
  await scrollResults(page);
  const cards = await page.locator('a[href*="/maps/place/"]').evaluateAll((els) => {
    const out = [];
    const seen = new Set();
    for (const el of els) {
      const href = el.href || "";
      const label = el.getAttribute("aria-label") || el.textContent || "";
      const name = String(label).trim().split("\n")[0].trim();
      if (!href || !name) continue;
      const key = href.split("?")[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, href });
    }
    return out;
  }).catch(() => []);
  return cards.slice(0, MAX_RESULTS_PER_QUERY);
}

async function extractDetail(context, card, category, area) {
  const page = await context.newPage();
  try {
    await page.goto(card.href, { waitUntil: "domcontentloaded", timeout: 22000 });
    await page.waitForTimeout(DETAIL_DELAY_MS);

    const title = await firstText(page, ["h1", '[role="main"] h1'], 2000) || card.name;
    const phoneText = await firstText(page, [
      'button[data-item-id^="phone:tel"]','button[aria-label^="Phone:"]',
      'button[aria-label*="Phone"]','button[data-tooltip*="phone"]','button[data-tooltip*="Phone"]'
    ], 1200);

    const phoneAria = await firstAttr(page, [
      'button[data-item-id^="phone:tel"]','button[aria-label^="Phone:"]','button[aria-label*="Phone"]'
    ], "aria-label", 1200);

    const address = await firstText(page, [
      'button[data-item-id="address"]','[data-item-id="address"]','button[aria-label^="Address:"]'
    ], 1200);

    const website = await firstAttr(page, [
      'a[data-item-id="authority"]','a[aria-label^="Website:"]','a[aria-label*="Website"]'
    ], "href", 1200);

    const ratingAria = await firstAttr(page, ['[role="img"][aria-label*="stars"]'], "aria-label", 900);
    const rating = ratingAria ? ((ratingAria.match(/[0-9.]+/) || [""])[0]) : "";
    const body = await page.locator("body").innerText({ timeout: 2500 }).catch(() => "");

    let phone = cleanPhone(`${phoneText} ${phoneAria} ${body}`);
    if (!phone && website) phone = await getPhoneFromWebsite(context, website);

    let reviews = "";
    const reviewMatch = body.match(/([0-9,]+)\s+reviews/i) || body.match(/([0-9,]+)\s+Google reviews/i);
    if (reviewMatch) reviews = reviewMatch[1].replace(/,/g, "");

    if (!INCLUDE_NO_PHONE && !phone) return null;

    return {
      business_name: cleanText(title),
      phone: cleanText(phone),
      address: cleanText(address).replace(/^Address:\s*/i, ""),
      website: cleanText(website),
      rating: cleanText(rating),
      reviews: cleanText(reviews),
      category: cleanText(category),
      area: cleanText(area)
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function mapLimit(items, limit, iterator) {
  const ret = [];
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => iterator(item));
    ret.push(p);
    if (limit <= items.length) {
      const e = p.finally(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
  }
  return Promise.allSettled(ret);
}

function calcProgress(doneQueries, totalQueries, totalSaved) {
  const q = Math.round((doneQueries / Math.max(totalQueries, 1)) * 65);
  const s = Math.min(15, Math.floor(totalSaved / 10));
  return Math.min(96, Math.max(28, 25 + q + s));
}

async function saveBatch(jobId, leads, currentSaved, doneQueries, totalQueries) {
  if (!leads.length) return currentSaved;
  const res = await callPhp("save_leads", { job_id: jobId, leads });
  const next = currentSaved + Number(res.saved || 0);
  await callPhp("update_job", {
    job_id: jobId,
    status: "running",
    progress: calcProgress(doneQueries, totalQueries, next),
    saved: next
  });
  return next;
}

async function workerRun(workerId, browser, queryItems, category, jobId, globalSeen, counters, totalQueries, startedAt) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  });

  const searchPage = await context.newPage();
  let localBatch = [];

  try {
    for (const item of queryItems) {
      if (globalSeen.size >= MAX_TOTAL_RESULTS) break;
      if ((Date.now() - startedAt) > AUTO_COMPLETE_MINUTES * 60 * 1000) break;

      log(`W${workerId} Search:`, item.query);
      await searchPage.goto("https://www.google.com/maps/search/" + encodeURIComponent(item.query), { waitUntil: "domcontentloaded", timeout: 45000 });
      await searchPage.waitForTimeout(SEARCH_DELAY_MS);
      await acceptConsent(searchPage);

      const rawCards = await collectCards(searchPage);
      const cards = [];

      for (const c of rawCards) {
        const key = c.href.split("?")[0].toLowerCase();
        if (globalSeen.has(key)) continue;
        globalSeen.add(key);
        cards.push(c);
      }

      log(`W${workerId} Cards found:`, cards.length, "unique total:", globalSeen.size);

      const results = await mapLimit(cards, DETAIL_CONCURRENCY_PER_WORKER, async (card) => {
        try {
          const lead = await extractDetail(context, card, category, item.location);
          if (lead && lead.business_name) {
            log(`W${workerId} Lead:`, lead.business_name, lead.phone ? "phone" : "no-phone");
            return lead;
          }
        } catch (e) {
          log(`W${workerId} Detail skipped:`, e.message);
        }
        return null;
      });

      for (const r of results) {
        if (r.status === "fulfilled" && r.value) localBatch.push(r.value);
        if (localBatch.length >= SAVE_BATCH_SIZE) {
          counters.saved = await saveBatch(jobId, localBatch.splice(0), counters.saved, counters.doneQueries, totalQueries);
        }
      }
      if (localBatch.length) counters.saved = await saveBatch(jobId, localBatch.splice(0), counters.saved, counters.doneQueries, totalQueries);

      counters.doneQueries++;
      await callPhp("update_job", {
        job_id: jobId,
        status: "running",
        progress: calcProgress(counters.doneQueries, totalQueries, counters.saved),
        saved: counters.saved
      });
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function extractMaps(job, jobId) {
  const rawCategory = pick(job, ["category", "keyword", "search_category"], "business");
  const rawArea = pick(job, ["area", "location", "search_area"], "Mumbai");
  const radiusKm = getRadius(job);
  const categories = expandCategory(rawCategory);
  const locations = expandLocations(rawArea);
  const queries = buildQueries(categories, locations, radiusKm);
  const chunks = splitIntoChunks(queries, PARALLEL_WORKERS);
  const startedAt = Date.now();

  log("Categories:", categories.join(" | "));
  log("Locations:", locations.join(" | "));
  log("Queries:", queries.length, "Parallel workers:", chunks.length, "Radius:", radiusKm || "not set");

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const globalSeen = new Set();
  const counters = { saved: 0, doneQueries: 0 };

  try {
    await Promise.all(chunks.map((chunk, idx) => workerRun(idx + 1, browser, chunk, rawCategory, jobId, globalSeen, counters, queries.length, startedAt)));
  } finally {
    await browser.close().catch(() => {});
  }

  return counters.saved;
}

async function runJob(jobId) {
  if (activeJobs.has(jobId)) {
    log("Job already running, ignoring duplicate trigger:", jobId);
    return;
  }
  activeJobs.add(jobId);

  try {
    log("Starting job", jobId);
    await callPhp("update_job", { job_id: jobId, status: "running", progress: 10 });

    const jobRes = await callPhp("get_job", { job_id: jobId });
    await callPhp("update_job", { job_id: jobId, status: "running", progress: 25 });

    const totalSaved = await extractMaps(jobRes.job, jobId);
    await callPhp("update_job", { job_id: jobId, status: "completed", progress: 100, saved: totalSaved });
    log("Job completed", jobId, "saved:", totalSaved);
  } finally {
    activeJobs.delete(jobId);
  }
}

app.get("/health", (req, res) => res.json({
  ok: true,
  worker: "LeadOS Google Maps Parallel Worker V7",
  app_api_url: APP_API_URL ? "configured" : "missing",
  parallel_workers: PARALLEL_WORKERS,
  detail_concurrency_per_worker: DETAIL_CONCURRENCY_PER_WORKER,
  max_total_results: MAX_TOTAL_RESULTS,
  max_query_combinations: MAX_QUERY_COMBINATIONS,
  max_results_per_query: MAX_RESULTS_PER_QUERY,
  scroll_rounds: SCROLL_ROUNDS,
  auto_complete_minutes: AUTO_COMPLETE_MINUTES,
  website_phone_lookup: WEBSITE_PHONE_LOOKUP,
  include_no_phone: INCLUDE_NO_PHONE
}));

app.post("/run-job", auth, (req, res) => {
  const jobId = Number(req.body && req.body.job_id ? req.body.job_id : 0);
  if (!jobId) return res.status(400).json({ ok: false, error: "job_id required" });
  res.json({ status: "accepted", job_id: jobId, mode: "parallel-v7" });
  runJob(jobId).catch(async (err) => {
    console.error("[LeadOS Parallel V7] Job failed:", err && err.stack ? err.stack : err.message);
    try { await callPhp("update_job", { job_id: jobId, status: "failed", progress: 0 }); } catch {}
    activeJobs.delete(jobId);
  });
});

module.exports = { extractMaps };
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => log("running on", PORT));
}
