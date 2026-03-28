/**
 * Crimson Desert Item Scraper
 *
 * Reads item URLs from items-urls.json, fetches each item page via HTTP
 * (the site uses Nuxt SSR so all data is in the raw HTML), parses it
 * with cheerio, and saves everything to database.json.
 *
 * Supports resuming: already-scraped URLs are skipped.
 * Run:  node scraper.js
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');

const BASE_URL      = 'https://crimsondesert.gg';
const URLS_FILE     = './items-urls.json';
const OUTPUT_FILE   = './database.json';
const PROGRESS_FILE = './scraper-progress.json';

const CONCURRENCY = 5;   // parallel requests per batch
const DELAY_MS    = 200; // ms pause between batches
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Only 4-segment paths represent individual item pages */
function isItemPage(urlPath) {
  const parts = urlPath.replace(/^\//, '').split('/').filter(Boolean);
  return parts.length === 4 && parts[0] === 'database';
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch (_) {}
  }
  return { done: [], failed: [] };
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2), 'utf8');
}

function loadDatabase() {
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const c = fs.readFileSync(OUTPUT_FILE, 'utf8').trim();
      if (c && c !== '[]') return JSON.parse(c);
    } catch (_) {}
  }
  return [];
}

function saveDatabase(items) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(items, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// HTML parsing  (Nuxt SSR – all data is in the raw HTML)
// ---------------------------------------------------------------------------

/**
 * Parses "12" or "12 → 34" into { base, max }.
 * The arrow character in the SSR HTML is the Unicode â†' entity (→).
 */
function parseStat(valueEl, $) {
  const base = valueEl.clone().children('.db-stat-arrow, .db-stat-max').remove().end().text().trim();
  const max  = valueEl.find('.db-stat-max').text().trim();
  const b = Number(base);
  const m = max ? Number(max) : b;
  if (isNaN(b)) return null;
  return { base: b, max: isNaN(m) ? b : m };
}

function parseItem($, urlPath) {
  const segments = urlPath.replace(/^\//, '').split('/').filter(Boolean);
  const category    = segments[1] || null;
  const subcategory = segments[2] || null;
  const slug        = segments[3] || null;

  // --- header ---
  const name        = $('.db-item-name').first().text().trim() || null;
  if (!name) return null;

  const type        = $('.db-item-type').first().text().trim()  || null;
  const rarity      = $('.db-item-tier').first().text().trim()  || null;
  const description = $('.db-item-desc').first().text().trim()  || null;

  // Image: prefer the large item icon
  let image = null;
  const iconEl = $('.db-item-icon-large').first();
  if (iconEl.length) {
    const src = iconEl.attr('src') || '';
    image = src.startsWith('http') ? src : (src ? BASE_URL + src : null);
  }

  // --- stats ---
  const stats = [];
  $('.db-stat-row').each((_, row) => {
    const label = $(row).find('.db-stat-label').text().trim();
    if (!label) return;

    const valueEl  = $(row).find('.db-stat-value');
    // Clone and strip child elements to get only the base text node
    const baseText = valueEl.clone()
      .children('.db-stat-arrow, .db-stat-max').remove()
      .end().text().trim();
    const maxText  = valueEl.find('.db-stat-max').text().trim();

    const baseNum = parseFloat(baseText);
    const maxNum  = maxText ? parseFloat(maxText) : baseNum;

    stats.push({
      name: label,
      base: isNaN(baseNum) ? null : baseNum,
      max:  isNaN(maxNum)  ? null : maxNum,
    });
  });

  // --- refinement table ---
  const refinement = [];
  $('.db-enchant-table tbody tr').each((_, tr) => {
    const level = $(tr).find('.db-enchant-level').text().trim();
    if (!level) return;

    // Stats per refinement level
    const levelStats = [];
    $(tr).find('.db-enchant-stat-line').each((_, line) => {
      const statLabel = $(line).find('.db-enchant-stat-label').text().trim();
      const statVal   = $(line).find('.db-enchant-stat-val').text().trim();
      if (statLabel) levelStats.push({ name: statLabel, value: Number(statVal) || statVal });
    });

    // Materials
    const materials = [];
    $(tr).find('.db-enchant-mats-cell .db-enchant-mat-row').first().find('.db-enchant-mat-pill').each((_, pill) => {
      const matName = $(pill).find('.db-enchant-mat-name').text().trim();
      const matQty  = $(pill).find('.db-enchant-mat-qty').text().replace(/^x/, '').trim();
      if (matName) materials.push({ name: matName, quantity: Number(matQty) || matQty });
    });

    // Price
    const priceText = $(tr).find('.db-enchant-price').text().trim().replace(/[^\d.,]/g, '').trim();
    const price = priceText ? Number(priceText.replace(',', '.')) : null;

    refinement.push({ level, stats: levelStats, materials, price });
  });

  return { url: urlPath, slug, category, subcategory, name, type, rarity, description, image, stats, refinement };
}

// ---------------------------------------------------------------------------
// HTTP fetch with retry
// ---------------------------------------------------------------------------

async function fetchItem(urlPath, attempt = 0) {
  try {
    const response = await axios.get(BASE_URL + urlPath, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: 20000,
    });
    const $ = cheerio.load(response.data);
    return parseItem($, urlPath);
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * (attempt + 1));
      return fetchItem(urlPath, attempt + 1);
    }
    console.error(`  FAILED [${urlPath}]: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const allUrls  = JSON.parse(fs.readFileSync(URLS_FILE, 'utf8'));
  const itemUrls = allUrls.filter(isItemPage);
  console.log(`Total URLs: ${allUrls.length}  →  Item pages to scrape: ${itemUrls.length}`);

  const progress  = loadProgress();
  const doneSet   = new Set(progress.done);
  const database  = loadDatabase();
  const dbByUrl   = new Map(database.map(i => [i.url, i]));
  const remaining = itemUrls.filter(u => !doneSet.has(u));

  console.log(`Already scraped: ${doneSet.size}  |  Remaining: ${remaining.length}`);

  let scraped = 0;
  let failed  = 0;

  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch   = remaining.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchItem));

    for (let j = 0; j < batch.length; j++) {
      const url    = batch[j];
      const result = results[j];
      if (result) {
        dbByUrl.set(url, result);
        progress.done.push(url);
        scraped++;
      } else {
        if (!progress.failed.includes(url)) progress.failed.push(url);
        failed++;
      }
    }

    // Persist every 50 items so progress is never lost
    if ((i + CONCURRENCY) % 50 === 0 || i + CONCURRENCY >= remaining.length) {
      const allItems = Array.from(dbByUrl.values());
      saveDatabase(allItems);
      saveProgress(progress);
      const total = doneSet.size + scraped;
      const pct   = ((total / itemUrls.length) * 100).toFixed(1);
      console.log(`[${pct}%] ${total}/${itemUrls.length} items saved  (failed this run: ${failed})`);
    }

    if (i + CONCURRENCY < remaining.length) await sleep(DELAY_MS);
  }

  const allItems = Array.from(dbByUrl.values());
  saveDatabase(allItems);
  saveProgress(progress);

  console.log('\n=== DONE ===');
  console.log(`Scraped this run       : ${scraped}`);
  console.log(`Failed this run        : ${failed}`);
  console.log(`Total in database.json : ${allItems.length}`);
  if (progress.failed.length) {
    console.log(`All-time failed URLs   : ${progress.failed.length}  (see ${PROGRESS_FILE})`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
