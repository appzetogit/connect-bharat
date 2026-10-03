import mongoose from 'mongoose';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { Corporate } from '../models/Corporate.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { computeCorporateDiscount, round2 } from './corporatePolicyEngine.js';
import { computeCorporateSplit, computeRemainingKm, getAllowancePeriodKey, resolveFinalEmployeePayment } from './corporateV2Rules.js';
import { consumeAllowanceKm, resolveRoleAllowance, upsertAllowanceUsage } from './corporateAllowanceService.js';
import { resolveEmployeeRole } from './corporateRoleService.js';
import { getCorporateSettings } from './corporateSettingsService.js';

/// Corporate rentals count against the employee's km allowance (contract
/// decision 4). Called once from RentalBookingRequest's post-save hook when a
/// booking becomes `completed`.
///
/// Km come from the inspection odometer (`rentalInspection.pickupMeterReading`
/// -> `returnMeterReading`). A rental with no usable readings is recorded as
/// 0 km used: it consumes no allowance and the company pays all of it.
///
/// Writes raw fields on the booking (read back by corporateInvoiceService's
/// loadRentalItems): corporateSettledAt, corporateRoleId, corporateGrossAmount,
/// corporateAllowance, corporateSplit, corporateDiscountAmount,
/// corporateBilledAmount. The rental's own payment flow is not changed: the
/// employee share is recorded for the invoice and the rental desk to collect.
/// Never throws.

export const rentalKmFromInspection = (inspection = {}) => {
  const start = Number(inspection?.pickupMeterReading);
  const end = Number(inspection?.returnMeterReading);
  const has = inspection?.pickupMeterReading !== null && inspection?.pickupMeterReading !== undefined && inspection?.pickupMeterReading !== ''
    && inspection?.returnMeterReading !== null && inspection?.returnMeterReading !== undefined && inspection?.returnMeterReading !== ''
    && Number.isFinite(start) && Number.isFinite(end) && end >= start;
  return has ? { km: round2(end - start), source: 'odometer' } : { km: 0, source: 'none' };
};

export const onCorporateRentalCompleted = async ({ bookingId }) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(bookingId))) return null;
    const claimed = await RentalBookingRequest.collection.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(String(bookingId)),
        status: 'completed',
        corporateId: { $ne: null },
        corporateEmployeeId: { $ne: null },
        billingMode: { $in: ['corporate', null] },
        corporateSettledAt: { $exists: false },
        corporateInvoiceId: { $in: [null] },
      },
      { $set: { corporateSettledAt: new Date() } },
      { returnDocument: 'before' },
    );
    const booking = claimed?.value !== undefined && claimed?.ok !== undefined ? claimed.value : claimed;
    if (!booking) return null;

    const [corporate, employee, settings] = await Promise.all([
      Corporate.findById(booking.corporateId).lean(),
      CorporateEmployee.findOne({ _id: booking.corporateEmployeeId, corporateId: booking.corporateId }).lean(),
      getCorporateSettings(),
    ]);
    if (!corporate || !employee) return null;

    const gross = round2(Number(booking.finalCharge) > 0 ? booking.finalCharge : booking.totalCost || 0);
    const { km, source } = rentalKmFromInspection(booking.rentalInspection);
    const role = await resolveEmployeeRole(employee);
    const allowance = resolveRoleAllowance(role, settings);
    const periodKey = allowance.enabled ? getAllowancePeriodKey(allowance.period, booking.completedAt || new Date()) : '';

    let coveredKm = km;
    if (allowance.enabled) {
      const usage = await upsertAllowanceUsage({
        corporateId: corporate._id,
        employeeId: employee._id,
        roleId: role?._id,
        period: allowance.period,
        periodKey,
        allowanceKm: allowance.allowanceKm,
      });
      coveredKm = await consumeAllowanceKm({ usageId: usage._id, km: Math.min(computeRemainingKm(usage), km) });
    }
    const split = computeCorporateSplit({ fare: gross, km, remainingKm: coveredKm, allowanceEnabled: allowance.enabled });
    const payment = resolveFinalEmployeePayment({
      employeeAmount: split.employeeAmount,
      // Not collected by a driver, so never "cash, paid"; online by default.
      chosenMethod: 'online',
      allowedMethods: ['online', 'wallet'],
    });
    const discount = computeCorporateDiscount({ discount: corporate.discount, serviceType: 'rental', fare: split.companyAmount });

    await RentalBookingRequest.collection.updateOne(
      { _id: booking._id },
      {
        $set: {
          corporateRoleId: role?._id || null,
          corporateGrossAmount: gross,
          corporateAllowance: {
            enabled: allowance.enabled,
            period: allowance.period,
            periodKey,
            allowanceKm: allowance.allowanceKm,
            actualKm: km,
            kmSource: source,
            coveredKm: split.coveredKm,
            excessKm: split.excessKm,
          },
          corporateSplit: {
            companyAmount: split.companyAmount,
            employeeAmount: split.employeeAmount,
            employeePaymentMethod: payment.employeePaymentMethod,
            employeePaymentStatus: payment.employeePaymentStatus,
            stage: 'final',
          },
          corporateDiscountAmount: discount.amount,
          corporateBilledAmount: discount.billableAmount,
        },
      },
    );
    return { ...split, km, source, billedAmount: discount.billableAmount };
  } catch (error) {
    console.error('[corporate-rental] completion hook failed', String(bookingId), error.message);
    return null;
  }
};
