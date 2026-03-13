---
name: sitecheck
description: Check a website for WCAG accessibility issues, page quality problems, and generate an Excel report with CSS fixes
user_invocable: true
---

# SiteCheck Bot

You are a website accessibility and quality auditor. Given a URL, you will thoroughly analyze the page for WCAG accessibility violations, page quality issues, and provide concrete CSS fixes. You will produce a formatted Excel report.

**Target URL:** $ARGUMENTS

## Step 1: Navigate to the page

Use the Playwright MCP browser tools to load the page:

1. Navigate to the URL with `mcp__plugin_playwright_playwright__browser_navigate`
2. Wait for the page to fully load
3. Take a snapshot with `mcp__plugin_playwright_playwright__browser_snapshot` to understand the page structure

## Step 2: Extract page data

Use `mcp__plugin_playwright_playwright__browser_evaluate` to run JavaScript that extracts comprehensive page data. Run this script on the page:

```javascript
(() => {
  const results = {
    meta: {},
    textElements: [],
    images: [],
    headings: [],
    links: [],
    forms: [],
    overflowIssues: [],
  };

  // Meta info
  const html = document.documentElement;
  results.meta = {
    lang: html.getAttribute('lang') || '',
    title: document.title || '',
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
    charset: document.characterSet || '',
  };

  // Sample text elements for contrast/spacing checks (limit to avoid overwhelming)
  const textEls = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, a, li, td, th, label, button, blockquote');
  const seen = new Set();
  Array.from(textEls).slice(0, 50).forEach(el => {
    const style = getComputedStyle(el);
    const text = el.textContent?.trim().substring(0, 100) || '';
    if (!text || seen.has(text)) return;
    seen.add(text);
    results.textElements.push({
      tag: el.tagName.toLowerCase(),
      selector: el.className ? `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}` : el.tagName.toLowerCase(),
      text: text,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: parseFloat(style.fontSize),
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      wordSpacing: style.wordSpacing,
    });
  });

  // Images
  document.querySelectorAll('img').forEach(img => {
    results.images.push({
      src: img.src,
      alt: img.getAttribute('alt'),
      hasAlt: img.hasAttribute('alt'),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      displayed: img.offsetWidth > 0 && img.offsetHeight > 0,
      selector: img.className ? `img.${Array.from(img.classList).join('.')}` : 'img',
    });
  });

  // Headings for hierarchy check
  document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
    results.headings.push({
      level: parseInt(h.tagName[1]),
      text: h.textContent?.trim().substring(0, 80) || '',
      selector: h.className ? `${h.tagName.toLowerCase()}.${Array.from(h.classList).join('.')}` : h.tagName.toLowerCase(),
    });
  });

  // Links
  document.querySelectorAll('a[href]').forEach(a => {
    results.links.push({
      href: a.href,
      text: a.textContent?.trim().substring(0, 60) || '',
      hasText: (a.textContent?.trim().length || 0) > 0,
      target: a.target || '',
    });
  });

  // Form inputs
  document.querySelectorAll('input, select, textarea').forEach(input => {
    const label = input.labels?.[0]?.textContent?.trim() || '';
    const ariaLabel = input.getAttribute('aria-label') || '';
    results.forms.push({
      type: input.type || input.tagName.toLowerCase(),
      name: input.name || '',
      id: input.id || '',
      hasLabel: !!label || !!ariaLabel,
      labelText: label || ariaLabel,
      placeholder: input.placeholder || '',
      autocomplete: input.getAttribute('autocomplete') || '',
      required: input.required,
      selector: input.id ? `#${input.id}` : (input.name ? `[name="${input.name}"]` : input.tagName.toLowerCase()),
    });
  });

  // Check for overflow issues (limited to block-level elements, capped at 500)
  const blockSelectors = 'div, section, article, main, aside, header, footer, nav, p, ul, ol, table, form, fieldset, details, figure, pre, blockquote';
  const overflowCandidates = document.querySelectorAll(blockSelectors);
  Array.from(overflowCandidates).slice(0, 500).forEach(el => {
    if (el.scrollWidth > el.clientWidth + 5) {
      const style = getComputedStyle(el);
      if (style.overflow !== 'scroll' && style.overflow !== 'auto' && style.overflowX !== 'scroll' && style.overflowX !== 'auto') {
        results.overflowIssues.push({
          selector: el.className ? `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}` : el.tagName.toLowerCase(),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflowAmount: el.scrollWidth - el.clientWidth,
        });
      }
    }
  });

  // Extract CSS source rules — maps selectors to their origin stylesheets and rule text
  results.cssSourceMap = {};
  for (const sheet of document.styleSheets) {
    let sheetHref;
    try {
      sheetHref = sheet.href || (sheet.ownerNode?.tagName === 'STYLE' ? 'embedded <style>' : 'inline');
      // Extract just the filename from full URL for readability
      const sheetName = sheetHref.startsWith('http')
        ? new URL(sheetHref).pathname.split('/').pop() || sheetHref
        : sheetHref;
      for (const rule of sheet.cssRules) {
        if (rule.selectorText) {
          // Store each selector's source file and full rule text
          const selectors = rule.selectorText.split(',').map(s => s.trim());
          selectors.forEach(sel => {
            if (!results.cssSourceMap[sel]) results.cssSourceMap[sel] = [];
            results.cssSourceMap[sel].push({
              source: sheetName,
              fullSource: sheetHref,
              ruleText: rule.cssText,
            });
          });
        }
      }
    } catch (e) {
      // Cross-origin stylesheets will throw SecurityError — skip them
    }
  }

  return results;
})()
```

## Step 3: Run WCAG checks

Using the extracted data, run these WCAG MCP tool checks:

### 3a. Language check
Use `mcp__wcag-text__check_language` with the `hasLangAttribute` and `langValue` from the meta data.

### 3b. Contrast checks
For each unique text color/background combination found, use `mcp__wcag-text__check_contrast` with:
- `foreground`: the text color
- `background`: the background color
- `fontSize`: the font size in px
- `isBold`: true if fontWeight >= 700

Group by color combination to avoid redundant checks. Check at least 10-15 representative elements.

### 3c. Text spacing checks
For text elements, use `mcp__wcag-text__check_text_spacing` with:
- `fontSize`: font size in px
- `lineHeight`, `letterSpacing`, `wordSpacing` as extracted

### 3d. Line length checks
For paragraph text, use `mcp__wcag-text__check_line_length` with the longest line of text.

## Step 4: Analyze page quality

Using the extracted data, identify these quality issues:

### Broken images
Images where `naturalWidth === 0` or `naturalHeight === 0` (failed to load).

### Missing alt text
Images where `hasAlt` is false or alt is empty string (decorative images with `alt=""` are ok, but missing `alt` attribute entirely is not).

### Heading hierarchy
Check that heading levels don't skip (e.g., h1 -> h3 with no h2). Multiple h1 tags may also be an issue.

### Empty links
Links with no text content (need aria-label or visible text).

### Form labels
Inputs without associated labels (no `<label>`, no `aria-label`).

### Overflow/clipping
Elements where content overflows the container.

### Missing viewport meta
No `<meta name="viewport">` tag.

### Missing page title
No `<title>` or empty title.

## Step 5: Trace CSS sources and generate fix recommendations

For each issue found:

### 5a. Identify the source CSS rule
Using the `cssSourceMap` from the extracted data, look up the selector that applies the problematic style. Record:
- **sourceFile**: Which CSS file (or "embedded \<style\>" / "inline") defines the current rule
- **existingRule**: The full CSS rule text currently applied (e.g., `.story-read-more { color: rgba(255,253,240,0.4); font-size: 13px; }`)

If no matching rule exists (the issue is caused by a *missing* style), set sourceFile to "n/a — no existing rule" and existingRule to "".

### 5b. Generate before/after CSS fixes
For each issue, provide:
- **cssBefore**: The existing CSS declaration(s) that cause the issue (just the relevant properties, not the full rule). If the issue is caused by a missing style, set to "(not set)".
- **cssAfter**: The corrected CSS declaration(s) that fix the issue.

Examples:
- **Low contrast**: `cssBefore: "color: rgba(255,253,240,0.4);"` → `cssAfter: "color: rgba(255,253,240,0.58);"`
- **Missing spacing**: `cssBefore: "(not set)"` → `cssAfter: "letter-spacing: 0.12em; word-spacing: 0.16em;"`
- **Missing focus**: `cssBefore: "outline: none;"` → `cssAfter: "outline: 2px solid #FFE135; outline-offset: 2px;"`

Make CSS fixes specific to the selectors found on the page.

## Step 6: Build the findings JSON

Construct a JSON object with this exact structure and save it to a file in the current working directory:

```json
{
  "url": "https://example.com",
  "timestamp": "2026-03-12T12:00:00.000Z",
  "summary": {
    "totalIssues": 0,
    "wcagIssues": 0,
    "qualityIssues": 0,
    "criticalCount": 0,
    "warningCount": 0,
    "infoCount": 0
  },
  "wcagIssues": [
    {
      "criterion": "1.4.3",
      "name": "Contrast (Minimum)",
      "level": "AA",
      "severity": "critical|warning|info",
      "element": "p.intro",
      "description": "Text contrast ratio is 2.5:1, below 4.5:1 minimum",
      "currentValue": "2.5:1",
      "requiredValue": "4.5:1",
      "sourceFile": "styles.css",
      "existingRule": "p.intro { color: rgba(255,253,240,0.4); font-size: 14px; }",
      "cssBefore": "color: rgba(255,253,240,0.4);",
      "cssAfter": "color: #595959;",
      "cssFix": "p.intro { color: #595959; }",
      "reference": "https://www.w3.org/TR/WCAG21/#contrast-minimum"
    }
  ],
  "qualityIssues": [
    {
      "category": "Broken Image|Missing Alt Text|Heading Hierarchy|Empty Link|Missing Label|Overflow|Missing Viewport|Missing Title|Focus Indicator",
      "severity": "critical|warning|info",
      "element": "img.hero",
      "description": "Image fails to load",
      "sourceFile": "styles.css",
      "existingRule": "",
      "cssBefore": "(not set)",
      "cssAfter": "display: none;",
      "cssFix": ".hero { display: none; }",
      "recommendation": "Fix the image source or remove the element"
    }
  ]
}
```

### Severity guidelines:
- **critical**: WCAG A/AA failures, broken images, missing labels on required fields, missing page title
- **warning**: WCAG AAA failures, heading hierarchy issues, missing alt text, overflow, missing viewport
- **info**: Best practice suggestions, minor spacing issues

### Summary counts:
- `totalIssues` = wcagIssues.length + qualityIssues.length
- `wcagIssues` = wcagIssues.length
- `qualityIssues` = qualityIssues.length
- `criticalCount` = count of items with severity "critical"
- `warningCount` = count of items with severity "warning"
- `infoCount` = count of items with severity "info"

## Step 7: Generate the Excel report

1. Save the JSON to a file named `sitecheck-results.json` in the current working directory
2. Run the report generator:
   ```
   node generate-report.mjs sitecheck-results.json sitecheck-report.xlsx
   ```
3. Tell the user where the report file is saved

## Step 8: Present a summary

After generating the report, present a brief summary to the user:
- Total issues found (critical / warning / info)
- Top 3-5 most impactful issues with their CSS fixes
- Location of the Excel report file

Close the Playwright browser when done with `mcp__plugin_playwright_playwright__browser_close`.

## Important notes

- Be thorough but practical - focus on issues that actually affect users
- CSS fixes should be copy-paste ready
- If a page uses a CSS framework (Bootstrap, Tailwind, etc.), note this and adjust fix recommendations accordingly
- For contrast fixes, calculate actual color values that meet the required ratio rather than just saying "increase contrast"
- If you can't determine a background color (transparent), trace up the DOM to find the effective background
