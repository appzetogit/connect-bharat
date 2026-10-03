import { Ride } from '../../user/models/Ride.js';

/// True while a corporate ride is waiting for its approver, in which case
/// `startDispatchFlow` must not offer it to drivers yet.
///
/// Checked inside `startDispatchFlow` rather than at each call site because
/// rides reach dispatch from several places (REST create, socket requestRide,
/// the restore/recovery sweep, fare-raise restarts), and the sweep in
/// particular would otherwise dispatch a held ride within a minute.
///
/// The sweep loads rides with a narrow projection, so when neither the
/// payment method nor the corporate block is on the document it is looked up;
/// an ordinary ride with its payment method loaded costs nothing.
export const isRideAwaitingCorporateApproval = async (ride) => {
  if (!ride?._id) return false;
  const status = ride.corporate?.approvalStatus;
  if (status) return status === 'pending';
  if (ride.paymentMethod && ride.paymentMethod !== 'corporate') return false;

  try {
    const held = await Ride.exists({ _id: ride._id, 'corporate.approvalStatus': 'pending' });
    return Boolean(held);
  } catch {
    return false;
  }
};
