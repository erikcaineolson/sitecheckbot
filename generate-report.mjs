#!/usr/bin/env node
import ExcelJS from 'exceljs';
import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';

const MAX_ROWS = 10_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node generate-report.mjs <findings.json> [output.xlsx]');
  process.exit(1);
}

let outputPath = process.argv[3] || inputPath.replace(/\.json$/, '.xlsx');
if (!/\.xlsx$/i.test(outputPath)) {
  outputPath += '.xlsx';
}

const resolvedInput = resolve(inputPath);

// Reject excessively large files before reading into memory
try {
  const fileStat = await stat(resolvedInput);
  if (fileStat.size > MAX_FILE_BYTES) {
    console.error(`Error: File is ${(fileStat.size / 1024 / 1024).toFixed(1)} MB, exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);
    process.exit(1);
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`Error: File not found: ${inputPath}`);
    process.exit(1);
  }
  // Other stat errors — fall through to readFile which will give a better message
}

let data;
try {
  data = JSON.parse(await readFile(resolvedInput, 'utf-8'));
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`Error: File not found: ${inputPath}`);
  } else if (err instanceof SyntaxError) {
    console.error(`Error: Invalid JSON in ${inputPath}: ${err.message}`);
  } else {
    console.error(`Error reading ${inputPath}: ${err.message}`);
  }
  process.exit(1);
}

// Validate JSON structure
if (typeof data !== 'object' || data === null || Array.isArray(data)) {
  console.error('Error: JSON root must be an object with url, summary, wcagIssues, and qualityIssues keys.');
  process.exit(1);
}
if (!Array.isArray(data.wcagIssues)) data.wcagIssues = [];
if (!Array.isArray(data.qualityIssues)) data.qualityIssues = [];
if (!Array.isArray(data.brokenLinks)) data.brokenLinks = [];
if (!Array.isArray(data.formIssues)) data.formIssues = [];
if (!Array.isArray(data.adDetection)) data.adDetection = [];
if (!Array.isArray(data.pages)) data.pages = [];
if (typeof data.crawlInfo !== 'object' || data.crawlInfo === null) data.crawlInfo = {};
if (typeof data.summary !== 'object' || data.summary === null) data.summary = {};

// Cap array sizes to prevent memory exhaustion
for (const key of ['wcagIssues', 'qualityIssues', 'brokenLinks', 'formIssues', 'adDetection', 'pages']) {
  if (data[key].length > MAX_ROWS) {
    console.warn(`Warning: ${key} truncated from ${data[key].length} to ${MAX_ROWS} rows.`);
    data[key] = data[key].slice(0, MAX_ROWS);
  }
}

/**
 * Ensure cell values are safe primitives for ExcelJS.
 * Prevents object values (e.g., { formula: '...' }) from being interpreted as
 * formulas, hyperlinks, or rich text by ExcelJS. String values are safe in XLSX
 * format since ExcelJS stores them with explicit type="s" in the XML.
 */
function sanitize(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  let str = String(value);
  // Strip Unicode invisible/control characters that could hide content in cells
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u00AD\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
  // Prevent CSV/formula injection: prefix strings that could be interpreted as
  // formulas if the XLSX is re-exported to CSV or opened in a less strict tool.
  if (/^[=+\-@\t\r\n]/.test(str)) return "'" + str;
  return str;
}

/**
 * Validate that a string is a safe HTTP(S) URL.
 */
function isValidHttpUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Build a CSS fix entry from an issue, or return null if no fix exists.
 */
function collectFix(issue, issueLabel) {
  if (!issue.cssFix && !issue.cssAfter) return null;
  return {
    page: sanitize(issue.pageUrl || data.url || ''),
    priority: issue.severity === 'critical' ? 1 : issue.severity === 'warning' ? 2 : 3,
    priorityLabel: (issue.severity || 'info').toUpperCase(),
    issue: sanitize(issueLabel),
    element: sanitize(issue.element || ''),
    sourceFile: sanitize(issue.sourceFile || ''),
    cssBefore: sanitize(issue.cssBefore || ''),
    cssAfter: sanitize(issue.cssAfter || ''),
    cssFix: sanitize(issue.cssFix || ''),
  };
}

const workbook = new ExcelJS.Workbook();
workbook.creator = 'SiteCheckBot';
workbook.created = new Date();

// Color palette
const colors = {
  headerBg: 'FF2B3A67',
  headerFont: 'FFFFFFFF',
  critical: 'FFDC3545',
  warning: 'FFFFC107',
  info: 'FF17A2B8',
  pass: 'FF28A745',
  stripeBg: 'FFF8F9FA',
  borderColor: 'FFD6D8DB',
};

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.headerBg } };
    cell.font = { bold: true, color: { argb: colors.headerFont }, size: 11 };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = {
      bottom: { style: 'thin', color: { argb: colors.borderColor } },
    };
  });
}

function findSeverityCol(sheet) {
  const headerRow = sheet.getRow(1);
  for (let i = 1; i <= headerRow.cellCount; i++) {
    const val = String(headerRow.getCell(i).value).toLowerCase();
    if (val === 'severity' || val === 'priority') return i;
  }
  return 0;
}

function styleDataRows(sheet, startRow, sevCol) {
  for (let i = startRow; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    if ((i - startRow) % 2 === 1) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.stripeBg } };
      });
    }
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = {
        bottom: { style: 'hair', color: { argb: colors.borderColor } },
      };
    });

    // Color-code severity column
    if (sevCol > 0) {
      const severityCell = row.getCell(sevCol);
      if (severityCell.value) {
        const sev = String(severityCell.value).toLowerCase();
        if (sev === 'critical') severityCell.font = { bold: true, color: { argb: colors.critical } };
        else if (sev === 'warning') severityCell.font = { color: { argb: 'FF856404' } };
        else if (sev === 'info') severityCell.font = { color: { argb: colors.info } };
      }
    }
  }
}

function styleBeforeAfterCells(row) {
  const beforeCell = row.getCell('cssBefore');
  const afterCell = row.getCell('cssAfter');
  if (beforeCell.value && beforeCell.value !== '(not set)') {
    beforeCell.font = { color: { argb: 'FFDC3545' } };
  }
  if (afterCell.value) {
    afterCell.font = { color: { argb: 'FF28A745' } };
  }
}

// ─── Sheet 1: Summary ───
const summarySheet = workbook.addWorksheet('Summary', {
  properties: { tabColor: { argb: colors.headerBg } },
});

summarySheet.columns = [
  { header: 'Field', key: 'field', width: 25 },
  { header: 'Value', key: 'value', width: 60 },
];
styleHeader(summarySheet.getRow(1));

const summary = data.summary;
const crawlInfo = data.crawlInfo;
/** Coerce to non-negative integer, defaulting to 0. */
function toCount(val) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
const adNetworks = Array.isArray(summary.adNetworksDetected) ? summary.adNetworksDetected : [];
const summaryRows = [
  { field: 'URL', value: sanitize(data.url || '') },
  { field: 'Date Checked', value: sanitize(data.timestamp || new Date().toISOString()) },
  { field: 'Pages Crawled', value: toCount(crawlInfo.pagesVisited) || 1 },
  { field: 'Total Issues', value: toCount(summary.totalIssues) },
  { field: 'WCAG Issues', value: toCount(summary.wcagIssues) },
  { field: 'Quality Issues', value: toCount(summary.qualityIssues) },
  { field: 'Broken Links', value: toCount(summary.brokenLinks) },
  { field: 'Form Issues', value: toCount(summary.formIssues) },
  { field: 'Ad Networks Detected', value: adNetworks.length > 0 ? sanitize(adNetworks.join(', ')) : 'None' },
  { field: 'Critical', value: toCount(summary.criticalCount) },
  { field: 'Warnings', value: toCount(summary.warningCount) },
  { field: 'Info', value: toCount(summary.infoCount) },
];
if (data.pages.length > 0) {
  summaryRows.push({ field: 'Pages Visited', value: sanitize(data.pages.map((p) => p.url || p).join('\n')) });
}
summaryRows.forEach((r) => summarySheet.addRow(r));

// Bold field names, color critical count
for (let i = 2; i <= summarySheet.rowCount; i++) {
  const row = summarySheet.getRow(i);
  row.getCell(1).font = { bold: true };
  row.getCell(1).alignment = { vertical: 'top' };
  row.getCell(2).alignment = { vertical: 'top', wrapText: true };
}
const criticalRow = summarySheet.getRow(summaryRows.findIndex((r) => r.field === 'Critical') + 2);
if (criticalRow.getCell(2).value > 0) {
  criticalRow.getCell(2).font = { bold: true, color: { argb: colors.critical } };
}

// ─── Sheet 2: WCAG Accessibility ───
const wcagSheet = workbook.addWorksheet('WCAG Accessibility', {
  properties: { tabColor: { argb: colors.critical } },
});

wcagSheet.columns = [
  { header: 'Page', key: 'page', width: 35 },
  { header: 'Criterion', key: 'criterion', width: 12 },
  { header: 'Name', key: 'name', width: 25 },
  { header: 'Level', key: 'level', width: 8 },
  { header: 'Severity', key: 'severity', width: 12 },
  { header: 'Element', key: 'element', width: 25 },
  { header: 'Description', key: 'description', width: 40 },
  { header: 'Current Value', key: 'currentValue', width: 15 },
  { header: 'Required Value', key: 'requiredValue', width: 15 },
  { header: 'Source File', key: 'sourceFile', width: 22 },
  { header: 'Existing Rule', key: 'existingRule', width: 45 },
  { header: 'Before', key: 'cssBefore', width: 35 },
  { header: 'After', key: 'cssAfter', width: 35 },
  { header: 'Full CSS Fix', key: 'cssFix', width: 50 },
  { header: 'Reference', key: 'reference', width: 45 },
];
styleHeader(wcagSheet.getRow(1));

const allFixes = [];

data.wcagIssues.forEach((issue) => {
  const row = wcagSheet.addRow({
    page: sanitize(issue.pageUrl || data.url || ''),
    criterion: sanitize(issue.criterion || ''),
    name: sanitize(issue.name || ''),
    level: sanitize(issue.level || ''),
    severity: sanitize(issue.severity || 'warning'),
    element: sanitize(issue.element || ''),
    description: sanitize(issue.description || ''),
    currentValue: sanitize(issue.currentValue || ''),
    requiredValue: sanitize(issue.requiredValue || ''),
    sourceFile: sanitize(issue.sourceFile || ''),
    existingRule: sanitize(issue.existingRule || ''),
    cssBefore: sanitize(issue.cssBefore || ''),
    cssAfter: sanitize(issue.cssAfter || ''),
    cssFix: sanitize(issue.cssFix || ''),
    reference: sanitize(issue.reference || ''),
  });

  // Make reference a hyperlink if it's a valid HTTP(S) URL
  if (issue.reference && isValidHttpUrl(issue.reference)) {
    const refCell = row.getCell('reference');
    refCell.value = { text: sanitize(issue.reference), hyperlink: issue.reference };
    refCell.font = { color: { argb: 'FF0563C1' }, underline: true };
  }

  styleBeforeAfterCells(row);

  // Collect CSS fix in same pass
  const fix = collectFix(issue, `[${issue.criterion || 'WCAG'}] ${issue.name || issue.description || ''}`);
  if (fix) allFixes.push(fix);
});
styleDataRows(wcagSheet, 2, findSeverityCol(wcagSheet));

// ─── Sheet 3: Page Quality ───
const qualitySheet = workbook.addWorksheet('Page Quality', {
  properties: { tabColor: { argb: colors.warning } },
});

qualitySheet.columns = [
  { header: 'Page', key: 'page', width: 35 },
  { header: 'Category', key: 'category', width: 20 },
  { header: 'Severity', key: 'severity', width: 12 },
  { header: 'Element', key: 'element', width: 25 },
  { header: 'Description', key: 'description', width: 45 },
  { header: 'Source File', key: 'sourceFile', width: 22 },
  { header: 'Existing Rule', key: 'existingRule', width: 40 },
  { header: 'Before', key: 'cssBefore', width: 35 },
  { header: 'After', key: 'cssAfter', width: 35 },
  { header: 'Full CSS Fix', key: 'cssFix', width: 50 },
  { header: 'Recommendation', key: 'recommendation', width: 45 },
];
styleHeader(qualitySheet.getRow(1));

data.qualityIssues.forEach((issue) => {
  const row = qualitySheet.addRow({
    page: sanitize(issue.pageUrl || data.url || ''),
    category: sanitize(issue.category || ''),
    severity: sanitize(issue.severity || 'warning'),
    element: sanitize(issue.element || ''),
    description: sanitize(issue.description || ''),
    sourceFile: sanitize(issue.sourceFile || ''),
    existingRule: sanitize(issue.existingRule || ''),
    cssBefore: sanitize(issue.cssBefore || ''),
    cssAfter: sanitize(issue.cssAfter || ''),
    cssFix: sanitize(issue.cssFix || ''),
    recommendation: sanitize(issue.recommendation || ''),
  });

  styleBeforeAfterCells(row);

  // Collect CSS fix in same pass
  const fix = collectFix(issue, `[${issue.category || 'Quality'}] ${issue.description || ''}`);
  if (fix) allFixes.push(fix);
});
styleDataRows(qualitySheet, 2, findSeverityCol(qualitySheet));

// ─── Sheet 4: CSS Fixes ───
const cssSheet = workbook.addWorksheet('CSS Fixes', {
  properties: { tabColor: { argb: colors.pass } },
});

cssSheet.columns = [
  { header: 'Page', key: 'page', width: 35 },
  { header: 'Priority', key: 'priority', width: 10 },
  { header: 'Issue', key: 'issue', width: 35 },
  { header: 'Element', key: 'element', width: 25 },
  { header: 'Source File', key: 'sourceFile', width: 22 },
  { header: 'Before', key: 'cssBefore', width: 40 },
  { header: 'After', key: 'cssAfter', width: 40 },
  { header: 'Full CSS Fix', key: 'cssFix', width: 55 },
];
styleHeader(cssSheet.getRow(1));

allFixes.sort((a, b) => a.priority - b.priority);
allFixes.forEach((fix) => {
  const row = cssSheet.addRow({
    page: fix.page,
    priority: fix.priorityLabel,
    issue: fix.issue,
    element: fix.element,
    sourceFile: fix.sourceFile,
    cssBefore: fix.cssBefore,
    cssAfter: fix.cssAfter,
    cssFix: fix.cssFix,
  });

  styleBeforeAfterCells(row);
});
styleDataRows(cssSheet, 2, findSeverityCol(cssSheet));

// ─── Sheet 5: Broken Links ───
const brokenLinksSheet = workbook.addWorksheet('Broken Links', {
  properties: { tabColor: { argb: colors.critical } },
});

brokenLinksSheet.columns = [
  { header: 'Broken URL', key: 'url', width: 50 },
  { header: 'Status', key: 'status', width: 12 },
  { header: 'Error', key: 'error', width: 30 },
  { header: 'Link Text', key: 'linkText', width: 25 },
  { header: 'Internal', key: 'internal', width: 10 },
  { header: 'Found On Pages', key: 'foundOnPages', width: 50 },
];
styleHeader(brokenLinksSheet.getRow(1));

data.brokenLinks.forEach((link) => {
  brokenLinksSheet.addRow({
    url: sanitize(link.url || ''),
    status: sanitize(link.status || ''),
    error: sanitize(link.error || ''),
    linkText: sanitize(link.linkText || ''),
    internal: link.internal ? 'Yes' : 'No',
    foundOnPages: sanitize(Array.isArray(link.foundOnPages) ? link.foundOnPages.join('\n') : ''),
  });
});
styleDataRows(brokenLinksSheet, 2, 0);

// ─── Sheet 6: Form Issues ───
const formIssuesSheet = workbook.addWorksheet('Form Issues', {
  properties: { tabColor: { argb: colors.warning } },
});

formIssuesSheet.columns = [
  { header: 'Page', key: 'page', width: 35 },
  { header: 'Form', key: 'form', width: 30 },
  { header: 'Issue Type', key: 'issueType', width: 20 },
  { header: 'Severity', key: 'severity', width: 12 },
  { header: 'Description', key: 'description', width: 45 },
  { header: 'Details', key: 'details', width: 40 },
];
styleHeader(formIssuesSheet.getRow(1));

data.formIssues.forEach((issue) => {
  formIssuesSheet.addRow({
    page: sanitize(issue.pageUrl || data.url || ''),
    form: sanitize(issue.form || ''),
    issueType: sanitize(issue.issueType || ''),
    severity: sanitize(issue.severity || 'warning'),
    description: sanitize(issue.description || ''),
    details: sanitize(issue.details || ''),
  });
});
styleDataRows(formIssuesSheet, 2, findSeverityCol(formIssuesSheet));

// ─── Sheet 7: Ad Detection ───
const adDetectionSheet = workbook.addWorksheet('Ad Detection', {
  properties: { tabColor: { argb: colors.info } },
});

adDetectionSheet.columns = [
  { header: 'Ad Network', key: 'network', width: 25 },
  { header: 'Detected', key: 'detected', width: 12 },
  { header: 'Found On Pages', key: 'foundOnPages', width: 60 },
];
styleHeader(adDetectionSheet.getRow(1));

data.adDetection.forEach((ad) => {
  adDetectionSheet.addRow({
    network: sanitize(ad.network || ''),
    detected: ad.detected ? 'Yes' : 'No',
    foundOnPages: sanitize(Array.isArray(ad.foundOnPages) ? ad.foundOnPages.join('\n') : ''),
  });
});
styleDataRows(adDetectionSheet, 2, 0);

// ─── Auto-filter on all sheets ───
[wcagSheet, qualitySheet, cssSheet, brokenLinksSheet, formIssuesSheet, adDetectionSheet].forEach((sheet) => {
  if (sheet.rowCount > 1) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: sheet.columnCount },
    };
  }
});

// ─── Freeze header rows ───
[summarySheet, wcagSheet, qualitySheet, cssSheet, brokenLinksSheet, formIssuesSheet, adDetectionSheet].forEach((sheet) => {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
});

// Write file
const resolvedOutput = resolve(outputPath);
try {
  await workbook.xlsx.writeFile(resolvedOutput);
  console.log(`Report saved to: ${resolvedOutput}`);
} catch (err) {
  console.error(`Error writing report to ${resolvedOutput}: ${err.message}`);
  process.exit(1);
}
