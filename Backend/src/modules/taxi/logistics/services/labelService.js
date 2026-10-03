import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { Hub } from '../models/Hub.js';
import { buildQrPayload } from './awb.js';
import { getLogisticsSettings } from './logisticsSettingsService.js';

/// The printable shipping label: 4×6 inch (the size thermal label printers
/// take), with a Code128 barcode of the bare AWB for keyboard-wedge
/// scanners and a QR code for phone cameras. Rendered on demand, never
/// stored, so a reprint always reflects the current routing.

const LABEL_SIZE = [288, 432]; // 4in × 6in at 72pt/in

export const renderCode128Png = (text) =>
  bwipjs.toBuffer({ bcid: 'code128', text: String(text), scale: 3, height: 12, includetext: true, textxalign: 'center' });

export const renderQrPng = (payload) => QRCode.toBuffer(String(payload), { errorCorrectionLevel: 'M', margin: 1, width: 220 });

const collectPdf = (doc) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

export const renderShipmentLabelPdf = async (shipment) => {
  const settings = await getLogisticsSettings();
  const [origin, destination] = await Promise.all([
    Hub.findById(shipment.originHubId).select('code name').lean(),
    Hub.findById(shipment.destinationHubId).select('code name').lean(),
  ]);
  const qrPayload = shipment.qrPayload || buildQrPayload(shipment.awb, settings.tracking_base_url);
  const [barcode, qr] = await Promise.all([renderCode128Png(shipment.awb), renderQrPng(qrPayload)]);

  const doc = new PDFDocument({ size: LABEL_SIZE, margin: 12 });
  const done = collectPdf(doc);
  const width = LABEL_SIZE[0] - 24;

  doc.font('Helvetica-Bold').fontSize(20).text(`${origin?.code || '---'}  >  ${destination?.code || '---'}`, 12, 14, { width, align: 'center' });
  // "Rs" rather than the rupee sign: pdfkit's built-in Helvetica has no
  // glyph for it.
  const flags = [
    shipment.express ? 'EXPRESS' : '',
    shipment.fragile ? 'FRAGILE' : '',
    shipment.payment?.method === 'cod' ? `COD Rs ${shipment.pricing?.total ?? ''}` : 'PREPAID',
  ]
    .filter(Boolean)
    .join('   ');
  doc.font('Helvetica-Bold').fontSize(11).text(flags, 12, 40, { width, align: 'center' });

  doc.image(barcode, 24, 60, { fit: [width - 24, 70], align: 'center' });

  doc.moveTo(12, 140).lineTo(LABEL_SIZE[0] - 12, 140).stroke();
  doc.font('Helvetica-Bold').fontSize(9).text('DELIVER TO', 12, 146);
  doc.font('Helvetica-Bold').fontSize(12).text(shipment.receiver?.name || '', 12, 158, { width });
  doc.font('Helvetica').fontSize(9).text(`${shipment.receiver?.address || ''}${shipment.receiver?.pincode ? ` - ${shipment.receiver.pincode}` : ''}`, { width });
  doc.text(`Ph: ${shipment.receiver?.phone || ''}`, { width });

  const senderTop = Math.max(doc.y + 8, 230);
  doc.moveTo(12, senderTop - 4).lineTo(LABEL_SIZE[0] - 12, senderTop - 4).stroke();
  doc.font('Helvetica-Bold').fontSize(8).text('FROM', 12, senderTop);
  doc.font('Helvetica').fontSize(8).text(`${shipment.sender?.name || ''}, ${shipment.sender?.address || ''}`, 12, senderTop + 10, { width: width - 110 });
  doc.text(`Ph: ${shipment.sender?.phone || ''}`, { width: width - 110 });

  doc.image(qr, LABEL_SIZE[0] - 12 - 100, senderTop + 4, { fit: [100, 100] });

  const metaTop = Math.max(doc.y + 10, senderTop + 112);
  doc.font('Helvetica').fontSize(8).text(
    [
      `Weight: ${shipment.chargeableWeight || shipment.weightKg} kg (${shipment.sizeCategory || ''})`,
      `Scope: ${String(shipment.scope || '').replace('_', ' ')}`,
      `Booked: ${new Date(shipment.createdAt || Date.now()).toISOString().slice(0, 10)}`,
      origin ? `Origin hub: ${origin.name}` : '',
      destination ? `Destination hub: ${destination.name}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    12,
    metaTop,
    { width },
  );
  doc.font('Helvetica-Bold').fontSize(10).text(shipment.awb, 12, LABEL_SIZE[1] - 26, { width, align: 'center' });
  doc.end();
  return done;
};
