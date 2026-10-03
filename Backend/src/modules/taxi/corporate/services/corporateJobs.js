import { expirePendingTripRequests } from './corporateApprovalService.js';
import { markOverdueInvoices, runScheduledInvoiceGeneration, syncOpenPaymentLinks } from './corporateInvoiceService.js';
import { sweepStaleAllowanceReservations } from './corporateAllowanceService.js';

/// Background sweeps for the corporate module, on the same pattern as
/// driverSubscriptionExpiryService: a polling interval, every step safe to run
/// on all server instances at once (each claims its rows with a conditional
/// update or relies on a unique index).
///
///   - expire trip approvals nobody acted on (and cancel their rides)
///   - mark issued invoices past their due date as overdue
///   - on days 1-3 of the IST month, draft last month's invoices
///     (only with `corporate.auto_generate_invoices` = '1')
///   - pull the status of open Razorpay payment links
const SWEEP_INTERVAL_MS = 60 * 1000;
const SLOW_EVERY = 10; // invoices and payment links every ~10 minutes

let sweepTimer = null;
let tick = 0;
let running = false;

export const runCorporateSweep = async ({ includeSlow = false } = {}) => {
  const now = new Date();
  const result = {};
  result.approvals = await expirePendingTripRequests({ now }).catch((error) => ({ error: error.message }));
  // Km held for corporate rides cancelled by a path with no release hook.
  result.allowance = await sweepStaleAllowanceReservations().catch((error) => ({ error: error.message }));
  if (includeSlow) {
    result.overdue = await markOverdueInvoices(now).catch((error) => ({ error: error.message }));
    result.invoices = await runScheduledInvoiceGeneration(now).catch((error) => ({ error: error.message }));
    result.paymentLinks = await syncOpenPaymentLinks().catch((error) => ({ error: error.message }));
  }
  return result;
};

export const startCorporateJobsLoop = () => {
  if (sweepTimer) return;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runCorporateSweep({ includeSlow: tick % SLOW_EVERY === 0 });
    } catch (error) {
      console.error('Corporate sweep failed', error);
    } finally {
      tick += 1;
      running = false;
    }
  };

  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  run();
};
