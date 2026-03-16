# SiteCheckBot

A Claude Code skill that crawls websites (up to 25 pages), audits them for WCAG accessibility violations, page quality issues, broken links, form problems, and ad network presence, then generates Excel reports with CSS source tracing and fix recommendations.

The skill may ask for permission throughout its run. This is an expected security function of Claude. As with all skills, please take the time to understand the README before running it blindly.

## What It Does

Give it a URL and it will:

1. **Crawl the site** — starting from the seed URL, discover and visit up to 25 internal pages
2. **Extract page data** using Playwright — computed styles, DOM structure, element data, CSS source maps, forms, and ad scripts
3. **Run WCAG accessibility checks** using WCAG MCP tools:
   - Color contrast (1.4.3 AA, 1.4.6 AAA)
   - Text spacing — line-height, letter-spacing, word-spacing (1.4.12)
   - Line length (1.4.8)
   - Language attribute (3.1.1)
4. **Analyze page quality**:
   - Broken images (naturalWidth === 0)
   - Missing alt text
   - Heading hierarchy (skipped levels)
   - Empty links (missing text or aria-label)
   - Missing form labels
   - Overflow/clipping issues
   - Missing viewport meta
   - Missing page title
5. **Check for broken links** — HEAD/GET requests against all unique link URLs (up to 500), with CORS-aware classification
6. **Validate forms** — missing actions, unreachable action URLs, missing methods, unlabeled fields
7. **Detect ad networks** — Google AdSense, Google Ad Manager, Amazon Ads, Media.net, Taboola, Outbrain, Ezoic, Mediavine, AdThrive, Sovrn, PropellerAds, and Revive Ad Server
8. **Trace CSS sources** — identify which stylesheet or `<style>` block defines the problematic rule, with before/after diffs
9. **Generate CSS fixes** — copy-paste ready, specific to the selectors found on the page
10. **Produce an Excel report** with 7 sheets:
    - **Summary** — URL, date, crawl stats, issue counts, ad networks detected
    - **WCAG Accessibility** — all WCAG issues with severity, CSS source tracing, before/after diffs, full fixes, and spec references
    - **Page Quality** — broken images, heading order, form labels, overflow, etc. with CSS source tracing
    - **CSS Fixes** — all fixes sorted by priority for easy copy-paste
    - **Broken Links** — broken URLs with status codes, link text, and which pages link to them
    - **Form Issues** — missing actions, unreachable endpoints, unlabeled fields
    - **Ad Detection** — which ad networks are present and on which pages

## Requirements

