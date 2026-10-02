import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Driver } from '../models/Driver.js';
import { DriverSubscription } from '../models/DriverSubscription.js';
import { SubscriptionPlan } from '../../admin/models/SubscriptionPlan.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { getDriverSubscriptionSettings } from '../../services/transportSettingsService.js';
// Imported lazily inside purchaseDriverSubscription (not at module load) to
// avoid a circular import: walletService.js itself imports
// getActiveDriverSubscription/resolveDriverSubscriptionSettings from this file.
let applyDriverWalletAdjustmentPromise = null;
const getApplyDriverWalletAdjustment = async () => {
  if (!applyDriverWalletAdjustmentPromise) {
    applyDriverWalletAdjustmentPromise = import('./walletService.js').then((mod) => mod.applyDriverWalletAdjustment);
  }
  return applyDriverWalletAdjustmentPromise;
};

const isOn = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const toList = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export const resolveDriverSubscriptionSettings = async () => {
  const group = (await getDriverSubscriptionSettings()) || {};

  // A paid pass is mandatory for every driver, so the admin's mode / expiry
  // behaviour / wallet-minimum switches no longer apply: with a pass the wallet
  // balance is not checked, without one no ride is offered at all. Commission
  // waiver, plans, payment methods and the cycle hour stay admin-controlled.
  return {
    mode: 'subscription_only',
    waiveCommission: isOn(group.waive_commission, true),
    waiveWalletMinimum: true,
    multiVehicleRule: String(group.multi_vehicle_rule || 'highest').trim().toLowerCase(),
    paymentMethods: toList(group.payment_methods || 'wallet,gateway'),
    onExpiry: 'block',
    cycleStartHour: Math.min(23, Math.max(0, Number(group.cycle_start_hour ?? 6) || 0)),
    timezone: String(group.cycle_timezone || 'Asia/Kolkata').trim() || 'Asia/Kolkata',
  };
};

export const isSubscriptionEnabled = (settings) => settings.mode === 'subscription_only' || settings.mode === 'both';

/**
 * The pass window covering `now`: from the most recent cycle start to the next.
 *
 * A pass bought at noon still ends at 6am, so this is a fixed clock window
 * rather than 24 hours from payment.
 *
 * The hour is local to the configured timezone while the servers run on UTC,
 * so the offset is measured rather than assumed - which also keeps it correct
 * for a timezone that is not a whole number of hours from UTC, as India's is
 * not.
 */
export const getCycleWindow = (settings, now = new Date()) => {
  const { timezone, cycleStartHour } = settings;

  // What the wall clock reads in `timezone` at this instant.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? 0 : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  // Positive for timezones ahead of UTC, e.g. +5:30 for Asia/Kolkata.
  const offsetMs = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;

  const localStartOfHour = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    cycleStartHour,
    0,
    0,
  );
  // Before the cycle hour the current window began yesterday.
  const startLocal = localAsUtc >= localStartOfHour ? localStartOfHour : localStartOfHour - 24 * 60 * 60 * 1000;

  return {
    startsAt: new Date(startLocal - offsetMs),
    expiresAt: new Date(startLocal + 24 * 60 * 60 * 1000 - offsetMs),
  };
};

/** The paid, unexpired pass for a driver, or null. */
export const getActiveDriverSubscription = async (driverId, { session = null } = {}) => {
  if (!driverId) return null;

  const query = DriverSubscription.findOne({
    driverId,
    status: 'active',
    paidAt: { $ne: null },
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 });

  if (session) query.session(session);

  return query.lean();
};

export const hasActiveDriverSubscription = async (driverId, options) =>
  Boolean(await getActiveDriverSubscription(driverId, options));

/**
 * Which classes of vehicle a driver drives, from the catalog rather than the
 * free-text vehicleType on their record.
 */
export const getDriverVehicleClasses = async (driver) => {
  const ids = [driver.vehicleTypeId, ...(driver.vehicleTypeIds || [])]
    .map((id) => String(id || '').trim())
    .filter((id) => /^[a-f\d]{24}$/i.test(id));

  if (ids.length === 0) return [String(driver.vehicleType || '').trim().toLowerCase()].filter(Boolean);

  const vehicles = await Vehicle.find({ _id: { $in: ids } }, { category: 1, name: 1 }).lean();
  const classes = vehicles.map((vehicle) => String(vehicle.category || '').trim().toLowerCase()).filter(Boolean);

  return [...new Set(classes)];
};

