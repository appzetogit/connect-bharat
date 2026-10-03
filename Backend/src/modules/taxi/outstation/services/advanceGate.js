import { Ride } from '../../user/models/Ride.js';

/// Whether a ride is held back from dispatch until its outstation advance is
/// paid.
///
/// Called at the top of dispatchService.startDispatchFlow, which every path
/// that starts a search goes through: REST booking, the socket `requestRide`,
/// the restart after a fare increase, and the recovery sweep that re-dispatches
/// every `searching` ride after a restart. Gating there rather than at each
/// call site is what stops an unpaid ride slipping out through the recovery
/// sweep.
///
/// Kept in its own file with no imports beyond the Ride model, because
/// dispatchService imports it and the advance payment code imports
/// dispatchService - anything heavier here would make that a cycle.
///
/// The sweep loads rides with a narrow projection, so when `advance` is not on
/// the document the answer comes from one indexed lookup instead.
export const isRideAwaitingAdvance = async (ride) => {
  if (!ride?._id) return false;

  const advance = ride.advance;
  if (advance && typeof advance === 'object' && advance.status !== undefined) {
    return Boolean(advance.required) && String(advance.status) === 'pending';
  }

  const pending = await Ride.exists({
    _id: ride._id,
    'advance.required': true,
    'advance.status': 'pending',
  });
  return Boolean(pending);
};
