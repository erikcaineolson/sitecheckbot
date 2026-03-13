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
if (typeof data.summary !== 'object' || data.summary === null) data.summary = {};

// Cap array sizes to prevent memory exhaustion
if (data.wcagIssues.length > MAX_ROWS) {
  console.warn(`Warning: wcagIssues truncated from ${data.wcagIssues.length} to ${MAX_ROWS} rows.`);
  data.wcagIssues = data.wcagIssues.slice(0, MAX_ROWS);
}
if (data.qualityIssues.length > MAX_ROWS) {
  console.warn(`Warning: qualityIssues truncated from ${data.qualityIssues.length} to ${MAX_ROWS} rows.`);
  data.qualityIssues = data.qualityIssues.slice(0, MAX_ROWS);
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
  return value;
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
/** Coerce to non-negative integer, defaulting to 0. */
function toCount(val) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
const summaryRows = [
  { field: 'URL', value: sanitize(data.url || '') },
  { field: 'Date Checked', value: sanitize(data.timestamp || new Date().toISOString()) },
  { field: 'Total Issues', value: toCount(summary.totalIssues) },
  { field: 'WCAG Issues', value: toCount(summary.wcagIssues) },
  { field: 'Quality Issues', value: toCount(summary.qualityIssues) },
  { field: 'Critical', value: toCount(summary.criticalCount) },
  { field: 'Warnings', value: toCount(summary.warningCount) },
  { field: 'Info', value: toCount(summary.infoCount) },
];
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
    refCell.value = { text: issue.reference, hyperlink: issue.reference };
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

// ─── Auto-filter on all sheets ───
[wcagSheet, qualitySheet, cssSheet].forEach((sheet) => {
  if (sheet.rowCount > 1) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: sheet.columnCount },
    };
  }
});

// ─── Freeze header rows ───
[summarySheet, wcagSheet, qualitySheet, cssSheet].forEach((sheet) => {
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
