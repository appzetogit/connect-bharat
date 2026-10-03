import mongoose from 'mongoose';
import { env } from '../../../../config/env.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { SetPrice } from '../../admin/models/SetPrice.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { Driver } from '../models/Driver.js';
import { WalletTransaction } from '../models/WalletTransaction.js';
import { Ride } from '../../user/models/Ride.js';
import { DriverSubscription } from '../models/DriverSubscription.js';
import { getWalletSettings } from '../../services/appSettingsService.js';
import { advancePaidAmount } from '../../outstation/services/outstationFare.js';
import { computeCorporateDriverWalletCredit } from '../../corporate/services/corporateV2Rules.js';
import {
  getActiveDriverSubscription,
  getDriverVehicleClasses,
  resolveDriverSubscriptionSettings,
} from './driverSubscriptionService.js';
import { abortTransaction, beginTransaction, commitTransaction } from '../../../../utils/transaction.js';

const normalizeAmount = (value, fieldName = 'amount') => {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    throw new ApiError(400, `${fieldName} must be a valid number`);
  }

  return Math.round(amount * 100) / 100;
};

// 'corporate' settles like 'online' (the driver collected nothing, so earnings
// are credited) but is kept by name so settlement does not overwrite it.
const normalizePaymentMethod = (value) => (
  String(value || '').trim().toLowerCase() === 'cash' ? 'cash'
    : String(value || '').trim().toLowerCase() === 'corporate' ? 'corporate' : 'online'
);

const normalizeCommissionType = (value) => {
  const numericValue = Number(value);
  return numericValue === 1 ? 'percentage' : 'fixed';
};

const computeCommissionAmount = ({ fare, type, value }) => {
  const safeFare = normalizeAmount(fare, 'fare');
  const safeValue = Math.max(normalizeAmount(value || 0, 'commission'), 0);

  if (normalizeCommissionType(type) === 'percentage') {
    return Math.min(Math.round((safeFare * safeValue)) / 100, safeFare);
  }

  return Math.min(safeValue, safeFare);
};

const resolveCommissionConfigForRide = async (ride, session) => {
  if (ride?.pricingSnapshot?.admin_commission_from_driver !== undefined) {
    return {
      source: ride.pricingSnapshot?.setPriceId ? 'ride_snapshot' : 'ride_snapshot_fallback',
      type: Number(ride.pricingSnapshot?.admin_commission_type_from_driver ?? 1),
      value: Number(ride.pricingSnapshot?.admin_commission_from_driver ?? 0),
    };
  }

  if (ride?.vehicleTypeId) {
    const normalizedServiceType = String(ride?.serviceType || '').trim().toLowerCase();
    const savedTransportType = String(ride.transport_type || '').trim().toLowerCase();
    const normalizedTransportType =
      normalizedServiceType === 'parcel'
        ? (savedTransportType === 'delivery' || savedTransportType === 'both' ? savedTransportType : 'delivery')
        : (savedTransportType || 'taxi');
    const filters = [
      {
        vehicle_type: ride.vehicleTypeId,
        active: 1,
        status: 'active',
        ...(ride.service_location_id ? { service_location_id: ride.service_location_id } : {}),
        transport_type: normalizedTransportType,
      },
      {
        vehicle_type: ride.vehicleTypeId,
        active: 1,
        status: 'active',
        ...(ride.service_location_id ? { service_location_id: ride.service_location_id } : {}),
        transport_type: 'both',
      },
      {
        vehicle_type: ride.vehicleTypeId,
        active: 1,
        status: 'active',
        transport_type: normalizedTransportType,
      },
      {
        vehicle_type: ride.vehicleTypeId,
        active: 1,
        status: 'active',
        transport_type: 'both',
      },
    ];

    for (const filter of filters) {
      const setPrice = await SetPrice.findOne(filter).sort({ updatedAt: -1, createdAt: -1 }).session(session).lean();
      if (setPrice) {
        return {
          source: 'set_price_lookup',
          type: Number(setPrice.admin_commission_type_from_driver ?? 1),
          value: Number(setPrice.admin_commission_from_driver ?? 0),
          setPriceId: setPrice._id,
        };
      }
    }

    if (normalizedServiceType === 'parcel') {
      const vehicle = await Vehicle.findById(ride.vehicleTypeId)
        .select('admin_commission_type_from_driver admin_commission_from_driver')
        .session(session)
        .lean();

      if (vehicle) {
        return {
          source: 'vehicle_type_parcel_fallback',
          type: Number(vehicle.admin_commission_type_from_driver ?? 1),
          value: Number(vehicle.admin_commission_from_driver ?? 0),
        };
      }
    }
  }

  return {
    source: 'env_fallback',
    type: 1,
    value: Number(env.driverWallet.commissionPercent || 0),
  };
};

