import { Ride } from '../../user/models/Ride.js';
import { Corporate } from '../models/Corporate.js';
import { CorporateTripRequest } from '../models/CorporateTripRequest.js';
import { chargeCorporateAccount } from './corporateLedger.js';
import { computeCorporateDiscount, normalizeCorporateServiceType } from './corporatePolicyEngine.js';

/// Bills a completed corporate ride to the company's credit account (SOW 8.4).
///
/// Called from `updateRideLifecycle` next to the driver wallet settlement,
/// after settleCorporateRideAtCompletion has worked out the final split: the
/// company is billed `split.companyAmount` - discount. The
/// discount is recomputed on the final fare (waiting charges can move it after
/// booking), using the rate snapshotted on the ride so a discount changed
/// mid-trip does not apply retroactively.
///
/// Never throws: a billing hiccup must not fail the driver's "complete" tap.
/// `corporate.chargedAt` is claimed atomically first, and the ledger entry is
/// idempotent per ride, so a retry cannot bill twice.
export const recordCorporateRideCompletion = async ({ rideId }) => {
  try {
    const ride = await Ride.findOne({
      _id: rideId,
      paymentMethod: 'corporate',
      'corporate.corporateId': { $ne: null },
      'corporate.chargedAt': null,
    }).lean();
    if (!ride) return null;

    const corporate = await Corporate.findById(ride.corporate.corporateId).select('discount').lean();
    const companyShare = Number.isFinite(Number(ride.corporate.split?.companyAmount)) && ride.corporate.split?.stage === 'final'
      ? Math.max(0, Number(ride.corporate.split.companyAmount))
      : ride.fare;
    const discount = computeCorporateDiscount({
      discount: {
        type: ride.corporate.discountType || corporate?.discount?.type,
        value: ride.corporate.discountValue ?? corporate?.discount?.value,
        maxPerTrip: corporate?.discount?.maxPerTrip,
        appliesTo: corporate?.discount?.appliesTo,
      },
      serviceType: normalizeCorporateServiceType(ride.serviceType),
      // v2: the discount applies to the company's share only; the employee's
      // excess (if any) is never billed to the company.
      fare: companyShare,
    });

    const claimed = await Ride.findOneAndUpdate(
      { _id: rideId, 'corporate.chargedAt': null },
      {
        $set: {
          'corporate.chargedAt': new Date(),
          'corporate.discountAmount': discount.amount,
          'corporate.billedAmount': discount.billableAmount,
        },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!claimed) return null;

    const result = await chargeCorporateAccount({
      corporateId: ride.corporate.corporateId,
      amount: discount.billableAmount,
      reference: { type: 'ride', id: String(ride._id) },
      description: `Trip ${String(ride._id).slice(-6).toUpperCase()}`,
      metadata: {
        employeeId: String(ride.corporate.employeeId || ''),
        departmentId: ride.corporate.departmentId ? String(ride.corporate.departmentId) : null,
        grossFare: ride.fare,
        companyAmount: companyShare,
        employeeAmount: ride.corporate.split?.employeeAmount || 0,
        discountAmount: discount.amount,
        serviceType: ride.serviceType,
      },
    });

    if (ride.corporate.tripRequestId) {
      await CorporateTripRequest.updateOne(
        { _id: ride.corporate.tripRequestId, status: { $in: ['approved', 'booked'] } },
        { $set: { status: 'booked' } },
      );
    }

    return result;
  } catch (error) {
    console.error('[corporate-billing] failed to bill ride', String(rideId), error.message);
    return null;
  }
};
