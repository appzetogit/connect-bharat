/// The single entry point rideService calls into the parcel network.
///
/// Deliberately import-free at load time: rideService imports this file,
/// and the leg service imports rideService, so a static import here would
/// be a cycle. The cheap check on the ride runs first, so a normal taxi or
/// direct-parcel completion never even loads the logistics module.
///
/// Never throws: a problem advancing a shipment must not fail the driver's
/// "complete ride" tap.
export const onParcelRideCompleted = async (ride) => {
  try {
    if (!ride || String(ride.serviceType || '') !== 'parcel') return null;
    if (!ride.parcel?.shipmentLegId && !ride.parcel?.shipmentAwb) return null;
    const { handleLegRideCompleted } = await import('./legDispatchService.js');
    return await handleLegRideCompleted(ride);
  } catch (error) {
    console.error('[logistics] failed to advance shipment after ride completion', String(ride?._id || ''), error);
    return null;
  }
};
