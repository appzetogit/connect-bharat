import fs from 'node:fs';
import PDFDocument from 'pdfkit';

/// Consolidated corporate tax invoice, in the same visual language as the trip
/// invoice in services/invoiceService.js (fonts, ink/rule colours), which is
/// left untouched. Rendered on demand from the stored invoice figures so a
/// reprint always matches what was issued.

const PAGE_MARGIN = 42;
const INK = '#191713';
const MUTED = '#6B6660';
const RULE = '#DDD9D2';
const ACCENT = '#C8901F';

const FONT_CANDIDATES = [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
  ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
];

const resolveFonts = () => {
  for (const [regular, bold] of FONT_CANDIDATES) {
    try {
      if (fs.existsSync(regular) && fs.existsSync(bold)) return { regular, bold, unicode: true };
    } catch {
      // try the next candidate
    }
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', unicode: false };
};

const FONTS = resolveFonts();
const SYMBOL = FONTS.unicode ? '₹' : 'Rs. ';

const money = (value) =>
  `${SYMBOL}${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
    : '-';

/// `model` = { invoice, corporate, supplier: { name, legalName, gstin, address, footer } }
export const renderCorporateInvoicePdf = ({ invoice, corporate, supplier }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = PAGE_MARGIN;
    const right = doc.page.width - PAGE_MARGIN;
    const width = right - left;
    const bottom = doc.page.height - PAGE_MARGIN - 30;
    let y = PAGE_MARGIN;

    const ensureSpace = (needed) => {
      if (y + needed > bottom) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
    };

    const rule = (weight = 0.75, color = RULE) => {
      doc.moveTo(left, y).lineTo(right, y).lineWidth(weight).strokeColor(color).stroke();
    };

    // --- header -----------------------------------------------------------
    doc.font(FONTS.bold).fontSize(18).fillColor(INK).text('TAX INVOICE', left, y, { characterSpacing: 1 });
    doc.font(FONTS.regular).fontSize(9).fillColor(MUTED)
      .text(`Invoice No: ${invoice.invoiceNumber}`, left, y, { width, align: 'right' })
      .text(`Date: ${fmtDate(invoice.issuedAt || invoice.createdAt)}`, left, y + 12, { width, align: 'right' })
      .text(`Due: ${fmtDate(invoice.dueDate)}`, left, y + 24, { width, align: 'right' });
    y += 42;
    rule(2, INK);
    y += 12;

    // --- parties ----------------------------------------------------------
    const half = (width - 24) / 2;
    const block = (x, title, lines) => {
      doc.font(FONTS.bold).fontSize(7.5).fillColor(MUTED).text(title.toUpperCase(), x, y, { width: half, characterSpacing: 0.8 });
      let lineY = y + 12;
      lines.filter(Boolean).forEach((line, index) => {
        doc.font(index === 0 ? FONTS.bold : FONTS.regular).fontSize(index === 0 ? 10.5 : 9).fillColor(INK);
        doc.text(line, x, lineY, { width: half });
        lineY += doc.heightOfString(line, { width: half }) + 2;
      });
      return lineY;
    };

    const address = corporate.billingAddress || {};
    const billTo = invoice.billTo && Object.keys(invoice.billTo).length ? invoice.billTo : {
      name: corporate.legalName || corporate.name,
      gstin: corporate.gstin,
      address: [address.line1, address.line2, address.city, address.state, address.pincode].filter(Boolean).join(', '),
    };
    const supplierEnd = block(left, 'From', [
      supplier.legalName || supplier.name,
      supplier.address,
      supplier.gstin ? `GSTIN: ${supplier.gstin}` : '',
    ]);
    const billToEnd = block(left + half + 24, 'Bill To', [
      billTo.name,
      billTo.address,
      billTo.gstin ? `GSTIN: ${billTo.gstin}` : '',
      corporate.pan ? `PAN: ${corporate.pan}` : '',
    ]);
    y = Math.max(supplierEnd, billToEnd) + 10;

    doc.font(FONTS.regular).fontSize(9).fillColor(MUTED)
      .text(`Billing period: ${fmtDate(invoice.periodFrom)} to ${fmtDate(new Date(new Date(invoice.periodTo).getTime() - 1))}   |   Trips: ${invoice.tripCount}   |   SAC 9964 (passenger transport)`, left, y, { width });
    y += 20;

    // --- department summary -----------------------------------------------
    const cols = [
      { label: 'Department', x: left, w: width * 0.34, align: 'left' },
      { label: 'Cost centre', x: left + width * 0.34, w: width * 0.16, align: 'left' },
      { label: 'Trips', x: left + width * 0.5, w: width * 0.08, align: 'right' },
      { label: 'Gross', x: left + width * 0.58, w: width * 0.14, align: 'right' },
      { label: 'Discount', x: left + width * 0.72, w: width * 0.13, align: 'right' },
      { label: 'Net', x: left + width * 0.85, w: width * 0.15, align: 'right' },
    ];
    const tableHeader = () => {
      doc.font(FONTS.bold).fontSize(8).fillColor(MUTED);
      cols.forEach((col) => doc.text(col.label.toUpperCase(), col.x, y, { width: col.w, align: col.align }));
      y += 13;
      rule();
      y += 6;
    };
    tableHeader();
    for (const line of invoice.lines || []) {
      ensureSpace(18);
      doc.font(FONTS.regular).fontSize(9.5).fillColor(INK);
      const values = [line.departmentName, line.costCenter || '-', String(line.trips), money(line.grossAmount), money(line.discountAmount), money(line.netAmount)];
      cols.forEach((col, index) => doc.text(values[index], col.x, y, { width: col.w, align: col.align, lineBreak: false, ellipsis: true }));
      y += 17;
    }
    rule();
    y += 10;

    // --- totals -----------------------------------------------------------
    const totalRow = (label, value, bold = false) => {
      ensureSpace(18);
      doc.font(bold ? FONTS.bold : FONTS.regular).fontSize(bold ? 11 : 9.5).fillColor(INK)
        .text(label, left + width * 0.45, y, { width: width * 0.35, align: 'right' })
        .text(money(value), left + width * 0.8, y, { width: width * 0.2, align: 'right' });
      y += bold ? 20 : 16;
    };
    const tax = invoice.tax || {};
    totalRow('Gross trip value', invoice.subtotal);
    if (invoice.discount) totalRow('Corporate discount', -invoice.discount);
    totalRow(tax.inclusive ? 'Taxable value (fares are GST-inclusive)' : 'Taxable value', invoice.taxableAmount);
    if (tax.mode === 'inter') totalRow(`IGST @ ${tax.percent}%`, tax.igst);
    else {
      totalRow(`CGST @ ${tax.percent / 2}%`, tax.cgst);
      totalRow(`SGST @ ${tax.percent / 2}%`, tax.sgst);
    }
    if (invoice.roundOff) totalRow('Round off', invoice.roundOff);
    y += 2;
    ensureSpace(44);
    doc.rect(left, y, width, 34).fillColor(INK).fill();
    doc.font(FONTS.bold).fontSize(9).fillColor('#FFFFFF').text('INVOICE TOTAL', left + 14, y + 12, { characterSpacing: 1.2 });
    doc.font(FONTS.bold).fontSize(14).fillColor('#FFFFFF').text(money(invoice.total), left, y + 9, { width: width - 14, align: 'right' });
    y += 44;
    if (invoice.amountPaid) {
      totalRow('Paid', invoice.amountPaid);
      totalRow('Balance due', invoice.balanceDue, true);
    }
    if (Number(invoice.employeePaidTotal) > 0) {
      ensureSpace(16);
      doc.font(FONTS.regular).fontSize(8.5).fillColor(MUTED)
        .text(`Paid by employees for km over their allowance (not billed here): ${money(invoice.employeePaidTotal)}`, left, y, { width });
      y += 16;
    }

    // --- role summary (v2) -----------------------------------------------
    if ((invoice.byRole || []).length) {
      ensureSpace(60);
      y += 6;
      doc.font(FONTS.bold).fontSize(10).fillColor(INK).text('Summary by role', left, y);
      y += 16;
      const roleCols = [
        { label: 'Role', x: left, w: width * 0.28, align: 'left' },
        { label: 'Trips', x: left + width * 0.28, w: width * 0.09, align: 'right' },
        { label: 'Km', x: left + width * 0.37, w: width * 0.11, align: 'right' },
        { label: 'Covered km', x: left + width * 0.48, w: width * 0.13, align: 'right' },
        { label: 'Excess km', x: left + width * 0.61, w: width * 0.12, align: 'right' },
        { label: 'Employee paid', x: left + width * 0.73, w: width * 0.13, align: 'right' },
        { label: 'Billed', x: left + width * 0.86, w: width * 0.14, align: 'right' },
      ];
      doc.font(FONTS.bold).fontSize(7.5).fillColor(MUTED);
      roleCols.forEach((col) => doc.text(col.label.toUpperCase(), col.x, y, { width: col.w, align: col.align }));
      y += 12;
      rule();
      y += 5;
      for (const row of invoice.byRole) {
        ensureSpace(15);
        const values = [row.roleName || '-', String(row.trips || 0), String(row.km || 0), String(row.coveredKm || 0), String(row.excessKm || 0), money(row.employeeAmount), money(row.billedAmount)];
        doc.font(FONTS.regular).fontSize(8.5).fillColor(INK);
        roleCols.forEach((col, index) => doc.text(values[index], col.x, y, { width: col.w, align: col.align, lineBreak: false, ellipsis: true }));
        y += 14;
      }
    }

    // --- annex ------------------------------------------------------------
    if ((invoice.annex || []).length) {
      doc.addPage();
      y = PAGE_MARGIN;
      doc.font(FONTS.bold).fontSize(12).fillColor(INK).text(`Annexure: trip details (${invoice.invoiceNumber})`, left, y);
      y += 22;
      const annexCols = [
        { label: 'Date', x: left, w: width * 0.09, align: 'left' },
        { label: 'Employee', x: left + width * 0.09, w: width * 0.15, align: 'left' },
        { label: 'Role', x: left + width * 0.24, w: width * 0.08, align: 'left' },
        { label: 'Service', x: left + width * 0.32, w: width * 0.07, align: 'left' },
        { label: 'Route', x: left + width * 0.39, w: width * 0.25, align: 'left' },
        { label: 'Km (cov/exc)', x: left + width * 0.64, w: width * 0.11, align: 'right' },
        { label: 'Emp paid', x: left + width * 0.75, w: width * 0.11, align: 'right' },
        { label: 'Billed', x: left + width * 0.86, w: width * 0.14, align: 'right' },
      ];
      const annexHeader = () => {
        doc.font(FONTS.bold).fontSize(7.5).fillColor(MUTED);
        annexCols.forEach((col) => doc.text(col.label.toUpperCase(), col.x, y, { width: col.w, align: col.align }));
        y += 12;
        rule();
        y += 5;
      };
      annexHeader();
      for (const item of invoice.annex) {
        if (y + 14 > bottom) {
          doc.addPage();
          y = PAGE_MARGIN;
          annexHeader();
        }
        const route = `${item.pickup || '-'} → ${item.drop || '-'}`;
        const values = [
          fmtDate(item.date),
          `${item.employeeName || '-'}${item.employeeCode ? ` (${item.employeeCode})` : ''}`,
          item.roleName || '-',
          item.kind === 'rental' ? 'rental' : item.serviceType,
          FONTS.unicode ? route : route.replace('→', '->'),
          `${Number(item.actualKm || 0)} (${Number(item.coveredKm || 0)}/${Number(item.excessKm || 0)})`,
          Number(item.employeeAmount) > 0 ? money(item.employeeAmount) : '-',
          money(item.netAmount),
        ];
        doc.font(FONTS.regular).fontSize(7.5).fillColor(INK);
        annexCols.forEach((col, index) => doc.text(values[index], col.x, y, { width: col.w, align: col.align, lineBreak: false, ellipsis: true }));
        y += 13;
      }
    }

    // --- footer on every page ----------------------------------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would make pdfkit start a new page.
      doc.page.margins.bottom = 0;
      const footerY = doc.page.height - PAGE_MARGIN - 18;
      doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.font(FONTS.regular).fontSize(7.5).fillColor(MUTED)
        .text(supplier.footer || '', left, footerY + 6, { width: width * 0.7, lineBreak: false })
        .text(`Page ${i - range.start + 1} of ${range.count}`, left, footerY + 6, { width, align: 'right', lineBreak: false });
      doc.fillColor(ACCENT);
    }

    doc.end();
  });