const toNonNegativeNumber = (value, fallback = 0) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : fallback;
};

const isEnabledSetting = (value, fallback = true) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const resolveWalletRules = async () => {
  const walletSettings = await getWalletSettings();
  const configuredMinimumBalance = Number(walletSettings.driver_wallet_minimum_amount_to_get_an_order);
  const minimumBalanceForOrders = Number.isFinite(configuredMinimumBalance)
    ? Math.round(configuredMinimumBalance * 100) / 100
    : -toNonNegativeNumber(env.driverWallet.defaultCashLimit, 500);

  return {
    minimumBalanceForOrders,
    cashLimit: Math.abs(Math.min(minimumBalanceForOrders, 0)),
    minimumTopUpAmount: toNonNegativeNumber(walletSettings.minimum_amount_added_to_wallet, 0),
    minimumTransferAmount: toNonNegativeNumber(walletSettings.minimum_wallet_amount_for_transfer, 0),
    isWalletEnabled: isEnabledSetting(walletSettings.show_wallet_feature_for_driver, true),
    isTransferEnabled: isEnabledSetting(walletSettings.enable_wallet_transfer_driver, true),
  };
};

const getWalletSnapshot = async (driver) => {
  const rules = await resolveWalletRules();
  const balance = Number(driver?.wallet?.balance || 0);

  return {
    balance,
    cashLimit: rules.cashLimit,
    minimumBalanceForOrders: rules.minimumBalanceForOrders,
    availableForOrders: Math.round((balance - rules.minimumBalanceForOrders) * 100) / 100,
    isBlocked: Boolean(driver?.wallet?.isBlocked),
    rules,
  };
};

// Whether a paid pass is covering this driver right now, in which case the
// wallet minimum is not asked of them. Always on: a pass is mandatory.
const isCoveredBySubscription = async (driverId, { session } = {}) => {
  const settings = await resolveDriverSubscriptionSettings();
  if (!settings.waiveWalletMinimum) return false;
  return Boolean(await getActiveDriverSubscription(driverId, { session }));
};

export const serializeDriverWallet = async (driver) => {
  const wallet = await getWalletSnapshot(driver);
  const isBelowMinimumBalance = wallet.balance < wallet.minimumBalanceForOrders;
  const covered = await isCoveredBySubscription(driver._id);

  return {
    balance: wallet.balance,
    cashLimit: wallet.cashLimit,
    minimumBalanceForOrders: wallet.minimumBalanceForOrders,
    availableForOrders: wallet.availableForOrders,
    isWalletEnabled: wallet.rules.isWalletEnabled,
    isTransferEnabled: wallet.rules.isTransferEnabled,
    minimumTopUpAmount: wallet.rules.minimumTopUpAmount,
    minimumTransferAmount: wallet.rules.minimumTransferAmount,
    isBlocked: !wallet.rules.isWalletEnabled || ((wallet.isBlocked || isBelowMinimumBalance) && !covered),
  };
};