/** Driver plans that cover at least one class this driver drives. */
export const listPlansForDriver = async (driver) => {
  const settings = await resolveDriverSubscriptionSettings();
  const classes = await getDriverVehicleClasses(driver);
  const plans = await SubscriptionPlan.find({ audience: 'driver', active: true }).lean();

  const matching = plans.filter((plan) => {
    // A driver on a vehicle with no bike/auto/car class (e.g. a delivery truck)
    // matches no plan by class. With a pass mandatory that would lock them out
    // for good, so every plan is offered rather than none.
    if (classes.length === 0) return true;
    const covers = (plan.vehicle_classes || []).map((value) => String(value).trim().toLowerCase());
    // A plan with no classes set covers everything, so a half-configured plan
    // is visible rather than silently unbuyable.
    if (covers.length === 0) return true;
    return classes.some((value) => covers.includes(value));
  });

  // 'highest' means the dearest plan covering any of their vehicles - a driver
  // with both an auto and a cab pays the cab price and may drive both.
  if (settings.multiVehicleRule === 'highest' && matching.length > 1) {
    const dearest = matching.reduce((best, plan) => (Number(plan.amount) > Number(best.amount) ? plan : best));
    return { settings, classes, plans: [dearest] };
  }

  return { settings, classes, plans: matching.sort((a, b) => Number(a.amount) - Number(b.amount)) };
};

export const getDriverSubscriptionStatus = async (driverId) => {
  const driver = await Driver.findById(driverId).lean();
  if (!driver) throw new ApiError(404, 'Driver not found');

  const [{ settings, plans }, active] = await Promise.all([
    listPlansForDriver(driver),
    getActiveDriverSubscription(driverId),
  ]);

  const window = getCycleWindow(settings);

  return {
    enabled: isSubscriptionEnabled(settings),
    required: settings.mode === 'subscription_only',
    status: active ? 'active' : 'expired',
    expiresAt: active ? active.expiresAt : null,
    // What a driver who renews now would get, so the app can say "valid until"
    // before they pay.
    currentCycle: window,
    paymentMethods: settings.paymentMethods,
    onExpiry: settings.onExpiry,
    subscription: active
      ? {
          id: String(active._id),
          planName: active.planName,
          amount: active.amount,
          startsAt: active.startsAt,
          expiresAt: active.expiresAt,
          paymentMethod: active.paymentMethod,
          vehicleClasses: active.vehicleClasses,
        }
      : null,
    plans: plans.map((plan) => ({
      id: String(plan._id),
      name: plan.name || 'Daily Subscription',
      description: plan.description || '',
      amount: Number(plan.amount || 0),
      vehicleClasses: (plan.vehicle_classes || []).map((value) => String(value).toLowerCase()),
      howItWorks: plan.how_it_works || '',
    })),
  };
};

/**
 * Buy today's pass.
 *
 * Wallet payments settle here inside a transaction. Gateway payments create
 * the row unpaid and are activated by the gateway's verify step, so a failed
 * payment never leaves an active pass behind.
 */
export const purchaseDriverSubscription = async ({ driverId, planId, paymentMethod = 'wallet' }) => {
  const settings = await resolveDriverSubscriptionSettings();

  if (!isSubscriptionEnabled(settings)) {
    throw new ApiError(400, 'Subscriptions are not enabled');
  }

  const method = String(paymentMethod || 'wallet').trim().toLowerCase();
  const isGateway = method === 'razorpay' || method === 'phonepe';

  if (method === 'wallet' && !settings.paymentMethods.includes('wallet')) {
    throw new ApiError(400, 'Paying from the wallet is not enabled');
  }
  if (isGateway && !settings.paymentMethods.includes('gateway')) {
    throw new ApiError(400, 'Online payment is not enabled');
  }

  const driver = await Driver.findById(driverId);
  if (!driver) throw new ApiError(404, 'Driver not found');

  const existing = await getActiveDriverSubscription(driverId);
  if (existing) {
    throw new ApiError(409, 'A subscription is already active until the end of this cycle');
  }

  const { plans } = await listPlansForDriver(driver.toObject());
  const plan = plans.find((item) => String(item._id) === String(planId)) || (plans.length === 1 ? plans[0] : null);

  if (!plan) {
    throw new ApiError(400, 'Choose a subscription plan');
  }

  const amount = Number(plan.amount || 0);
  const { startsAt, expiresAt } = getCycleWindow(settings);

  const record = {
    driverId: driver._id,
    planId: plan._id,
    planName: plan.name || 'Daily Subscription',
    amount,
    vehicleClasses: (plan.vehicle_classes || []).map((value) => String(value).toLowerCase()),
    startsAt,
    expiresAt,
    paymentMethod: method,
    paidAt: null,
  };

  if (isGateway) {
    // Unpaid until the gateway confirms; activateDriverSubscription finishes it.
    const created = await DriverSubscription.create(record);
    return { subscription: created.toObject(), requiresPayment: true, amount };
  }

  const applyDriverWalletAdjustment = await getApplyDriverWalletAdjustment();
  const session = await mongoose.startSession();

  try {
    let created = null;

    await session.withTransaction(async () => {
      const currentBalance = Number(
        (await Driver.findById(driver._id).select('wallet.balance').session(session))?.wallet?.balance || 0,
      );

      if (currentBalance < amount) {
        throw new ApiError(400, 'Not enough wallet balance for this subscription');
      }

      const [row] = await DriverSubscription.create([{ ...record, paidAt: new Date() }], { session });
      created = row;

      // Debited (and left) as a normal wallet transaction, not a silent
      // balance edit, so the driver sees exactly why the money left —
      // same helper every other wallet debit/credit goes through.
      await applyDriverWalletAdjustment({
        driverId: driver._id,
        amount: -amount,
        type: 'subscription_purchase',
        description: `Daily Subscription purchased - ${plan.name || 'Daily Pass'}`,
        metadata: { subscriptionId: row._id, planId: plan._id, planName: plan.name },
        session,
      });
    });

    return { subscription: created?.toObject(), requiresPayment: false, amount };
  } finally {
    await session.endSession();
  }
};

