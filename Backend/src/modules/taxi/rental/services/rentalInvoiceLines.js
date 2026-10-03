import { computeRentalBillingMetrics, depositBalance, roundMoney } from './rentalBilling.js';

/// Pure line-item builder for the rental invoice, split from
/// rentalInvoiceService.js so it can be tested without PDF, mail or Mongo.

const formatDateTime = (date) =>
  date
    ? new Date(date).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      })
    : '-';

/// Itemized lines of a rental bill. Pure, so tests and the JSON endpoint use
/// the same numbers the PDF prints.
///
/// `charges` add up to `subtotal`; tax is the service-tax percentage the
/// booking snapshotted; `credits` (advance and paid extensions) reduce the
/// balance. The deposit is shown separately: it is not revenue.
export const buildRentalInvoiceLines = (booking = {}, metrics = computeRentalBillingMetrics(booking, booking.billingEndedAt || booking.completedAt || booking.completionRequestedAt || null)) => {
  const charges = [];
  const add = (code, label, amount, detail = '') => {
    if (roundMoney(amount) !== 0) charges.push({ code, label, detail, amount: roundMoney(amount) });
  };

  const pkg = booking.selectedPackage || {};
  add(
    'base_package',
    pkg.label ? `Package: ${pkg.label}` : 'Rental package',
    metrics.basePrice,
    metrics.pricingUnit === 'day' ? `${metrics.billedDays} day(s)` : `${metrics.includedHours} hour(s) included`,
  );
  add(
    'extra_time',
    metrics.pricingUnit === 'day' ? 'Extra days / hours' : 'Extra hours',
    metrics.extraTimeCharge,
    metrics.extraHours ? `${metrics.extraHours} h beyond booked time` : '',
  );
  add('extra_km', 'Extra km', metrics.extraKmCharge, metrics.extraKm ? `${metrics.extraKm} km x ${metrics.extraKmRate}` : '');
  add('driver_surcharge', 'With-driver surcharge', metrics.driverSurcharge);

  for (const extension of (booking.extensions || []).filter((entry) => ['approved', 'paid'].includes(entry.status))) {
    add('extension', 'Extension', extension.amount, `${formatDateTime(extension.from)} to ${formatDateTime(extension.to)}`);
  }
  for (const charge of booking.additionalCharges || []) {
    add(charge.type === 'damage' ? 'damage' : 'additional', charge.reason || 'Additional charge', charge.amount);
  }

  const chargedTotal = roundMoney(charges.reduce((sum, line) => sum + line.amount, 0));
  // The live charge never falls below the advance already paid; show that
  // floor as its own line rather than let the total silently disagree.
  if (metrics.currentCharge > chargedTotal + 0.009) {
    add('minimum_charge', 'Minimum charge adjustment', metrics.currentCharge - chargedTotal);
  }
  // Damage or fees kept from the deposit are charges too; they are paid by
  // the deposit, which appears again below as a credit.
  for (const deduction of booking.deposit?.required ? booking.deposit.deductions || [] : []) {
    add('deposit_deduction', `${deduction.reason || 'Deduction'} (from deposit)`, deduction.amount);
  }
  const subtotal = roundMoney(charges.reduce((sum, line) => sum + line.amount, 0));

  const taxPercentage = Math.max(0, Number(booking.commissionSnapshot?.serviceTaxPercentage || 0));
  const tax = roundMoney((subtotal * taxPercentage) / 100);
  const total = roundMoney(subtotal + tax);

  const credits = [];
  const advancePaid = booking.paymentStatus === 'paid' ? roundMoney(booking.payableNow) : 0;
  if (advancePaid > 0) credits.push({ code: 'advance', label: 'Advance paid', amount: advancePaid });
  if (metrics.extensionsPaid > 0) credits.push({ code: 'extensions_paid', label: 'Extensions paid', amount: roundMoney(metrics.extensionsPaid) });
  const creditTotal = roundMoney(credits.reduce((sum, line) => sum + line.amount, 0));

  const deposit = booking.deposit || {};
  const depositDeductions = roundMoney((deposit.deductions || []).reduce((sum, entry) => sum + Number(entry.amount || 0), 0));
  const depositSummary = deposit.required
    ? {
        amount: roundMoney(deposit.amount),
        status: deposit.status,
        held: ['held'].includes(deposit.status) ? depositBalance(deposit) : 0,
        deductedForCharges: depositDeductions,
        released: roundMoney(deposit.releasedAmount),
      }
    : null;

  // Damage taken from the deposit is already paid.
  const balance = roundMoney(Math.max(0, total - creditTotal - depositDeductions));

  return {
    charges,
    subtotal,
    tax: { percentage: taxPercentage, amount: tax },
    total,
    credits,
    creditTotal,
    deposit: depositSummary,
    balance,
    metrics,
  };
};

