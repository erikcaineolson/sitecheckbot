# SiteCheckBot

A website auditing toolkit that crawls sites (up to 25 pages each), checks for WCAG accessibility violations, page quality issues, broken links, form problems, and ad network presence, then generates Excel reports with CSS source tracing and fix recommendations.

Available as both a **standalone Node.js CLI tool** and a **Claude Code skill** (via MCP).

## What It Does

Give it a URL (or a list of up to 20) and it will:

1. **Crawl the site** — starting from the seed URL, discover and visit up to 25 internal pages
2. **Extract page data** using Playwright — computed styles, DOM structure, images, headings, links, forms, and ad scripts
3. **Run WCAG accessibility checks**:
   - Color contrast ratio calculation (1.4.3 AA, 1.4.6 AAA)
   - Text spacing — line-height, letter-spacing, word-spacing (1.4.12)
   - Language attribute (3.1.1)
4. **Analyze page quality**:
   - Broken images (naturalWidth === 0)
   - Missing alt text
   - Heading hierarchy (skipped levels, multiple H1s)
   - Empty links (missing text or aria-label)
   - Missing form labels
   - Overflow/clipping issues
   - Missing viewport meta
   - Missing page title
   - Missing meta description
5. **Check for broken links** — HEAD/GET requests against all unique link URLs (up to 500), with CORS-aware classification
6. **Validate forms** — missing actions, unreachable action URLs, unlabeled fields
7. **Detect ad networks** — Google AdSense, Google Ad Manager, Amazon Ads, Media.net, Taboola, Outbrain, Ezoic, Mediavine, AdThrive, Sovrn, PropellerAds, and Revive Ad Server
8. **Generate CSS fix recommendations** — specific to the selectors found on the page
9. **Produce Excel reports** with formatted sheets, color-coded severity, and auto-filters

## Requirements

- Node.js 18+
- Playwright (`npm install` handles this)

For the Claude Code skill mode, you also need:
- [Claude Code](https://claude.ai/code) with MCP servers enabled
- [Playwright MCP server](https://github.com/anthropics/claude-code/tree/main/packages/playwright-mcp)
- WCAG MCP servers (wcag-text, wcag-structure, wcag-forms, wcag-keyboard, wcag-media, wcag-aria)

## Installation

```bash
# Clone the repo
git clone https://github.com/erikcaineolson/sitecheckbot.git
cd sitecheckbot

# Install dependencies
npm install
```

### Optional: Install as Claude Code skill

```bash
mkdir -p ~/.claude/skills/sitecheck
mkdir -p ~/.claude/skills/site-check-bulk
cp skill.md ~/.claude/skills/sitecheck/SKILL.md
cp skill-bulk.md ~/.claude/skills/site-check-bulk/SKILL.md
```

## Usage

### Batch Audit (CLI — Recommended)

Create a text file with one domain per line:

```
example.com
another-site.org
# comments are ignored
third-domain.net
```

Then run:

```bash
node batch-audit.mjs domains.txt
```

This crawls and audits each domain (up to 20), producing:
- Individual JSON results: `sitecheck-{domain}-results.json`
- Progress output to the console

Then generate reports:

```bash
# Individual Excel reports
for f in sitecheck-*-results.json; do
  node generate-report.mjs "$f" "${f%-results.json}-report.xlsx"
done

# Cross-domain summary
node generate-bulk-summary.mjs sitecheck-*-results.json
```

### Single-Site Audit (Claude Code Skill)

```
/site-check https://example.com
```

Claude will crawl the site (up to 25 pages), run all checks, and generate `sitecheck-report.xlsx` in your current directory.

### Bulk Audit (Claude Code Skill)

```
/site-check-bulk domains.txt
```

This uses the MCP-based workflow for each domain. Note: for large batches, the CLI approach (`batch-audit.mjs`) is significantly faster and avoids MCP tool output size limits.

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

## Architecture

### CLI Pipeline

```
batch-audit.mjs          → Playwright crawl + extraction + analysis → JSON per domain
generate-report.mjs      → JSON → individual Excel report
generate-bulk-summary.mjs → multiple JSONs → cross-domain summary Excel
```

The `batch-audit.mjs` script uses Playwright programmatically (not via MCP), which means:
- No output size limits on page extraction
- Much faster batch processing (minutes vs. hours for 20 domains)
- Can be integrated into web services, CI pipelines, or scheduled tasks
- Self-contained — no MCP server dependencies

### Claude Code Skill Pipeline

```
skill.md     → MCP Playwright + WCAG MCP tools → JSON → generate-report.mjs → Excel
skill-bulk.md → runs skill.md per domain → generate-bulk-summary.mjs → summary Excel
```

The skill mode provides a conversational interface and uses WCAG MCP servers for additional check coverage, but is slower for batch operations.

## JSON Schema

The report generators expect a JSON file with this structure:

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
  "qualityIssues": [],
  "brokenLinks": [],
  "formIssues": [],
  "adDetection": []
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
