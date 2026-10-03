import { getFirebaseMessaging } from '../../../../config/firebase.js';
import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { Owner } from '../../admin/models/Owner.js';
import { getSosSmsSettings } from '../../admin/services/thirdPartySettingsService.js';
import { SafetyAlert } from '../../common/models/SafetyAlert.js';
import { Driver } from '../../driver/models/Driver.js';
import { User } from '../../user/models/User.js';
import { listEntityPushTokens } from '../../services/pushTokenService.js';
import { sendTransactionalSms } from '../../services/smsService.js';
import { buildSosSmsText, locationLinkFor } from './sosMessage.js';

/**
 * What happens after an SOS alert is saved, beyond telling the admins:
 *
 *   1. SMS every emergency contact of whoever pressed SOS (rider or driver),
 *      with their name, a map link to where they were and the trip/vehicle.
 *   2. Push the fleet owner of the ride's driver, if the driver belongs to
 *      one - the owner's operations team is the nearest party who can act on
 *      a vehicle in trouble.
 *
 * Runs after the HTTP response has been sent and never throws. An SOS must
 * reach the admins even when the SMS gateway is down, so nothing here may be
 * able to fail or slow down the request that created the alert.
 */

const isEnabled = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

const readAppName = async () => {
  try {
    const doc = await AdminBusinessSetting.findOne({ scope: 'default' }).select('general.app_name').lean();
    return String(doc?.general?.app_name || 'App').trim() || 'App';
  } catch {
    return 'App';
  }
};

const appendAlertLog = (alertId, message) =>
  SafetyAlert.updateOne(
    { _id: alertId },
    { $push: { logs: { actorRole: 'system', message: String(message).slice(0, 500) } } },
  ).catch(() => null);

const smsEmergencyContacts = async ({ alert, sourceApp }) => {
  const settings = await getSosSmsSettings();
  if (!isEnabled(settings.enabled)) {
    return { sent: 0, failed: 0, skipped: 'disabled' };
  }

  const actorId = sourceApp === 'driver' ? alert.driverId : alert.userId;
  if (!actorId) return { sent: 0, failed: 0, skipped: 'no-actor' };

  const Model = sourceApp === 'driver' ? Driver : User;
  const actor = await Model.findById(actorId).select('name phone emergencyContacts').lean();
  const contacts = Array.isArray(actor?.emergencyContacts) ? actor.emergencyContacts : [];
  if (!contacts.length) return { sent: 0, failed: 0, skipped: 'no-contacts' };

  // The alert's vehicle label is whatever the app sent, often nothing; the
  // driver record has the plate a contact would actually need.
  let vehicle = String(alert.vehicleLabel || '').trim();
  if (alert.driverId) {
    const driver = await Driver.findById(alert.driverId)
      .select('vehicleNumber vehicleColor vehicleMake vehicleModel')
      .lean()
      .catch(() => null);
    const described = [driver?.vehicleColor, driver?.vehicleMake, driver?.vehicleModel, driver?.vehicleNumber]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(' ');
    if (described) vehicle = described;
    if (sourceApp === 'user' && alert.driverName) vehicle = `${vehicle} (driver ${alert.driverName})`.trim();
  }

  const text = buildSosSmsText({
    template: settings.template_text,
    appName: await readAppName(),
    name: actor?.name || (sourceApp === 'driver' ? alert.driverName : alert.riderName),
    phone: actor?.phone || '',
    link: locationLinkFor(alert),
    trip: alert.tripCode || '',
    vehicle,
  });

  const results = await Promise.allSettled(
    contacts.map((contact) =>
      sendTransactionalSms({ phone: contact.phone, message: text, templateId: settings.template_id })),
  );
  const sent = results.filter((result) => result.status === 'fulfilled').length;
  const failed = results.length - sent;

  results
    .filter((result) => result.status === 'rejected')
    .forEach((result) => console.error('[sos] emergency contact SMS failed:', result.reason?.message || result.reason));

  await appendAlertLog(alert._id, `SOS SMS sent to ${sent} of ${results.length} emergency contact(s)`);
  return { sent, failed };
};

const pushFleetOwner = async ({ alert }) => {
  const settings = await getSosSmsSettings();
  // On unless the admin turns it off: a push costs nothing and goes only to
  // the owner of the vehicle involved.
  if (settings.notify_fleet_owner !== undefined && !isEnabled(settings.notify_fleet_owner)) {
    return { pushed: 0, skipped: 'disabled' };
  }
  if (!alert.driverId) return { pushed: 0, skipped: 'no-driver' };

  const driver = await Driver.findById(alert.driverId).select('owner_id').lean();
  if (!driver?.owner_id) return { pushed: 0, skipped: 'no-owner' };

  const owner = await Owner.findById(driver.owner_id).select('fcmTokenWeb fcmTokenMobile').lean();
  const tokens = listEntityPushTokens(owner || {}, 'owner').map((entry) => entry.token);
  const messaging = getFirebaseMessaging();
  if (!tokens.length || !messaging) return { pushed: 0, skipped: tokens.length ? 'no-firebase' : 'no-tokens' };

  const who = alert.sourceApp === 'driver' ? `Driver ${alert.driverName || ''}`.trim() : `Rider ${alert.riderName || ''}`.trim();
  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: {
      title: 'SOS on your vehicle',
      body: `${who} raised an SOS${alert.vehicleLabel ? ` in ${alert.vehicleLabel}` : ''}. ${locationLinkFor(alert)}`.trim(),
    },
    data: {
      type: 'sos_alert',
      alertId: String(alert._id),
      rideId: String(alert.rideId || ''),
      driverId: String(alert.driverId || ''),
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    android: { priority: 'high' },
  });

  await appendAlertLog(alert._id, `SOS push sent to fleet owner (${response.successCount} device(s))`);
  return { pushed: response.successCount };
};

/// Fire-and-forget entry point used by the SOS controllers.
export const queueSosFanout = ({ alert, sourceApp }) => {
  if (!alert?._id && !alert?.id) return;
  const normalized = { ...alert, _id: alert._id || alert.id };

  setImmediate(() => {
    Promise.allSettled([
      smsEmergencyContacts({ alert: normalized, sourceApp }),
      pushFleetOwner({ alert: normalized }),
    ]).then((outcomes) => {
      outcomes
        .filter((outcome) => outcome.status === 'rejected')
        .forEach((outcome) => console.error('[sos] fan-out step failed:', outcome.reason?.message || outcome.reason));
    });
  });
};