export const ensureDriverWalletCanAcceptRide = async (driverOrId, { session } = {}) => {
  const driver =
    typeof driverOrId === 'object' && driverOrId?._id
      ? driverOrId
      : await Driver.findById(driverOrId).session(session);

  if (!driver) {
    throw new ApiError(404, 'Driver not found');
  }

  const wallet = await getWalletSnapshot(driver);
  const isBelowMinimumBalance = wallet.balance < wallet.minimumBalanceForOrders;

  // A driver on a daily pass has already paid for the day, so the wallet
  // minimum is not asked of them - that is most of what they bought. An
  // admin-disabled wallet still blocks, since that is not about balance.
  const subscriptionSettings = await resolveDriverSubscriptionSettings();
  const subscription = subscriptionSettings.waiveWalletMinimum
    ? await getActiveDriverSubscription(driver._id, { session })
    : null;
  const balanceWaived = Boolean(subscription);

  const isBlocked = wallet.isBlocked || !wallet.rules.isWalletEnabled || (isBelowMinimumBalance && !balanceWaived);

  if (isBlocked) {
    await Driver.findByIdAndUpdate(driver._id, {
      'wallet.cashLimit': wallet.cashLimit,
      'wallet.isBlocked': true,
    });
    throw new ApiError(403, wallet.rules.isWalletEnabled
      ? 'Driver wallet minimum balance is not met. Please top up to accept rides.'
      : 'Driver wallet is disabled by admin.');
  }

  if (Number(driver?.wallet?.cashLimit) !== wallet.cashLimit || driver?.wallet?.isBlocked) {
    await Driver.findByIdAndUpdate(driver._id, {
      'wallet.cashLimit': wallet.cashLimit,
      'wallet.isBlocked': false,
    });
  }

  return wallet;
};

export const applyDriverWalletAdjustment = async ({
  driverId,
  amount,
  type,
  rideId = null,
  description = '',
  metadata = {},
  session = null,
}) => {
  const normalizedAmount = normalizeAmount(amount);

  if (!normalizedAmount) {
    throw new ApiError(400, 'Wallet adjustment amount cannot be zero');
  }

  const driver = await Driver.findById(driverId).session(session);

  if (!driver) {
    throw new ApiError(404, 'Driver not found');
  }

  const before = await getWalletSnapshot(driver);
  const balanceAfter = Math.round((before.balance + normalizedAmount) * 100) / 100;
  // The subscription row is created before the debit that pays for it (same
  // session), so a pass bought or granted right now already counts here.
  const covered = await isCoveredBySubscription(driverId, { session });
  const isBlockedAfter =
    !before.rules.isWalletEnabled || (balanceAfter < before.minimumBalanceForOrders && !covered);

  const updatedDriver = await Driver.findByIdAndUpdate(
    driverId,
    {
      $inc: { 'wallet.balance': normalizedAmount },
      $set: {
        'wallet.cashLimit': before.cashLimit,
        'wallet.isBlocked': isBlockedAfter,
      },
    },
    { returnDocument: 'after', session },
  );

  const [transaction] = await WalletTransaction.create(
    [
      {
        driverId,
        rideId,
        type,
        amount: normalizedAmount,
        balanceBefore: before.balance,
        balanceAfter,
        cashLimit: before.cashLimit,
        isBlockedAfter,
        description,
        metadata,
      },
    ],
    { session },
  );

  return {
    driver: updatedDriver,
    wallet: await serializeDriverWallet(updatedDriver),
    transaction,
  };
};

/**
 * One-time joining bonus, credited when a driver is first approved.
 *
 * Claims the grant before paying it: the updateOne only matches while
 * joiningBonusGrantedAt is still null, so whichever call wins the race is the
 * only one that credits. Approving twice, un-approving and re-approving, or two
 * admins clicking at the same moment across our four instances all pay once.
 *
 * Returns null when there was nothing to do, so callers can stay quiet.
 */
// Fixed on purpose, not an admin setting. A driver on several classes gets the
// richest of them; anything unrecognised falls back to DRIVER_JOINING_BONUS.
const JOINING_BONUS_BY_CLASS = { bike: 100, auto: 100, car: 150 };

const resolveJoiningBonus = async (driverId) => {
  const driver = await Driver.findById(driverId).lean();
  const classes = driver ? await getDriverVehicleClasses(driver) : [];
  const amounts = classes
    .map((vehicleClass) => JOINING_BONUS_BY_CLASS[vehicleClass])
    .filter((value) => Number.isFinite(value));

  if (amounts.length > 0) {
    return { amount: Math.max(...amounts), classes };
  }

  return { amount: normalizeAmount(env.driverWallet.joiningBonus), classes };
};

/**
 * Recomputes the stored wallet-blocked flag from the driver's balance and
 * whether a pass is covering them. Run when a pass starts or ends, since the
 * flag is otherwise only rewritten when money moves.
 */