/**
 * Spends a driver's one-time joining bonus on their first pass instead of
 * leaving it sitting in the wallet. Called once, right after
 * grantDriverJoiningBonus credits the bonus on approval.
 *
 * Buys as many whole days of the driver's own plan (bike/auto/car each price
 * differently) as the bonus covers; any remainder is left in the wallet as
 * ordinary balance rather than forced to zero. A driver with no matching
 * plan, an unaffordable one, or subscriptions turned off simply keeps the
 * bonus as cash - nothing here is forced.
 *
 * Recorded with paymentMethod 'bonus' (never reused after this call) so the
 * driver's next pass always goes through wallet/UPI like everyone else's.
 */
export const purchaseDriverSubscriptionFromJoiningBonus = async ({ driverId, bonusAmount }) => {
  const amount = Number(bonusAmount || 0);
  if (!amount || amount <= 0) return null;

  const settings = await resolveDriverSubscriptionSettings();
  if (!isSubscriptionEnabled(settings)) return null;
  if (!settings.paymentMethods.includes('wallet')) return null;

  const driver = await Driver.findById(driverId);
  if (!driver) return null;

  if (await getActiveDriverSubscription(driverId)) return null;

  const { plans } = await listPlansForDriver(driver.toObject());
  // Plans sort cheapest-first; with no vehicle picked yet to disambiguate,
  // the cheapest plan the bonus can afford covers the most days.
  const plan = plans[0];
  if (!plan) return null;

  const amountPerDay = Number(plan.amount || 0);
  if (!amountPerDay || amountPerDay <= 0) return null;

  const days = Math.floor(amount / amountPerDay);
  if (days < 1) return null;

  const spend = Math.round(amountPerDay * days * 100) / 100;
  const { startsAt } = getCycleWindow(settings);
  const expiresAt = new Date(startsAt.getTime() + days * 24 * 60 * 60 * 1000);

  const applyDriverWalletAdjustment = await getApplyDriverWalletAdjustment();
  const session = await mongoose.startSession();

  try {
    let created = null;

    await session.withTransaction(async () => {
      const currentBalance = Number(
        (await Driver.findById(driver._id).select('wallet.balance').session(session))?.wallet?.balance || 0,
      );

      // Should not happen right after the bonus credit, but a driver whose
      // wallet moved in between (e.g. a debit from elsewhere) just keeps the
      // bonus as cash rather than being forced into a pass they can't afford.
      if (currentBalance < spend) return;

      const [row] = await DriverSubscription.create(
        [
          {
            driverId: driver._id,
            planId: plan._id,
            planName: plan.name || 'Daily Subscription',
            amount: spend,
            vehicleClasses: (plan.vehicle_classes || []).map((value) => String(value).toLowerCase()),
            startsAt,
            expiresAt,
            paymentMethod: 'bonus',
            paidAt: new Date(),
          },
        ],
        { session },
      );
      created = row;

      await applyDriverWalletAdjustment({
        driverId: driver._id,
        amount: -spend,
        type: 'subscription_purchase',
        description: `${days}-day Daily Subscription auto-purchased from your joining bonus - ${plan.name || 'Daily Pass'}`,
        metadata: { subscriptionId: row._id, planId: plan._id, planName: plan.name, days, source: 'joining_bonus' },
        session,
      });
    });

    return created ? { subscription: created.toObject(), days, amount: spend } : null;
  } finally {
    await session.endSession();
  }
};

/** Called once a gateway payment is verified. */
export const activateDriverSubscription = async ({ subscriptionId, paymentReference = '' }) => {
  const updated = await DriverSubscription.findOneAndUpdate(
    { _id: subscriptionId, paidAt: null, status: 'active' },
    { $set: { paidAt: new Date(), paymentReference: String(paymentReference || '') } },
    { returnDocument: 'after' },
  ).lean();

  if (!updated) throw new ApiError(404, 'Subscription payment not found or already confirmed');

  // The stored wallet-blocked flag may be set from a low balance; with a pass
  // now active it must not keep the driver out of dispatch.
  const { syncDriverWalletBlockedFlag } = await import('./walletService.js');
  await syncDriverWalletBlockedFlag(updated.driverId).catch(() => null);

  return updated;
};
