/**
 * Renders a sample invoice so the layout can be eyeballed without a database.
 *   node scripts/testInvoicePdf.js [output.pdf]
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { renderInvoicePdf } from '../src/modules/taxi/services/invoiceService.js';

const model = {
  invoiceDate: '24 August 2026',
  company: {
    name: 'Connect Bharat',
    tagline: 'Reliable rides, simple journeys',
    address: 'Shop No. 13, 2nd Floor, Grand Majestic Mall, Gandhi Nagar, Bengaluru – 560009',
    phone: '8971421486',
    email: 'support@bharat.buytogetherindia.com',
    city: 'Bengaluru',
  },
  trip: {
    customerName: 'Siddappa Rayappa Nigadi',
    customerEmail: 'rider@example.com',
    driverName: 'Abdul Aziz',
    vehicleNumber: 'KA 65 1635',
    pickup: 'Sheshadripuram, Bengaluru',
    drop: 'Micro Center of Excellence, Micro Labs Ltd, Kudlu, Bengaluru – 560068',
    paymentMethod: 'cash',
  },
  fare: { symbol: '₹', tripFare: 3000, total: 3000 },
};

const out = process.argv[2] || 'sample-invoice.pdf';
const buffer = await renderInvoicePdf(model);

assert.ok(buffer.length > 1000, 'pdf looks empty');
assert.equal(buffer.subarray(0, 5).toString(), '%PDF-', 'not a PDF');

await fs.writeFile(out, buffer);
console.log(`  wrote ${out} (${(buffer.length / 1024).toFixed(1)} KB)`);