export const syncDriverWalletBlockedFlag = async (driverId) => {
  const driver = await Driver.findById(driverId);
  if (!driver) return null;

  const wallet = await getWalletSnapshot(driver);
  const covered = await isCoveredBySubscription(driver._id);
  const isBlocked =
    !wallet.rules.isWalletEnabled || (wallet.balance < wallet.minimumBalanceForOrders && !covered);

  if (Boolean(driver.wallet?.isBlocked) !== isBlocked) {
    await Driver.updateOne({ _id: driver._id }, { $set: { 'wallet.isBlocked': isBlocked } });
  }

  return isBlocked;
};

export const grantDriverJoiningBonus = async ({ driverId, grantedBy = null }) => {
  const { amount: bonusAmount, classes: bonusClasses } = await resolveJoiningBonus(driverId);
  const amount = normalizeAmount(bonusAmount);

  if (!amount || amount <= 0) {
    return null;
  }

  const claim = await Driver.updateOne(
    { _id: driverId, joiningBonusGrantedAt: null },
    { $set: { joiningBonusGrantedAt: new Date() } },
  );

  if (!claim.modifiedCount) {
    return null;
  }

  try {
    return await applyDriverWalletAdjustment({
      driverId,
      amount,
      type: 'adjustment',
      description: 'Joining bonus on approval',
      metadata: { reason: 'driver_joining_bonus', grantedBy, vehicleClasses: bonusClasses },
    });
  } catch (error) {
    // Release the claim so a retry can still pay them. Leaving it set would mark
    // the bonus as given when no money ever moved.
    await Driver.updateOne({ _id: driverId }, { $set: { joiningBonusGrantedAt: null } }).catch(() => null);
    throw error;
  }
};

export const topUpDriverWallet = async ({ driverId, amount, metadata = {} }) => {
  const session = await mongoose.startSession();

  try {
    beginTransaction(session);

    const walletSettings = await getWalletSettings();
    if (!isEnabledSetting(walletSettings.show_wallet_feature_for_driver, true)) {
      throw new ApiError(403, 'Driver wallet is disabled by admin');
    }

    const minimumTopUpAmount = toNonNegativeNumber(walletSettings.minimum_amount_added_to_wallet, 0);
    const normalizedTopUpAmount = Math.abs(normalizeAmount(amount));

    if (minimumTopUpAmount > 0 && normalizedTopUpAmount < minimumTopUpAmount) {
      throw new ApiError(400, `amount must be at least ${minimumTopUpAmount}`);
    }

    const result = await applyDriverWalletAdjustment({
      driverId,
      amount: normalizedTopUpAmount,
      type: 'top_up',
      description: 'Driver wallet top-up',
      metadata: {
        ...metadata,
        minimumTopUpAmount,
      },
      session,
    });

    await commitTransaction(session);
    return result;
  } catch (error) {
    await abortTransaction(session);
    throw error;
  } finally {
    session.endSession();
  }
};

