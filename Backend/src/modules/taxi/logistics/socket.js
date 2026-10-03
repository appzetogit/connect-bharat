import { HubStaff } from './models/HubStaff.js';
import { getHubRoom } from './services/logisticsRealtime.js';
import { resolveStaffHubs } from './services/hubLookupService.js';

/// Socket room membership for the parcel network, called once per
/// connection from socket/index.js.
///
/// Hub staff (JWT role hub_manager) join `hub:<hubId>` for every hub they
/// can act for, which is where `logistics:shipment:updated` and
/// `logistics:manifest:updated` are emitted. Booking users need nothing
/// here: they already sit in `user:<id>`, which those events also reach.
/// Never throws, so a logistics problem cannot break the ride socket.
export const registerLogisticsSocket = async (socket, identity = {}) => {
  try {
    if (String(identity.role || '') !== 'hub_manager') return;
    const staff = await HubStaff.findById(identity.sub).lean();
    if (!staff || staff.active === false) {
      socket.disconnect(true);
      return;
    }
    const hubs = await resolveStaffHubs(staff);
    for (const hub of hubs) socket.join(getHubRoom(String(hub._id)));
    socket.emit('logistics:hub:joined', { hubIds: hubs.map((hub) => String(hub._id)) });
  } catch (error) {
    console.warn('[logistics] socket registration failed', error?.message || error);
  }
};
