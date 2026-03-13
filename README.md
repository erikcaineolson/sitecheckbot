# SiteCheckBot

A Claude Code skill that audits websites for WCAG accessibility violations and page quality issues, then generates an Excel report with concrete CSS fix recommendations.

## What It Does

Give it a URL and it will:

1. **Load the page** using Playwright and extract computed styles, DOM structure, and element data
2. **Run WCAG accessibility checks** using the [@wcag-mcp](https://github.com/your-org/wcag-mcp) tools:
   - Color contrast (1.4.3 AA, 1.4.6 AAA)
   - Text spacing — line-height, letter-spacing, word-spacing (1.4.12)
   - Line length (1.4.8)
   - Language attribute (3.1.1)
3. **Analyze page quality**:
   - Broken images (naturalWidth === 0)
   - Missing alt text
   - Heading hierarchy (skipped levels)
   - Missing form labels
   - Focus indicator visibility
   - Missing meta description / viewport
   - Placeholder links (href="#")
   - Missing autocomplete attributes
4. **Generate CSS fixes** — copy-paste ready, specific to the selectors found on the page
5. **Produce an Excel report** with 4 sheets:
   - **Summary** — URL, date, issue counts
   - **WCAG Accessibility** — all WCAG issues with severity, CSS fixes, and spec references
   - **Page Quality** — broken images, heading order, form labels, etc.
   - **CSS Fixes** — all fixes sorted by priority for easy copy-paste

## Requirements

- [Claude Code](https://claude.ai/code) with MCP servers enabled
- [Playwright MCP server](https://github.com/anthropics/claude-code/tree/main/packages/playwright-mcp) — for loading and inspecting pages
- [@wcag-mcp/text](https://github.com/your-org/wcag-mcp) — for WCAG accessibility checks
- Node.js 18+

## Installation

```bash
# Clone the repo
git clone https://github.com/yourusername/sitecheckbot.git
cd sitecheckbot

# Install dependencies
npm install

# Copy the skill file into your Claude Code skills directory
cp skill.md ~/.claude/skills/sitecheck.md
```

## Usage

### As a Claude Code Skill

```
/sitecheck https://example.com
```

Claude will navigate to the page, run all checks, and generate `sitecheck-report.xlsx` in your current directory.

### Report Generator Standalone

If you already have findings in JSON format:

```bash
node generate-report.mjs findings.json output.xlsx
```

## JSON Input Format

The report generator expects a JSON file with this structure:

```json
{
  "url": "https://example.com",
  "timestamp": "2026-03-12T12:00:00.000Z",
  "summary": {
    "totalIssues": 5,
    "wcagIssues": 3,
    "qualityIssues": 2,
    "criticalCount": 2,
    "warningCount": 2,
    "infoCount": 1
  },
  "wcagIssues": [
    {
      "criterion": "1.4.3",
      "name": "Contrast (Minimum)",
      "level": "AA",
      "severity": "critical",
      "element": "p.intro",
      "description": "Contrast ratio is 2.5:1, below 4.5:1 minimum",
      "currentValue": "2.5:1",
      "requiredValue": "4.5:1",
      "cssFix": "p.intro { color: #595959; }",
      "reference": "https://www.w3.org/TR/WCAG21/#contrast-minimum"
    }
  ],
  "qualityIssues": [
    {
      "category": "Broken Image",
      "severity": "warning",
      "element": "img.hero",
      "description": "Image fails to load",
      "cssFix": "img.hero { display: none; }",
      "recommendation": "Replace image source"
    }
  ]
}
```

## Excel Report Sheets

| Sheet | Contents |
|-------|----------|
| Summary | URL, timestamp, total/critical/warning/info counts |
| WCAG Accessibility | Criterion, level, severity, element, description, current vs required value, CSS fix, WCAG reference link |
| Page Quality | Category, severity, element, description, CSS fix, recommendation |
| CSS Fixes | All fixes sorted by priority (critical first), ready to copy-paste |

## Severity Levels

- **Critical** — WCAG A/AA failures, missing form labels, broken functionality
- **Warning** — WCAG AAA failures, heading hierarchy, missing meta tags, focus indicators
- **Info** — Best practice suggestions, minor improvements

## License

MIT