export const settleCompletedRideWallet = async ({ rideId }) => {
  const session = await mongoose.startSession();

  try {
    beginTransaction(session);

    const ride = await Ride.findOneAndUpdate(
      { _id: rideId, walletSettledAt: null, driverId: { $ne: null } },
      { $set: { walletSettledAt: new Date() } },
      { returnDocument: 'after', session },
    );

    if (!ride) {
      await commitTransaction(session);
      return null;
    }

    const fare = normalizeAmount(ride.fare || 0, 'fare');
    const commissionConfig = await resolveCommissionConfigForRide(ride, session);
    const tripCommission = computeCommissionAmount({
      fare,
      type: commissionConfig.type,
      value: commissionConfig.value,
    });
    // The rider's per-ride platform fee was collected inside the fare but was
    // never the driver's money: it goes to admin with the commission. Zero on
    // every ride booked by an app that doesn't charge one, so those settle
    // exactly as before. Read here, before the snapshot is replaced below.
    const platformFee = Math.min(Math.max(0, Number(ride.pricingSnapshot?.rider_platform_fee) || 0), fare);

    // A driver on a daily pass keeps the fare: the pass is what Connect Bharat earned
    // from them today. The rider's platform fee is still not theirs, so it is
    // the one part that survives the waiver.
    //
    // Read against the ride's completion rather than now, so a trip finished
    // at 5:55am is settled under the pass that covered it even if settlement
    // runs after 6am.
    const subscriptionSettings = await resolveDriverSubscriptionSettings();
    const coveringSubscription = subscriptionSettings.waiveCommission
      ? await DriverSubscription.findOne({
        driverId: ride.driverId,
        status: 'active',
        paidAt: { $ne: null },
        startsAt: { $lte: ride.completedAt || ride.updatedAt || new Date() },
        expiresAt: { $gt: ride.completedAt || ride.updatedAt || new Date() },
      }).session(session).lean()
      : null;

    const waivedCommission = coveringSubscription ? tripCommission : 0;
    const chargeableCommission = coveringSubscription ? 0 : tripCommission;
    const commissionAmount = Math.min(Math.round((chargeableCommission + platformFee) * 100) / 100, fare);
    const paymentMethod = normalizePaymentMethod(ride.paymentMethod);
    const driverEarnings = Math.max(Math.round((fare - commissionAmount) * 100) / 100, 0);
    // An outstation advance was collected online by admin, so on a cash ride
    // the driver only took fare - advance in hand and is owed the advance back.
    const advancePaid = Math.min(advancePaidAmount(ride), fare);
    // Corporate ride whose employee paid the excess km share in cash to the
    // driver: credit fare - commission - that cash (corporateV2Rules.js).
    const corporateCredit = paymentMethod === 'corporate' ? computeCorporateDriverWalletCredit({ driverEarnings, split: ride.corporate?.split }) : null;
    const amount = paymentMethod === 'cash' ? Math.round((advancePaid - commissionAmount) * 100) / 100 : (corporateCredit ? corporateCredit.amount : driverEarnings);
    const type = paymentMethod === 'cash' && amount < 0 ? 'commission_deduction' : (corporateCredit ? corporateCredit.type : 'ride_earning');

    ride.paymentMethod = paymentMethod;
    ride.commissionAmount = commissionAmount;
    ride.driverEarnings = driverEarnings;
    // Spread the existing snapshot first: replacing it outright erased the
    // booked fare breakdown, fare source and waiting terms the invoice and the
    // outstation fare adjustment read after completion.
    const existingSnapshot = typeof ride.pricingSnapshot?.toObject === 'function'
      ? ride.pricingSnapshot.toObject()
      : (ride.pricingSnapshot || {});
    ride.pricingSnapshot = {
      ...existingSnapshot,
      setPriceId: ride.pricingSnapshot?.setPriceId || commissionConfig.setPriceId || null,
      admin_commission_type_from_driver: Number(commissionConfig.type ?? ride.pricingSnapshot?.admin_commission_type_from_driver ?? 1),
      admin_commission_from_driver: Number(commissionConfig.value ?? ride.pricingSnapshot?.admin_commission_from_driver ?? 0),
      rider_platform_fee: platformFee,
      resolvedAt: ride.pricingSnapshot?.resolvedAt || new Date(),
    };
    await ride.save({ session });

    // What the pass was worth today, for the driver's own screen and the
    // admin history. Counted per settled ride, so it cannot double-count.
    if (coveringSubscription) {
      await DriverSubscription.updateOne(
        { _id: coveringSubscription._id },
        { $inc: { tripsCovered: 1, commissionWaived: Math.round(waivedCommission * 100) / 100 } },
        { session },
      );
    }

    if (!amount) {
      await commitTransaction(session);
      return null;
    }

    const result = await applyDriverWalletAdjustment({
      driverId: ride.driverId,
      rideId: ride._id,
      amount,
      type,
      description: paymentMethod === 'cash'
        ? (platformFee > 0 ? 'Commission and platform fee deducted for cash ride' : 'Commission deducted for cash ride')
        : 'Driver earning credited for online ride',
      metadata: {
        fare,
        commissionAmount,
        driverEarnings,
        paymentMethod,
        commissionSource: commissionConfig.source,
        commissionType: normalizeCommissionType(commissionConfig.type),
        commissionValue: Number(commissionConfig.value || 0),
        tripCommission,
        platformFee,
        subscriptionId: coveringSubscription ? String(coveringSubscription._id) : null,
        commissionWaived: waivedCommission,
        ...(corporateCredit?.cashCollected ? { corporateEmployeeCashCollected: corporateCredit.cashCollected } : {}),
      },
      session,
    });

    await commitTransaction(session);
    return {
      ...result,
      ride,
    };
  } catch (error) {
    await abortTransaction(session);
    throw error;
  } finally {
    session.endSession();
  }
};
