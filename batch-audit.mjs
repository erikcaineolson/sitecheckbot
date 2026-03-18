#!/usr/bin/env node
// Batch audit — crawl + analyze multiple domains, output JSON per domain
// Usage: node batch-audit.mjs <domain-list.txt>

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const listFile = process.argv[2];
if (!listFile) {
  console.error('Usage: node batch-audit.mjs <domain-list.txt>');
  process.exit(1);
}

// ─── Parse domain list ───
const raw = readFileSync(resolve(listFile), 'utf-8');
const urls = raw.split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))
  .map(l => l.includes('://') ? l : `https://${l}`)
  .filter((v, i, a) => a.indexOf(v) === i);

if (urls.length === 0) { console.error('No valid URLs found.'); process.exit(1); }
if (urls.length > 20) { console.warn(`Warning: ${urls.length} URLs found, processing first 20.`); urls.length = 20; }

function sanitizeHostname(url) {
  try { return new URL(url).hostname.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase(); }
  catch { return 'unknown'; }
}

// Deduplicate sanitized names
const nameCount = {};
const domains = urls.map(url => {
  let name = sanitizeHostname(url);
  if (nameCount[name]) { nameCount[name]++; name += '-' + nameCount[name]; }
  else { nameCount[name] = 1; }
  return { url, sanitized: name };
});

console.log(`\nBatch audit: ${domains.length} domains\n`);

// ─── Contrast ratio calculation (WCAG 2.1) ───
function parseColor(colorStr) {
  if (!colorStr) return null;
  const rgbaMatch = colorStr.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (rgbaMatch) {
    return { r: parseFloat(rgbaMatch[1]), g: parseFloat(rgbaMatch[2]), b: parseFloat(rgbaMatch[3]), a: parseFloat(rgbaMatch[4] ?? 1) };
  }
  return null;
}

function blendOnWhite(c) {
  if (!c || c.a === 1) return c;
  return { r: c.r * c.a + 255 * (1 - c.a), g: c.g * c.a + 255 * (1 - c.a), b: c.b * c.a + 255 * (1 - c.a), a: 1 };
}

