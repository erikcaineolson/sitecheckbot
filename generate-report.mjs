import ExcelJS from 'exceljs';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node generate-report.mjs <findings.json> [output.xlsx]');
  process.exit(1);
}

const outputPath = process.argv[3] || inputPath.replace(/\.json$/, '.xlsx');
const data = JSON.parse(readFileSync(resolve(inputPath), 'utf-8'));

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

function styleDataRows(sheet, startRow) {
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
    const sevCol = findSeverityCol(sheet);
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

function findSeverityCol(sheet) {
  const headerRow = sheet.getRow(1);
  for (let i = 1; i <= headerRow.cellCount; i++) {
    const val = String(headerRow.getCell(i).value).toLowerCase();
    if (val === 'severity' || val === 'priority') return i;
  }
  return 0;
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

const summary = data.summary || {};
const summaryRows = [
  { field: 'URL', value: data.url || '' },
  { field: 'Date Checked', value: data.timestamp || new Date().toISOString() },
  { field: 'Total Issues', value: summary.totalIssues || 0 },
  { field: 'WCAG Issues', value: summary.wcagIssues || 0 },
  { field: 'Quality Issues', value: summary.qualityIssues || 0 },
  { field: 'Critical', value: summary.criticalCount || 0 },
  { field: 'Warnings', value: summary.warningCount || 0 },
  { field: 'Info', value: summary.infoCount || 0 },
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

(data.wcagIssues || []).forEach((issue) => {
  const row = wcagSheet.addRow({
    criterion: issue.criterion || '',
    name: issue.name || '',
    level: issue.level || '',
    severity: issue.severity || 'warning',
    element: issue.element || '',
    description: issue.description || '',
    currentValue: issue.currentValue || '',
    requiredValue: issue.requiredValue || '',
    sourceFile: issue.sourceFile || '',
    existingRule: issue.existingRule || '',
    cssBefore: issue.cssBefore || '',
    cssAfter: issue.cssAfter || '',
    cssFix: issue.cssFix || '',
    reference: issue.reference || '',
  });

  // Make reference a hyperlink if it's a URL
  if (issue.reference && issue.reference.startsWith('http')) {
    const refCell = row.getCell('reference');
    refCell.value = { text: issue.reference, hyperlink: issue.reference };
    refCell.font = { color: { argb: 'FF0563C1' }, underline: true };
  }

  // Style before/after cells
  const beforeCell = row.getCell('cssBefore');
  const afterCell = row.getCell('cssAfter');
  if (beforeCell.value && beforeCell.value !== '(not set)') {
    beforeCell.font = { color: { argb: 'FFDC3545' } }; // red for "before"
  }
  if (afterCell.value) {
    afterCell.font = { color: { argb: 'FF28A745' } }; // green for "after"
  }
});
styleDataRows(wcagSheet, 2);

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

(data.qualityIssues || []).forEach((issue) => {
  const row = qualitySheet.addRow({
    category: issue.category || '',
    severity: issue.severity || 'warning',
    element: issue.element || '',
    description: issue.description || '',
    sourceFile: issue.sourceFile || '',
    existingRule: issue.existingRule || '',
    cssBefore: issue.cssBefore || '',
    cssAfter: issue.cssAfter || '',
    cssFix: issue.cssFix || '',
    recommendation: issue.recommendation || '',
  });

  // Style before/after cells
  const beforeCell = row.getCell('cssBefore');
  const afterCell = row.getCell('cssAfter');
  if (beforeCell.value && beforeCell.value !== '(not set)') {
    beforeCell.font = { color: { argb: 'FFDC3545' } };
  }
  if (afterCell.value) {
    afterCell.font = { color: { argb: 'FF28A745' } };
  }
});
styleDataRows(qualitySheet, 2);

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

// Collect all CSS fixes, sorted by severity
const allFixes = [];
(data.wcagIssues || []).forEach((issue) => {
  if (issue.cssFix || issue.cssAfter) {
    allFixes.push({
      priority: issue.severity === 'critical' ? 1 : issue.severity === 'warning' ? 2 : 3,
      priorityLabel: (issue.severity || 'info').toUpperCase(),
      issue: `[${issue.criterion || 'WCAG'}] ${issue.name || issue.description || ''}`,
      element: issue.element || '',
      sourceFile: issue.sourceFile || '',
      cssBefore: issue.cssBefore || '',
      cssAfter: issue.cssAfter || '',
      cssFix: issue.cssFix || '',
    });
  }
});
(data.qualityIssues || []).forEach((issue) => {
  if (issue.cssFix || issue.cssAfter) {
    allFixes.push({
      priority: issue.severity === 'critical' ? 1 : issue.severity === 'warning' ? 2 : 3,
      priorityLabel: (issue.severity || 'info').toUpperCase(),
      issue: `[${issue.category || 'Quality'}] ${issue.description || ''}`,
      element: issue.element || '',
      sourceFile: issue.sourceFile || '',
      cssBefore: issue.cssBefore || '',
      cssAfter: issue.cssAfter || '',
      cssFix: issue.cssFix || '',
    });
  }
});

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

  // Style before/after cells
  const beforeCell = row.getCell('cssBefore');
  const afterCell = row.getCell('cssAfter');
  if (beforeCell.value && beforeCell.value !== '(not set)') {
    beforeCell.font = { color: { argb: 'FFDC3545' } };
  }
  if (afterCell.value) {
    afterCell.font = { color: { argb: 'FF28A745' } };
  }
});
styleDataRows(cssSheet, 2);

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
await workbook.xlsx.writeFile(resolvedOutput);
console.log(`Report saved to: ${resolvedOutput}`);
