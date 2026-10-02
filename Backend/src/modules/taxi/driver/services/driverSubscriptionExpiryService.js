import { DriverSubscription } from '../models/DriverSubscription.js';
import { getActiveDriverSubscription } from './driverSubscriptionService.js';
import { syncDriverWalletBlockedFlag } from './walletService.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Only passes that ended recently are announced. Without this bound, the first
// sweep after this ships would push "your subscription has ended" for every
// pass that lapsed before the feature existed.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

let sweepTimer = null;

/**
 * Tells drivers whose pass just ended, and re-applies the wallet check to them.
 *
 * Expiry is not an event - a pass lapses by comparison against `expiresAt` -
 * so this polls. Each pass is claimed with an atomic update on
 * `expiryNotifiedAt` before anything is sent, which is what stops the four
 * server instances (all running this loop) from notifying twice.
 */
export const sweepExpiredDriverSubscriptions = async () => {
  const now = new Date();

  const expired = await DriverSubscription.find({
    status: 'active',
    paidAt: { $ne: null },
    expiresAt: { $lte: now, $gt: new Date(now.getTime() - LOOKBACK_MS) },
    expiryNotifiedAt: null,
  })
    .select('_id driverId')
    .limit(BATCH_SIZE)
    .lean();

  for (const row of expired) {
    const claim = await DriverSubscription.updateOne(
      { _id: row._id, expiryNotifiedAt: null },
      { $set: { expiryNotifiedAt: new Date() } },
    );
    if (!claim.modifiedCount) continue;

    try {
      // Already bought the next one - nothing to nag about.
      if (await getActiveDriverSubscription(row.driverId)) continue;

      // The pass was waiving the wallet minimum; now it counts again.
      await syncDriverWalletBlockedFlag(row.driverId);

      await sendPushNotificationToEntities({
        driverIds: [String(row.driverId)],
        title: 'Your subscription has ended',
        body: 'Activate your Daily Subscription to keep receiving ride requests.',
        data: { type: 'subscription_expired' },
      });
    } catch (error) {
      console.error('Driver subscription expiry notice failed', row.driverId, error.message);
    }
  }
};

export const startDriverSubscriptionExpiryLoop = () => {
  if (sweepTimer) return;

  const run = () =>
    sweepExpiredDriverSubscriptions().catch((error) => {
      console.error('Driver subscription expiry sweep failed', error);
    });

  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  run();
};