function relativeLuminance(c) {
  const [rs, gs, bs] = [c.r / 255, c.g / 255, c.b / 255].map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(fg, bg) {
  const fgBlend = blendOnWhite(fg);
  const bgBlend = blendOnWhite(bg);
  if (!fgBlend || !bgBlend) return null;
  const l1 = relativeLuminance(fgBlend);
  const l2 = relativeLuminance(bgBlend);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function isLargeText(fontSize, fontWeight) {
  const bold = parseInt(fontWeight) >= 700 || fontWeight === 'bold';
  return fontSize >= 24 || (fontSize >= 18.66 && bold);
}

// ─── Page extraction JS (runs in browser) ───
const extractionScript = `() => {
  const clean = (str, maxLen = 200) => {
    if (str == null) return '';
    return String(str).replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F\\u00AD\\u200B-\\u200F\\u2028-\\u202F\\uFEFF]/g, '').substring(0, maxLen);
  };
  const results = { pageUrl: location.href, meta: {}, textElements: [], images: [], headings: [], links: [], forms: [], overflowIssues: [], internalLinks: [], formDetails: [], adDetection: { networks: [] } };
  const html = document.documentElement;
  results.meta = {
    lang: clean(html.getAttribute('lang'), 10),
    title: clean(document.title, 200),
    viewport: clean(document.querySelector('meta[name="viewport"]')?.getAttribute('content'), 200),
    description: clean(document.querySelector('meta[name="description"]')?.getAttribute('content'), 300),
    charset: clean(document.characterSet, 30),
  };
  const textEls = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, a, li, td, th, label, button, blockquote');
  const seen = new Set();
  Array.from(textEls).slice(0, 50).forEach(el => {
    const style = getComputedStyle(el);
    const text = clean(el.textContent?.trim(), 100);
    if (!text) return;
    const dk = text + '|' + style.color + '|' + style.backgroundColor;
    if (seen.has(dk)) return; seen.add(dk);
    results.textElements.push({ tag: el.tagName.toLowerCase(), selector: clean(el.className ? el.tagName.toLowerCase() + '.' + Array.from(el.classList).slice(0,3).map(c => CSS.escape(c)).join('.') : el.tagName.toLowerCase(), 150), text, color: style.color, backgroundColor: style.backgroundColor, fontSize: parseFloat(style.fontSize), fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, wordSpacing: style.wordSpacing });
  });
  Array.from(document.querySelectorAll('img')).slice(0, 100).forEach(img => {
    results.images.push({ src: clean(img.src, 500), alt: img.hasAttribute('alt') ? clean(img.getAttribute('alt'), 200) : null, hasAlt: img.hasAttribute('alt'), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, displayed: img.offsetWidth > 0 && img.offsetHeight > 0, selector: clean(img.className ? 'img.' + Array.from(img.classList).slice(0,3).map(c => CSS.escape(c)).join('.') : 'img', 150) });
  });
  Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).slice(0, 50).forEach(h => {
    results.headings.push({ level: parseInt(h.tagName[1]), text: clean(h.textContent?.trim(), 80) });
  });
  Array.from(document.querySelectorAll('a[href]')).slice(0, 200).forEach(a => {
    results.links.push({ href: clean(a.href, 500), text: clean(a.textContent?.trim(), 60), hasText: (a.textContent?.trim().length || 0) > 0, target: clean(a.target, 20) });
  });
  Array.from(document.querySelectorAll('input, select, textarea')).slice(0, 100).forEach(input => {
    const label = clean(input.labels?.[0]?.textContent?.trim(), 100);
    const ariaLabel = clean(input.getAttribute('aria-label'), 100);
    results.forms.push({ type: clean(input.type || input.tagName.toLowerCase(), 30), name: clean(input.name, 80), id: clean(input.id, 80), hasLabel: !!label || !!ariaLabel, labelText: label || ariaLabel, placeholder: clean(input.placeholder, 100), required: input.required });
  });
  const blockSel = 'div, section, article, main, aside, header, footer, nav, p, ul, ol, table, form, fieldset, details, figure, pre, blockquote';
  Array.from(document.querySelectorAll(blockSel)).slice(0, 500).forEach(el => {
    if (el.scrollWidth > el.clientWidth + 5) {
      const style = getComputedStyle(el);
      if (style.overflow !== 'scroll' && style.overflow !== 'auto' && style.overflowX !== 'scroll' && style.overflowX !== 'auto') {
        results.overflowIssues.push({ selector: el.className ? el.tagName.toLowerCase() + '.' + Array.from(el.classList).slice(0,2).map(c => CSS.escape(c)).join('.') : el.tagName.toLowerCase(), overflowAmount: el.scrollWidth - el.clientWidth });
      }
    }
  });
  const origin = location.origin;
  const skipExt = /\\.(pdf|jpg|jpeg|png|gif|svg|webp|ico|mp4|mp3|wav|avi|mov|zip|tar|gz|rar|exe|dmg|doc|docx|xls|xlsx|ppt|pptx|csv|xml|json|txt|rtf|woff|woff2|ttf|eot|otf)$/i;
  const intSet = new Set();
  document.querySelectorAll('a[href]').forEach(a => { try { const u = new URL(a.href, location.href); if (u.origin !== origin) return; if (skipExt.test(u.pathname)) return; u.hash = ''; let n = u.href.replace(/\\/+$/, ''); if (intSet.size < 200) intSet.add(n); } catch {} });
  results.internalLinks = Array.from(intSet);
  const formElements = document.querySelectorAll('form');
  Array.from(formElements).slice(0, 30).forEach((form, idx) => {
    const fields = [];
    form.querySelectorAll('input, select, textarea').forEach(input => {
      const label = clean(input.labels?.[0]?.textContent?.trim(), 100);
      const ariaLabel = clean(input.getAttribute('aria-label'), 100);
      fields.push({ type: clean(input.type || input.tagName.toLowerCase(), 30), name: clean(input.name, 80), hasLabel: !!label || !!ariaLabel, required: input.required });
    });
    const action = form.getAttribute('action');
    let resolvedAction = '';
    try { if (action) resolvedAction = new URL(action, location.href).href; } catch {}
    results.formDetails.push({ index: idx, action: clean(action, 500), resolvedAction: clean(resolvedAction, 500), method: clean(form.method, 10), hasAction: !!action && action.trim() !== '', fields, selector: clean(form.id ? 'form#' + CSS.escape(form.id) : (form.className ? 'form.' + Array.from(form.classList).slice(0,2).map(c => CSS.escape(c)).join('.') : 'form:nth-of-type(' + (idx + 1) + ')'), 200) });
  });
  const adNets = { 'Google AdSense': ['pagead2.googlesyndication.com','adsbygoogle','ca-pub-'], 'Google Ad Manager': ['googletag','securepubads.g.doubleclick.net','googletagservices.com'], 'Revive Ad Server': ['revive-adserver','rv.js','openx'], 'Amazon Ads': ['amazon-adsystem.com','aax.amazon'], 'Media.net': ['media.net','contextual.media.net'], 'Taboola': ['taboola.com','tblcdn.com'], 'Outbrain': ['outbrain.com','outbrainimg.com'], 'Ezoic': ['ezoic.net','ezojs.com','ezoic.com'], 'Mediavine': ['mediavine.com','mediavine'], 'AdThrive': ['adthrive.com','adthrive'], 'Sovrn': ['sovrn.com','lijit.com'], 'PropellerAds': ['propellerads.com','propellerclick.com'] };
  const sSrcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src.toLowerCase());
  const iScripts = Array.from(document.querySelectorAll('script:not([src])')).map(s => (s.textContent || '').toLowerCase()).join(' ');
  const iFrSrcs = Array.from(document.querySelectorAll('iframe[src]')).map(f => f.src.toLowerCase());
  const adAt = Array.from(document.querySelectorAll('[data-ad-client], [data-ad-slot], ins.adsbygoogle')).map(el => (el.outerHTML || '').substring(0, 200).toLowerCase()).join(' ');
  for (const [name, pats] of Object.entries(adNets)) {
    const ev = [];
    for (const p of pats) { if (sSrcs.some(s => s.includes(p)) || iScripts.includes(p) || iFrSrcs.some(s => s.includes(p)) || adAt.includes(p)) ev.push(p); }
    if (ev.length > 0) results.adDetection.networks.push({ name, evidence: ev.slice(0, 3) });
  }
  return results;
}`;

// ─── Broken link checker (runs in browser) ───
function buildLinkCheckScript(urlBatch) {
  const urlsJson = JSON.stringify(urlBatch);
  return `async () => {
    const urls = ${urlsJson};
    const results = [];
    const concurrency = 5;
    const timeout = 8000;
    const isPrivate = (urlStr) => { try { const u = new URL(urlStr); const h = u.hostname; if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '0.0.0.0') return true; if (h.startsWith('10.') || h.startsWith('192.168.')) return true; if (/^172\\.(1[6-9]|2\\d|3[01])\\./.test(h)) return true; if (h.startsWith('169.254.')) return true; if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true; return false; } catch { return true; } };
    const filtered = urls.filter(u => !isPrivate(u));
    for (let i = 0; i < filtered.length; i += concurrency) {
      const batch = filtered.slice(i, i + concurrency);
      const checks = batch.map(async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          let resp = await fetch(url, { method: 'HEAD', signal: controller.signal, mode: 'cors', redirect: 'follow' });
          clearTimeout(timer);
          if (resp.status === 405 || resp.status === 400) {
            const c2 = new AbortController(); const t2 = setTimeout(() => c2.abort(), timeout);
            resp = await fetch(url, { method: 'GET', signal: c2.signal, mode: 'cors', redirect: 'follow' });
            clearTimeout(t2);
          }
          return { url, status: resp.status, ok: resp.ok, error: null, opaque: resp.type === 'opaque' };
        } catch (e) {
          clearTimeout(timer);
          if (e.name === 'AbortError') return { url, status: 0, ok: false, error: 'Timeout', opaque: false };
          if (e.name === 'TypeError') return { url, status: 0, ok: false, error: 'Unverifiable (CORS)', opaque: true };
          return { url, status: 0, ok: false, error: e.message || 'Network error', opaque: false };
        }
      });
      results.push(...await Promise.all(checks));
    }
    return results;
  }`;
}

// ─── Main audit function for a single domain ───
async function auditDomain(page, seedUrl, sanitized) {
  const allPages = [];
  const visited = new Set();
  const queue = [];
  const allLinks = new Map(); // href -> { text, pages[] }
  const adDetectionMerged = {};
  const allFormDetails = [];
  const timestamp = new Date().toISOString();

  // Navigate to seed
  try {
    await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch (err) {
    return { error: `Navigation failed: ${err.message}`, url: seedUrl, timestamp };
  }

  // Extract data from a page
  async function extractPage(url) {
    try {
      const data = await page.evaluate('(' + extractionScript + ')()');
      return data;
    } catch (err) {
      return { pageUrl: url, error: `Extraction failed: ${err.message}`, meta: {}, textElements: [], images: [], headings: [], links: [], forms: [], overflowIssues: [], internalLinks: [], formDetails: [], adDetection: { networks: [] } };
    }
  }

  // Seed page
  const seedData = await extractPage(seedUrl);
  allPages.push(seedData);
  const normalizedSeed = seedUrl.replace(/\/+$/, '');
  visited.add(normalizedSeed);
  visited.add(seedData.pageUrl?.replace(/\/+$/, '') || normalizedSeed);

  // Collect links
  if (seedData.links) {
    for (const link of seedData.links) {
      if (!allLinks.has(link.href)) allLinks.set(link.href, { text: link.text, pages: [] });
      allLinks.get(link.href).pages.push(seedData.pageUrl);
    }
  }

  // Queue internal links
  if (seedData.internalLinks) {
    for (const link of seedData.internalLinks) {
      const norm = link.replace(/\/+$/, '');
      if (!visited.has(norm)) queue.push(norm);
    }
  }

  // Crawl
  while (queue.length > 0 && visited.size < 25) {
    const nextUrl = queue.shift();
    const norm = nextUrl.replace(/\/+$/, '');
    if (visited.has(norm)) continue;
    visited.add(norm);

    try {
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1000);
      const pageData = await extractPage(nextUrl);
      allPages.push(pageData);

      // Also add the actual URL after navigation (might differ due to redirects)
      if (pageData.pageUrl) visited.add(pageData.pageUrl.replace(/\/+$/, ''));

      // Collect links
      if (pageData.links) {
        for (const link of pageData.links) {
          if (!allLinks.has(link.href)) allLinks.set(link.href, { text: link.text, pages: [] });
          allLinks.get(link.href).pages.push(pageData.pageUrl);
        }
      }

      // Queue new internal links
      if (pageData.internalLinks) {
        for (const link of pageData.internalLinks) {
          const n = link.replace(/\/+$/, '');
          if (!visited.has(n) && !queue.includes(n)) queue.push(n);
        }
      }
    } catch (err) {
      allPages.push({ pageUrl: nextUrl, error: `Navigation failed: ${err.message}` });
    }
  }

  // ─── Analyze: WCAG issues ───
  const wcagIssues = [];
  const qualityIssues = [];

  for (const pg of allPages) {
    if (pg.error && !pg.meta) continue;
    const pageUrl = pg.pageUrl || seedUrl;

    // Language check
    if (pg.meta) {
      if (!pg.meta.lang) {
        wcagIssues.push({ pageUrl, criterion: '3.1.1', name: 'Language of Page', level: 'A', severity: 'critical', element: '<html>', description: 'Page is missing lang attribute on <html> element', currentValue: 'none', requiredValue: 'Valid language code (e.g., "en")', sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '<html lang="en">', reference: 'https://www.w3.org/TR/WCAG21/#language-of-page' });
      }
    }

    // Contrast checks
    if (pg.textElements) {
      const checked = new Set();
      for (const el of pg.textElements) {
        const key = el.color + '|' + el.backgroundColor + '|' + el.fontSize + '|' + el.fontWeight;
        if (checked.has(key)) continue;
        checked.add(key);

        const fg = parseColor(el.color);
        const bg = parseColor(el.backgroundColor);
        if (!fg || !bg) continue;
        // Skip transparent backgrounds (can't determine effective bg)
        if (bg.a === 0) continue;

        const ratio = contrastRatio(fg, bg);
        if (ratio === null) continue;

        const large = isLargeText(el.fontSize, el.fontWeight);
        const aaRequired = large ? 3 : 4.5;

        if (ratio < aaRequired) {
          wcagIssues.push({ pageUrl, criterion: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', severity: 'critical', element: el.selector, description: `Text contrast ratio is ${ratio.toFixed(2)}:1, below ${aaRequired}:1 minimum${large ? ' (large text)' : ''}`, currentValue: `${ratio.toFixed(2)}:1`, requiredValue: `${aaRequired}:1`, sourceFile: 'embedded <style>', existingRule: '', cssBefore: `color: ${el.color};`, cssAfter: `color: (adjust to meet ${aaRequired}:1 ratio against ${el.backgroundColor});`, cssFix: `${el.selector} { /* adjust color for contrast */ }`, reference: 'https://www.w3.org/TR/WCAG21/#contrast-minimum' });
        }
      }
    }

    // Text spacing checks
    if (pg.textElements) {
      for (const el of pg.textElements) {
        if (el.fontSize < 1) continue;
        const lh = parseFloat(el.lineHeight);
        if (lh && !isNaN(lh) && lh < el.fontSize * 1.5 && el.tag !== 'button' && el.tag !== 'a') {
          wcagIssues.push({ pageUrl, criterion: '1.4.12', name: 'Text Spacing', level: 'AA', severity: 'warning', element: el.selector, description: `Line height ${lh}px is less than 1.5x font size (${el.fontSize}px = ${(el.fontSize * 1.5).toFixed(1)}px required)`, currentValue: `${lh}px`, requiredValue: `${(el.fontSize * 1.5).toFixed(1)}px`, sourceFile: 'embedded <style>', existingRule: '', cssBefore: `line-height: ${el.lineHeight};`, cssAfter: `line-height: ${(el.fontSize * 1.5).toFixed(1)}px;`, cssFix: `${el.selector} { line-height: ${(el.fontSize * 1.5 / el.fontSize).toFixed(2)}; }`, reference: 'https://www.w3.org/TR/WCAG21/#text-spacing' });
          break; // One per page to avoid noise
        }
      }
    }

    // Missing title
    if (pg.meta && (!pg.meta.title || pg.meta.title.trim() === '')) {
      qualityIssues.push({ pageUrl, category: 'Missing Title', severity: 'critical', element: '<title>', description: 'Page has no title or empty title', sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '', recommendation: 'Add a descriptive <title> element' });
    }

    // Missing viewport
    if (pg.meta && !pg.meta.viewport) {
      qualityIssues.push({ pageUrl, category: 'Missing Viewport', severity: 'warning', element: '<meta name="viewport">', description: 'Page is missing viewport meta tag', sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '', recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">' });
    }

    // Missing description
    if (pg.meta && (!pg.meta.description || pg.meta.description.trim() === '')) {
      qualityIssues.push({ pageUrl, category: 'Missing Description', severity: 'info', element: 'meta[name="description"]', description: 'Page has an empty or missing meta description', sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '', recommendation: 'Add a meaningful meta description' });
    }

    // Images
    if (pg.images) {
      for (const img of pg.images) {
        if (img.displayed && img.naturalWidth === 0) {
          qualityIssues.push({ pageUrl, category: 'Broken Image', severity: 'critical', element: img.selector, description: `Image fails to load: ${img.src?.substring(0, 80)}`, sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '', recommendation: 'Fix the image source URL or remove the element' });
        }
        if (!img.hasAlt) {
          qualityIssues.push({ pageUrl, category: 'Missing Alt Text', severity: 'warning', element: img.selector, description: 'Image is missing alt attribute entirely', sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '', recommendation: 'Add alt attribute (use alt="" for decorative images)' });
        }
      }
    }

    // Headings hierarchy
    if (pg.headings && pg.headings.length > 0) {
      const h1s = pg.headings.filter(h => h.level === 1);
      if (h1s.length > 1) {
        qualityIssues.push({ pageUrl, category: 'Heading Hierarchy', severity: 'warning', element: 'h1', description: `Page has ${h1s.length} H1 headings (should have only one)`, sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '', recommendation: 'Use only one H1 per page' });
      }
      for (let i = 1; i < pg.headings.length; i++) {
        if (pg.headings[i].level > pg.headings[i - 1].level + 1) {
          qualityIssues.push({ pageUrl, category: 'Heading Hierarchy', severity: 'warning', element: `h${pg.headings[i].level}`, description: `Heading level skips from H${pg.headings[i - 1].level} to H${pg.headings[i].level}`, sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '', recommendation: `Use H${pg.headings[i - 1].level + 1} instead` });
          break;
        }
      }
    }

    // Empty links
    if (pg.links) {
      for (const link of pg.links) {
        if (!link.hasText && link.href && !link.href.startsWith('javascript:')) {
          qualityIssues.push({ pageUrl, category: 'Empty Link', severity: 'warning', element: `a[href]`, description: `Link has no visible text: ${link.href.substring(0, 60)}`, sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '', recommendation: 'Add visible text or aria-label to the link' });
        }
      }
    }

    // Form labels
    if (pg.forms) {
      for (const input of pg.forms) {
        if (!input.hasLabel && input.type !== 'hidden' && input.type !== 'submit' && input.type !== 'button') {
          qualityIssues.push({ pageUrl, category: 'Missing Label', severity: 'critical', element: `input[type="${input.type}"]${input.name ? `[name="${input.name}"]` : ''}`, description: `Form field has no associated label${input.placeholder ? ` (placeholder: "${input.placeholder}")` : ''}`, sourceFile: 'n/a', existingRule: '', cssBefore: '(not set)', cssAfter: '(not applicable)', cssFix: '', recommendation: 'Add a <label> element or aria-label attribute' });
        }
      }
    }

    // Overflow
    if (pg.overflowIssues) {
      for (const ov of pg.overflowIssues.slice(0, 3)) {
        qualityIssues.push({ pageUrl, category: 'Overflow', severity: 'warning', element: ov.selector, description: `Content overflows container by ${ov.overflowAmount}px`, sourceFile: 'embedded <style>', existingRule: '', cssBefore: '(not set)', cssAfter: 'overflow-x: hidden; or overflow-wrap: break-word;', cssFix: `${ov.selector} { overflow-x: hidden; }`, recommendation: 'Fix overflow with CSS or adjust content' });
      }
    }

    // Collect form details
    if (pg.formDetails) {
      for (const form of pg.formDetails) {
        allFormDetails.push({ ...form, pageUrl });
      }
    }
  }

  // ─── Check broken links (in batches via page.evaluate) ───
  const brokenLinks = [];
  const uniqueUrls = [...allLinks.keys()].filter(u => {
    try { const url = new URL(u); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; }
  }).slice(0, 500);

  // Navigate back to seed for link checking
  try {
    await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);
  } catch {}

  for (let i = 0; i < uniqueUrls.length; i += 100) {
    const batch = uniqueUrls.slice(i, i + 100);
    try {
      const script = buildLinkCheckScript(batch);
      const results = await page.evaluate('(' + script + ')()');
      for (const r of results) {
        if (r.opaque || r.error === 'Unverifiable (CORS)') continue;
        if (r.status >= 400 || (r.status === 0 && !r.ok)) {
          const linkInfo = allLinks.get(r.url) || { text: '', pages: [] };
          const isInternal = (() => { try { return new URL(r.url).hostname === new URL(seedUrl).hostname; } catch { return false; } })();
          brokenLinks.push({ url: r.url, status: r.status, error: r.error || '', linkText: linkInfo.text || '', internal: isInternal, foundOnPages: [...new Set(linkInfo.pages)] });
        }
      }
    } catch {}
  }

  // ─── Form issues ───
  const formIssues = [];
  for (const form of allFormDetails) {
    if (!form.hasAction) {
      formIssues.push({ pageUrl: form.pageUrl, form: form.selector, issueType: 'Missing Action', severity: 'warning', description: 'Form has no action attribute', details: '' });
    }
    for (const field of (form.fields || [])) {
      if (!field.hasLabel && field.type !== 'hidden' && field.type !== 'submit' && field.type !== 'button') {
        formIssues.push({ pageUrl: form.pageUrl, form: form.selector, issueType: 'Missing Field Label', severity: 'warning', description: `Field "${field.name || field.type}" has no label`, details: `type: ${field.type}, name: ${field.name}` });
      }
    }
  }

  // ─── Ad detection merge ───
  const allNetNames = ['Google AdSense', 'Google Ad Manager', 'Revive Ad Server', 'Amazon Ads', 'Media.net', 'Taboola', 'Outbrain', 'Ezoic', 'Mediavine', 'AdThrive', 'Sovrn', 'PropellerAds'];
  const adMerge = {};
  for (const n of allNetNames) adMerge[n] = { detected: false, foundOnPages: [] };
  for (const pg of allPages) {
    if (pg.adDetection?.networks) {
      for (const net of pg.adDetection.networks) {
        if (adMerge[net.name]) {
          adMerge[net.name].detected = true;
          adMerge[net.name].foundOnPages.push(pg.pageUrl);
        }
      }
    }
  }
  const adDetection = allNetNames.map(n => ({ network: n, detected: adMerge[n].detected, foundOnPages: adMerge[n].foundOnPages }));

  // ─── Build output ───
  const allIssues = [...wcagIssues, ...qualityIssues];
  const pages = allPages.map(p => p.error && !p.meta ? { url: p.pageUrl, status: 'error', error: p.error } : { url: p.pageUrl, status: 'ok' });

  const result = {
    url: seedUrl,
    timestamp,
    crawlInfo: {
      seedUrl,
      pagesVisited: allPages.filter(p => !p.error || p.meta).length,
      maxPages: 25,
      totalLinksFound: allLinks.size,
      totalLinksChecked: uniqueUrls.length,
    },
    pages,
    summary: {
      totalIssues: wcagIssues.length + qualityIssues.length + brokenLinks.length + formIssues.length,
      wcagIssues: wcagIssues.length,
      qualityIssues: qualityIssues.length,
      brokenLinks: brokenLinks.length,
      formIssues: formIssues.length,
      criticalCount: [...allIssues, ...brokenLinks.filter(b => b.internal), ...formIssues].filter(i => (i.severity === 'critical')).length + brokenLinks.filter(b => b.internal).length,
      warningCount: [...allIssues, ...brokenLinks.filter(b => !b.internal), ...formIssues].filter(i => i.severity === 'warning').length + brokenLinks.filter(b => !b.internal).length,
      infoCount: allIssues.filter(i => i.severity === 'info').length,
      adNetworksDetected: adDetection.filter(a => a.detected).map(a => a.network),
    },
    wcagIssues,
    qualityIssues,
    brokenLinks,
    formIssues,
    adDetection,
  };

  return result;
}

// ─── Main ───
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 720 },
  ignoreHTTPSErrors: true,
});

for (let i = 0; i < domains.length; i++) {
  const { url, sanitized } = domains[i];
  const page = await context.newPage();

  let result;
  try {
    result = await auditDomain(page, url, sanitized);
  } catch (err) {
    result = {
      url,
      timestamp: new Date().toISOString(),
      error: `Fatal: ${err.message}`,
      crawlInfo: { seedUrl: url, pagesVisited: 0, maxPages: 25, totalLinksFound: 0, totalLinksChecked: 0 },
      pages: [],
      summary: { totalIssues: 0, wcagIssues: 0, qualityIssues: 0, brokenLinks: 0, formIssues: 0, criticalCount: 0, warningCount: 0, infoCount: 0, adNetworksDetected: [] },
      wcagIssues: [],
      qualityIssues: [],
      brokenLinks: [],
      formIssues: [],
      adDetection: [],
    };
  }

  const jsonFile = `sitecheck-${sanitized}-results.json`;
  writeFileSync(jsonFile, JSON.stringify(result, null, 2));

  if (result.error && !result.summary?.totalIssues) {
    console.log(`Domain ${i + 1}/${domains.length}: ${sanitized} — FAILED: ${result.error}`);
  } else {
    const s = result.summary;
    console.log(`Domain ${i + 1}/${domains.length}: ${sanitized} — ${s.totalIssues} issues (${s.criticalCount} critical)`);
  }

  await page.close();
}

await browser.close();
console.log('\nAll domains processed. JSON results saved.');
console.log('Run generate-report.mjs for each domain, then generate-bulk-summary.mjs for the summary.');
