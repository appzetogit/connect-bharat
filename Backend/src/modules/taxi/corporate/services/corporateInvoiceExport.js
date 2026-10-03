import ExcelJS from 'exceljs';
import { toCsv } from './corporatePolicyEngine.js';

/// Per-trip annex of an invoice as CSV / XLSX (contract §3.4: every column).

const ist = (value) => (value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '');

export const ANNEX_COLUMNS = Object.freeze([
  { label: 'Kind', key: 'kind' },
  { label: 'Trip ID', value: (row) => (row.refId ? String(row.refId) : '') },
  { label: 'Date', value: (row) => ist(row.date) },
  { label: 'Service', key: 'serviceType' },
  { label: 'Employee', key: 'employeeName' },
  { label: 'Employee Code', key: 'employeeCode' },
  { label: 'Role', key: 'roleName' },
  { label: 'Department', key: 'departmentName' },
  { label: 'Pickup', value: (row) => row.pickupAddress || row.pickup || '' },
  { label: 'Drop', value: (row) => row.dropAddress || row.drop || '' },
  { label: 'Vehicle', key: 'vehicleName' },
  { label: 'Started', value: (row) => ist(row.startedAt) },
  { label: 'Completed', value: (row) => ist(row.completedAt) },
  { label: 'Actual km', key: 'actualKm', numeric: true },
  { label: 'Covered km', key: 'coveredKm', numeric: true },
  { label: 'Excess km', key: 'excessKm', numeric: true },
  { label: 'Gross fare', key: 'grossFare', numeric: true },
  { label: 'Employee paid', key: 'employeeAmount', numeric: true },
  { label: 'Company share', key: 'companyAmount', numeric: true },
  { label: 'Discount', key: 'discountAmount', numeric: true },
  { label: 'Billed', value: (row) => row.billedAmount ?? row.netAmount, numeric: true },
  { label: 'Pricing', key: 'pricing' },
]);

const cell = (column, row) => (typeof column.value === 'function' ? column.value(row) : row[column.key]);

export const invoiceAnnexToCsv = (invoice) => toCsv(ANNEX_COLUMNS, invoice.annex || []);

export const invoiceAnnexToXlsx = async (invoice) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Trips');
  sheet.columns = ANNEX_COLUMNS.map((column) => ({ header: column.label, key: column.label, width: column.numeric ? 13 : 22 }));
  sheet.getRow(1).font = { bold: true };
  for (const row of invoice.annex || []) {
    sheet.addRow(Object.fromEntries(ANNEX_COLUMNS.map((column) => {
      const value = cell(column, row);
      return [column.label, column.numeric ? Number(value || 0) : (value ?? '')];
    })));
  }

  const summary = (name, rows, idLabel) => {
    const ws = workbook.addWorksheet(name);
    ws.columns = [
      { header: idLabel, key: 'name', width: 26 },
      { header: 'Code', key: 'code', width: 14 },
      { header: 'Trips', key: 'trips', width: 8 },
      { header: 'Km', key: 'km', width: 10 },
      { header: 'Covered km', key: 'coveredKm', width: 12 },
      { header: 'Excess km', key: 'excessKm', width: 12 },
      { header: 'Employee paid', key: 'employeeAmount', width: 14 },
      { header: 'Billed', key: 'billedAmount', width: 12 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const item of rows || []) {
      ws.addRow({ ...item, name: item.roleName ?? item.employeeName ?? '', code: item.roleCode ?? item.employeeCode ?? '' });
    }
  };
  summary('By role', invoice.byRole, 'Role');
  summary('By employee', invoice.byEmployee, 'Employee');

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const exportFilename = (invoice, ext) => `${String(invoice.invoiceNumber || 'invoice').replace(/[^\w-]+/g, '_')}-trips.${ext}`;
