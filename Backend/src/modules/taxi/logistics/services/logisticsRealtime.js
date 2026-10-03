import { getSocketServer, getUserRoom } from '../../services/dispatchService.js';

/// Socket fan-out for the parcel network.
///
/// The booking user gets `logistics:shipment:updated` in their existing
/// `user:<id>` room (the one every rider socket already joins), and each hub
/// involved gets it in `hub:<hubId>`, which hub staff sockets join on connect
/// (see logistics/socket.js). Never throws: a socket hiccup must not fail
/// the scan that triggered it.
export const SHIPMENT_UPDATED_EVENT = 'logistics:shipment:updated';
export const MANIFEST_UPDATED_EVENT = 'logistics:manifest:updated';

export const getHubRoom = (hubId) => `hub:${hubId}`;

const emit = (room, event, payload) => {
  try {
    const io = getSocketServer();
    if (io && room) io.to(room).emit(event, payload);
  } catch (error) {
    console.warn('[logistics] socket emit failed', error?.message || error);
  }
};

export const emitShipmentUpdated = (shipment, extra = {}) => {
  if (!shipment) return;
  const payload = {
    shipmentId: String(shipment._id),
    awb: shipment.awb,
    status: shipment.status,
    displayStatus: extra.displayStatus,
    currentHubId: shipment.currentHubId ? String(shipment.currentHubId) : null,
    updatedAt: shipment.statusUpdatedAt || new Date(),
    ...extra,
  };
  if (shipment.bookingUserId) emit(getUserRoom(String(shipment.bookingUserId)), SHIPMENT_UPDATED_EVENT, payload);
  const hubs = new Set(
    [shipment.originHubId, shipment.destinationHubId, shipment.currentHubId, extra.hubId]
      .filter(Boolean)
      .map(String),
  );
  for (const hubId of hubs) emit(getHubRoom(hubId), SHIPMENT_UPDATED_EVENT, payload);
};

export const emitManifestUpdated = (manifest) => {
  if (!manifest) return;
  const payload = {
    manifestId: String(manifest._id),
    code: manifest.code,
    status: manifest.status,
    fromHubId: String(manifest.fromHubId),
    toHubId: String(manifest.toHubId),
    count: manifest.shipmentIds?.length || 0,
  };
  emit(getHubRoom(String(manifest.fromHubId)), MANIFEST_UPDATED_EVENT, payload);
  emit(getHubRoom(String(manifest.toHubId)), MANIFEST_UPDATED_EVENT, payload);
};