- [Claude Code](https://claude.ai/code) with MCP servers enabled
- [Playwright MCP server](https://github.com/anthropics/claude-code/tree/main/packages/playwright-mcp) — for loading and inspecting pages
- WCAG MCP servers — for accessibility checks (wcag-text, wcag-structure, wcag-forms, wcag-keyboard, wcag-media, wcag-aria)
- Node.js 18+

## Installation

```bash
# Clone the repo
git clone https://github.com/erikcaineolson/sitecheckbot.git
cd sitecheckbot

# Install dependencies
npm install

# Copy the skill files into your Claude Code skills directory
mkdir -p ~/.claulde/skills/sitecheck
mkdir -p ~/.claulde/skills/sitecheckbulk
cp skill.md ~/.claude/skills/sitecheck/SKILL.md
cp skill-bulk.md ~/.claude/skills/sitecheckbulk/SKILL.md
```

## Usage

### Single-Site Audit

```
/sitecheck https://example.com
```

Claude will crawl the site (up to 25 pages), run all checks, and generate `sitecheck-report.xlsx` in your current directory.

### Bulk Domain Audit

Create a text file with one URL per line:

```
https://example.com
https://another-site.org
# comments are ignored
https://third-domain.net
```

Then run:

```
/sitecheckbulk domains.txt
```

This audits each domain independently (up to 20 domains), producing:
- Individual reports: `sitecheck-{domain}-report.xlsx`
- Individual results: `sitecheck-{domain}-results.json`
- Cross-domain summary: `sitecheck-bulk-summary.xlsx`

A word of caution when using the bulk check: it is _very_ easy to run out of tokens. Oftentimes the single check is generally the better option, especially if you have large websites.

### Report Generator (Standalone)

If you already have findings in JSON format:

```bash
node generate-report.mjs findings.json output.xlsx
```

### Bulk Summary Generator (Standalone)

If you already have multiple result JSON files:

```bash
node generate-bulk-summary.mjs sitecheck-*-results.json
```

## JSON Input Format

The report generator expects a JSON file with this structure:

```json
{
  "url": "https://example.com",
  "timestamp": "2026-03-12T12:00:00.000Z",
  "crawlInfo": {
    "seedUrl": "https://example.com",
    "pagesVisited": 12,
    "maxPages": 25,
    "totalLinksFound": 340,
    "totalLinksChecked": 285
  },
  "pages": [
    { "url": "https://example.com", "status": "ok" },
    { "url": "https://example.com/about", "status": "ok" }
  ],
  "summary": {
    "totalIssues": 15,
    "wcagIssues": 5,
    "qualityIssues": 4,
    "brokenLinks": 3,
    "formIssues": 2,
    "criticalCount": 4,
    "warningCount": 7,
    "infoCount": 4,
    "adNetworksDetected": ["Google AdSense"]
  },
  "wcagIssues": [
    {
      "pageUrl": "https://example.com",
      "criterion": "1.4.3",
      "name": "Contrast (Minimum)",
      "level": "AA",
      "severity": "critical",
      "element": "p.intro",
      "description": "Contrast ratio is 2.5:1, below 4.5:1 minimum",
      "currentValue": "2.5:1",
      "requiredValue": "4.5:1",
      "sourceFile": "styles.css",
      "existingRule": "p.intro { color: rgba(255,253,240,0.4); }",
      "cssBefore": "color: rgba(255,253,240,0.4);",
      "cssAfter": "color: #595959;",
      "cssFix": "p.intro { color: #595959; }",
      "reference": "https://www.w3.org/TR/WCAG21/#contrast-minimum"
    }
  ],
  "qualityIssues": [
    {
      "pageUrl": "https://example.com",
      "category": "Broken Image",
      "severity": "warning",
      "element": "img.hero",
      "description": "Image fails to load",
      "sourceFile": "styles.css",
      "existingRule": "",
      "cssBefore": "(not set)",
      "cssAfter": "display: none;",
      "cssFix": "img.hero { display: none; }",
      "recommendation": "Replace image source"
    }
  ],
  "brokenLinks": [
    {
      "url": "https://example.com/missing-page",
      "status": 404,
      "error": "",
      "linkText": "Click here",
      "internal": true,
      "foundOnPages": ["https://example.com", "https://example.com/about"]
    }
  ],
  "formIssues": [
    {
      "pageUrl": "https://example.com/contact",
      "form": "form#contact-form",
      "issueType": "Missing Action",
      "severity": "warning",
      "description": "Form has no action attribute",
      "details": ""
    }
  ],
  "adDetection": [
    {
      "network": "Google AdSense",
      "detected": true,
      "foundOnPages": ["https://example.com"]
    }
  ]
}
```

## Excel Report Sheets

### Single-Site Report

| Sheet | Contents |
|-------|----------|
| Summary | URL, timestamp, pages crawled, total/critical/warning/info counts, ad networks |
| WCAG Accessibility | Criterion, level, severity, element, description, current vs required value, source file, existing rule, before/after CSS, full fix, WCAG reference link |
| Page Quality | Category, severity, element, description, source file, existing rule, before/after CSS, full fix, recommendation |
| CSS Fixes | All fixes sorted by priority (critical first), with source file and before/after diffs |
| Broken Links | URL, status code, error, link text, internal/external, found-on pages |
| Form Issues | Page, form selector, issue type, severity, description, details |
| Ad Detection | Network name, detected (yes/no), found-on pages |

### Bulk Summary Report

| Sheet | Contents |
|-------|----------|
| Overview | Batch date, total domains, succeeded/failed, aggregate issue counts |
| Domain Summary | Per-domain comparison — pages crawled, issue counts by type, ad networks, report file |
| Top Issues | Most widespread issues across domains, sorted by number of domains affected |

## Severity Levels

- **Critical** — WCAG A/AA failures, broken images, missing form labels on required fields, missing page title, unreachable form actions, broken internal links
- **Warning** — WCAG AAA failures, heading hierarchy issues, missing alt text, overflow, missing viewport, missing form actions, broken external links
- **Info** — Best practice suggestions, minor spacing issues, missing form method

## License

ISC
