#!/usr/bin/env node
import ExcelJS from 'exceljs';
import { readFile, stat } from 'fs/promises';
import { resolve, basename } from 'path';

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file

// ─── Parse CLI arguments ───
const args = process.argv.slice(2);
let outputPath = 'sitecheck-bulk-summary.xlsx';
const inputPatterns = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) {
    outputPath = args[++i];
  } else if (args[i].startsWith('--output=')) {
    outputPath = args[i].split('=').slice(1).join('=');
  } else {
    inputPatterns.push(args[i]);
  }
}

if (inputPatterns.length === 0) {
  console.error('Usage: node generate-bulk-summary.mjs <json-file> [json-file...] [--output file.xlsx]');
  console.error('Example: node generate-bulk-summary.mjs sitecheck-*-results.json');
  process.exit(1);
}

if (!/\.xlsx$/i.test(outputPath)) {
  outputPath += '.xlsx';
}

// ─── Resolve input files (support globs passed as literal args) ───
const inputFiles = [];
for (const pattern of inputPatterns) {
  const resolved = resolve(pattern);
  try {
    await stat(resolved);
    inputFiles.push(resolved);
  } catch {
    // Not a literal file — the shell should have expanded globs,
    // but if not, warn and skip
    console.warn(`Warning: File not found, skipping: ${pattern}`);
  }
}

if (inputFiles.length === 0) {
  console.error('Error: No valid input files found.');
  process.exit(1);
}

console.log(`Processing ${inputFiles.length} result file(s)...`);

// ─── Load all JSON results ───
const domainResults = [];

for (const filePath of inputFiles) {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      console.warn(`Warning: Skipping ${basename(filePath)} — exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);
      continue;
    }

    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      console.warn(`Warning: Skipping ${basename(filePath)} — JSON root is not an object.`);
      continue;
    }

    // Normalize optional fields
    if (!Array.isArray(data.wcagIssues)) data.wcagIssues = [];
    if (!Array.isArray(data.qualityIssues)) data.qualityIssues = [];
    if (!Array.isArray(data.brokenLinks)) data.brokenLinks = [];
    if (!Array.isArray(data.formIssues)) data.formIssues = [];
    if (!Array.isArray(data.adDetection)) data.adDetection = [];
    if (!Array.isArray(data.pages)) data.pages = [];
    if (typeof data.crawlInfo !== 'object' || data.crawlInfo === null) data.crawlInfo = {};
    if (typeof data.summary !== 'object' || data.summary === null) data.summary = {};

    domainResults.push({ filePath, data });
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.warn(`Warning: Skipping ${basename(filePath)} — invalid JSON: ${err.message}`);
    } else {
      console.warn(`Warning: Skipping ${basename(filePath)} — ${err.message}`);
    }
  }
}

if (domainResults.length === 0) {
  console.error('Error: No valid result files could be loaded.');
  process.exit(1);
}

// ─── Helpers ───
function toCount(val) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function sanitize(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  let str = String(value);
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u00AD\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
  if (/^[=+\-@\t\r\n]/.test(str)) return "'" + str;
  return str;
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || 'unknown';
  }
}

// ─── Aggregate data ───
let totalDomains = domainResults.length;
let succeededDomains = 0;
let failedDomains = 0;
let aggTotalIssues = 0;
let aggCritical = 0;
let aggWarnings = 0;
let aggInfo = 0;
let aggBrokenLinks = 0;
let aggWcagIssues = 0;
let aggQualityIssues = 0;
let aggFormIssues = 0;

const domainSummaryRows = [];
const issueAggregation = new Map(); // key: "type|name|severity" → { count, domains: Set }

for (const { filePath, data } of domainResults) {
  const domain = getDomain(data.url || data.crawlInfo?.seedUrl || '');
  const hasFailed = !!data.error;
  const reportFile = basename(filePath).replace(/-results\.json$/, '-report.xlsx');

  if (hasFailed) {
    failedDomains++;
  } else {
    succeededDomains++;
  }

  const s = data.summary;
  const totalIssues = toCount(s.totalIssues);
  const critical = toCount(s.criticalCount);
  const warnings = toCount(s.warningCount);
  const info = toCount(s.infoCount);
  const wcag = toCount(s.wcagIssues);
  const quality = toCount(s.qualityIssues);
  const broken = toCount(s.brokenLinks);
  const forms = toCount(s.formIssues);
  const pagesVisited = toCount(data.crawlInfo.pagesVisited);
  const adNetworks = Array.isArray(s.adNetworksDetected) ? s.adNetworksDetected : [];

  aggTotalIssues += totalIssues;
  aggCritical += critical;
  aggWarnings += warnings;
  aggInfo += info;
  aggBrokenLinks += broken;
  aggWcagIssues += wcag;
  aggQualityIssues += quality;
  aggFormIssues += forms;

  domainSummaryRows.push({
    domain,
    status: hasFailed ? 'Failed' : 'OK',
    pagesVisited,
    totalIssues,
    critical,
    warnings,
    info,
    wcag,
    quality,
    broken,
    forms,
    adNetworks: adNetworks.join(', ') || 'None',
    reportFile: hasFailed ? '' : reportFile,
    error: hasFailed ? sanitize(data.error) : '',
  });

  // Aggregate individual issues for Top Issues sheet
  for (const issue of data.wcagIssues) {
    const key = `WCAG|${issue.name || issue.criterion || 'Unknown'}|${issue.severity || 'warning'}`;
    if (!issueAggregation.has(key)) {
      issueAggregation.set(key, { type: 'WCAG', name: issue.name || issue.criterion || 'Unknown', severity: issue.severity || 'warning', count: 0, domains: new Set() });
    }
    const entry = issueAggregation.get(key);
    entry.count++;
    entry.domains.add(domain);
  }

  for (const issue of data.qualityIssues) {
    const key = `Quality|${issue.category || 'Unknown'}|${issue.severity || 'warning'}`;
    if (!issueAggregation.has(key)) {
      issueAggregation.set(key, { type: 'Quality', name: issue.category || 'Unknown', severity: issue.severity || 'warning', count: 0, domains: new Set() });
    }
    const entry = issueAggregation.get(key);
    entry.count++;
    entry.domains.add(domain);
  }
}

// Sort domain rows by critical count descending
domainSummaryRows.sort((a, b) => b.critical - a.critical);

// Sort top issues by domains affected descending, then by total count
const topIssues = Array.from(issueAggregation.values())
  .sort((a, b) => b.domains.size - a.domains.size || b.count - a.count);

// ─── Build workbook ───
const workbook = new ExcelJS.Workbook();
workbook.creator = 'SiteCheckBot';
workbook.created = new Date();

const colors = {
  headerBg: 'FF2B3A67',
  headerFont: 'FFFFFFFF',
  critical: 'FFDC3545',
  warning: 'FFFFC107',
  info: 'FF17A2B8',
  pass: 'FF28A745',
  stripeBg: 'FFF8F9FA',
  borderColor: 'FFD6D8DB',
  totalsBg: 'FFE9ECEF',
};

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.headerBg } };
    cell.font = { bold: true, color: { argb: colors.headerFont }, size: 11 };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: colors.borderColor } } };
  });
}

function findSeverityCol(sheet) {
  const headerRow = sheet.getRow(1);
  for (let i = 1; i <= headerRow.cellCount; i++) {
    const val = String(headerRow.getCell(i).value).toLowerCase();
    if (val === 'severity') return i;
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
      cell.border = { bottom: { style: 'hair', color: { argb: colors.borderColor } } };
    });

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

// ─── Sheet 1: Overview ───
const overviewSheet = workbook.addWorksheet('Overview', {
  properties: { tabColor: { argb: colors.headerBg } },
});

overviewSheet.columns = [
  { header: 'Field', key: 'field', width: 25 },
  { header: 'Value', key: 'value', width: 60 },
];
styleHeader(overviewSheet.getRow(1));

const overviewRows = [
  { field: 'Batch Date', value: new Date().toISOString() },
  { field: 'Total Domains', value: totalDomains },
  { field: 'Succeeded', value: succeededDomains },
  { field: 'Failed', value: failedDomains },
  { field: 'Total Issues', value: aggTotalIssues },
  { field: 'Critical', value: aggCritical },
  { field: 'Warnings', value: aggWarnings },
  { field: 'Info', value: aggInfo },
  { field: 'WCAG Issues', value: aggWcagIssues },
  { field: 'Quality Issues', value: aggQualityIssues },
  { field: 'Broken Links', value: aggBrokenLinks },
  { field: 'Form Issues', value: aggFormIssues },
];
overviewRows.forEach((r) => overviewSheet.addRow(r));

for (let i = 2; i <= overviewSheet.rowCount; i++) {
  const row = overviewSheet.getRow(i);
  row.getCell(1).font = { bold: true };
  row.getCell(1).alignment = { vertical: 'top' };
  row.getCell(2).alignment = { vertical: 'top', wrapText: true };
}
// Color-code critical count
const criticalOverviewRow = overviewSheet.getRow(overviewRows.findIndex((r) => r.field === 'Critical') + 2);
if (criticalOverviewRow.getCell(2).value > 0) {
  criticalOverviewRow.getCell(2).font = { bold: true, color: { argb: colors.critical } };
}
const failedOverviewRow = overviewSheet.getRow(overviewRows.findIndex((r) => r.field === 'Failed') + 2);
if (failedOverviewRow.getCell(2).value > 0) {
  failedOverviewRow.getCell(2).font = { bold: true, color: { argb: colors.critical } };
}

// ─── Sheet 2: Domain Summary ───
const domainSheet = workbook.addWorksheet('Domain Summary', {
  properties: { tabColor: { argb: colors.warning } },
});

domainSheet.columns = [
  { header: 'Domain', key: 'domain', width: 30 },
  { header: 'Status', key: 'status', width: 10 },
  { header: 'Pages Crawled', key: 'pagesVisited', width: 14 },
  { header: 'Total Issues', key: 'totalIssues', width: 13 },
  { header: 'Critical', key: 'critical', width: 10 },
  { header: 'Warnings', key: 'warnings', width: 10 },
  { header: 'Info', key: 'info', width: 8 },
  { header: 'WCAG Issues', key: 'wcag', width: 13 },
  { header: 'Quality Issues', key: 'quality', width: 14 },
  { header: 'Broken Links', key: 'broken', width: 13 },
  { header: 'Form Issues', key: 'forms', width: 12 },
  { header: 'Ad Networks', key: 'adNetworks', width: 20 },
  { header: 'Report File', key: 'reportFile', width: 35 },
  { header: 'Error', key: 'error', width: 30 },
];
styleHeader(domainSheet.getRow(1));

domainSummaryRows.forEach((r) => {
  const row = domainSheet.addRow({
    domain: sanitize(r.domain),
    status: r.status,
    pagesVisited: r.pagesVisited,
    totalIssues: r.totalIssues,
    critical: r.critical,
    warnings: r.warnings,
    info: r.info,
    wcag: r.wcag,
    quality: r.quality,
    broken: r.broken,
    forms: r.forms,
    adNetworks: sanitize(r.adNetworks),
    reportFile: sanitize(r.reportFile),
    error: r.error,
  });

  // Color-code status
  const statusCell = row.getCell('status');
  if (r.status === 'Failed') {
    statusCell.font = { bold: true, color: { argb: colors.critical } };
  } else {
    statusCell.font = { color: { argb: colors.pass } };
  }

  // Color-code critical count
  const critCell = row.getCell('critical');
  if (r.critical > 0) {
    critCell.font = { bold: true, color: { argb: colors.critical } };
  }
});

// Add totals row
const totalsRow = domainSheet.addRow({
  domain: 'TOTALS',
  status: '',
  pagesVisited: domainSummaryRows.reduce((s, r) => s + r.pagesVisited, 0),
  totalIssues: aggTotalIssues,
  critical: aggCritical,
  warnings: aggWarnings,
  info: aggInfo,
  wcag: aggWcagIssues,
  quality: aggQualityIssues,
  broken: aggBrokenLinks,
  forms: aggFormIssues,
  adNetworks: '',
  reportFile: '',
  error: '',
});
totalsRow.eachCell((cell) => {
  cell.font = { bold: true };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.totalsBg } };
  cell.border = { top: { style: 'thin', color: { argb: colors.borderColor } }, bottom: { style: 'thin', color: { argb: colors.borderColor } } };
});

// Style data rows (excluding totals row)
for (let i = 2; i < domainSheet.rowCount; i++) {
  const row = domainSheet.getRow(i);
  if ((i - 2) % 2 === 1) {
    row.eachCell((cell) => {
      if (!cell.font?.bold || !cell.font?.color) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.stripeBg } };
      }
    });
  }
  row.eachCell((cell) => {
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.border = { bottom: { style: 'hair', color: { argb: colors.borderColor } } };
  });
}

// ─── Sheet 3: Top Issues ───
const topIssuesSheet = workbook.addWorksheet('Top Issues', {
  properties: { tabColor: { argb: colors.critical } },
});

topIssuesSheet.columns = [
  { header: 'Issue Type', key: 'type', width: 12 },
  { header: 'Issue Name', key: 'name', width: 30 },
  { header: 'Severity', key: 'severity', width: 12 },
  { header: 'Domains Affected', key: 'domainsAffected', width: 16 },
  { header: 'Total Occurrences', key: 'totalOccurrences', width: 18 },
  { header: 'Affected Domains', key: 'affectedDomains', width: 50 },
];
styleHeader(topIssuesSheet.getRow(1));

topIssues.forEach((issue) => {
  topIssuesSheet.addRow({
    type: sanitize(issue.type),
    name: sanitize(issue.name),
    severity: sanitize(issue.severity),
    domainsAffected: issue.domains.size,
    totalOccurrences: issue.count,
    affectedDomains: sanitize(Array.from(issue.domains).join(', ')),
  });
});
styleDataRows(topIssuesSheet, 2, findSeverityCol(topIssuesSheet));

// ─── Auto-filter on data sheets ───
[domainSheet, topIssuesSheet].forEach((sheet) => {
  if (sheet.rowCount > 1) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: sheet.columnCount },
    };
  }
});

// ─── Freeze header rows ───
[overviewSheet, domainSheet, topIssuesSheet].forEach((sheet) => {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
});

// ─── Write file ───
const resolvedOutput = resolve(outputPath);
try {
  await workbook.xlsx.writeFile(resolvedOutput);
  console.log(`Bulk summary report saved to: ${resolvedOutput}`);
} catch (err) {
  console.error(`Error writing report to ${resolvedOutput}: ${err.message}`);
  process.exit(1);
}
