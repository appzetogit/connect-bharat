import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RIDE_STATUS } from '../../constants/index.js';
import { Ride } from '../../user/models/Ride.js';
import { listIstDayKeys, resolveNamedRange, toIstDayKey } from '../../services/dateRangeFilter.js';

/**
 * Driver earnings over a date range, aggregated in Mongo.
 *
 * Only completed rides count, bucketed by the IST day they completed on (the
 * day the driver sees on their phone). Every money figure comes from what was
 * stored on the ride at settlement - `fare`, `commissionAmount`,
 * `driverEarnings`, the rider platform fee and tip - so these numbers match
 * the wallet rather than being recomputed from today's tariff.
 *
 * `todaySummary` on the driver document stays the fast path for the home
 * screen; this is the history screen.
 */

const IST_TIMEZONE = 'Asia/Kolkata';

const toObjectId = (value) => {
  if (!mongoose.isValidObjectId(value)) {
    throw new ApiError(400, 'Invalid driver id');
  }
  return new mongoose.Types.ObjectId(String(value));
};

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

/// Group stage fields shared by the totals and the daily buckets.
const sumFields = {
  trips: { $sum: 1 },
  grossFare: { $sum: { $ifNull: ['$fare', 0] } },
  driverEarnings: { $sum: { $ifNull: ['$driverEarnings', 0] } },
  commission: { $sum: { $ifNull: ['$commissionAmount', 0] } },
  platformFee: { $sum: { $ifNull: ['$pricingSnapshot.rider_platform_fee', 0] } },
  promoDiscount: { $sum: { $ifNull: ['$promo.discount_amount', 0] } },
  tips: { $sum: { $ifNull: ['$feedback.tipAmount', 0] } },
  distanceMeters: { $sum: { $ifNull: ['$estimatedDistanceMeters', 0] } },
  cashTrips: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 1, 0] } },
  cashFare: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, { $ifNull: ['$fare', 0] }, 0] } },
  onlineTrips: { $sum: { $cond: [{ $ne: ['$paymentMethod', 'cash'] }, 1, 0] } },
  onlineFare: { $sum: { $cond: [{ $ne: ['$paymentMethod', 'cash'] }, { $ifNull: ['$fare', 0] }, 0] } },
};

const emptyTotals = () => ({
  trips: 0,
  grossFare: 0,
  driverEarnings: 0,
  commission: 0,
  platformFee: 0,
  promoDiscount: 0,
  tips: 0,
  distanceMeters: 0,
  cashTrips: 0,
  cashFare: 0,
  onlineTrips: 0,
  onlineFare: 0,
});

/// Shapes a raw group row into the response block. Exported for tests.
export const shapeEarningsTotals = (row = {}) => {
  const totals = { ...emptyTotals(), ...row };
  return {
    trips: Number(totals.trips || 0),
    grossFare: money(totals.grossFare),
    driverEarnings: money(totals.driverEarnings),
    tips: money(totals.tips),
    // What the driver takes home for the period: settled earnings plus tips.
    netEarnings: money(Number(totals.driverEarnings || 0) + Number(totals.tips || 0)),
    distanceKm: money(Number(totals.distanceMeters || 0) / 1000),
    commission: {
      adminCommission: money(totals.commission),
      riderPlatformFee: money(totals.platformFee),
      promoDiscount: money(totals.promoDiscount),
    },
    paymentSplit: {
      cash: { trips: Number(totals.cashTrips || 0), amount: money(totals.cashFare) },
      online: { trips: Number(totals.onlineTrips || 0), amount: money(totals.onlineFare) },
    },
  };
};

/// Zero-filled daily series over the range. Exported for tests.
export const fillDailyBuckets = (rows = [], from, to) => {
  const byDay = new Map(rows.map((row) => [row._id, row]));
  return listIstDayKeys(from, to).map((date) => {
    const row = byDay.get(date) || {};
    return {
      date,
      trips: Number(row.trips || 0),
      grossFare: money(row.grossFare),
      driverEarnings: money(row.driverEarnings),
      commission: money(row.commission),
      tips: money(row.tips),
      netEarnings: money(Number(row.driverEarnings || 0) + Number(row.tips || 0)),
    };
  });
};

const buildMatch = (driverId, from, to) => ({
  driverId: toObjectId(driverId),
  status: RIDE_STATUS.COMPLETED,
  completedAt: { $gte: from, $lte: to },
});

export const getDriverEarnings = async ({ driverId, range, from, to, now = new Date() }) => {
  const window = resolveNamedRange({ range, from, to, now });

  const [facet] = await Ride.aggregate([
    { $match: buildMatch(driverId, window.from, window.to) },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...sumFields } }],
        daily: [
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: IST_TIMEZONE } },
              ...sumFields,
            },
          },
          { $sort: { _id: 1 } },
        ],
        byService: [
          {
            $group: {
              _id: { $ifNull: ['$serviceType', 'ride'] },
              trips: { $sum: 1 },
              driverEarnings: { $sum: { $ifNull: ['$driverEarnings', 0] } },
              commission: { $sum: { $ifNull: ['$commissionAmount', 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);

  return {
    range: window.range,
    from: window.from,
    to: window.to,
    timezone: IST_TIMEZONE,
    totals: shapeEarningsTotals(facet?.totals?.[0] || {}),
    daily: fillDailyBuckets(facet?.daily || [], window.from, window.to),
    byServiceType: (facet?.byService || []).map((row) => ({
      serviceType: row._id,
      trips: Number(row.trips || 0),
      driverEarnings: money(row.driverEarnings),
      commission: money(row.commission),
    })),
  };
};

/// Per-ride commission breakdown, newest first, paged.
export const listDriverEarningRides = async ({ driverId, range, from, to, page = 1, limit = 20, now = new Date() }) => {
  // Without explicit dates the list defaults to this month, so the endpoint
  // works for "show me my recent trips" without the app computing a range.
  const window = from || to
    ? resolveNamedRange({ range: 'custom', from: from || to, to: to || toIstDayKey(now), now, maxDays: 366 })
    : resolveNamedRange({ range: range || 'month', now });
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);

  const [facet] = await Ride.aggregate([
    { $match: buildMatch(driverId, window.from, window.to) },
    { $sort: { completedAt: -1 } },
    {
      $facet: {
        total: [{ $count: 'count' }],
        rows: [
          { $skip: (safePage - 1) * safeLimit },
          { $limit: safeLimit },
          {
            $project: {
              _id: 1,
              serviceType: 1,
              paymentMethod: 1,
              pickupAddress: 1,
              dropAddress: 1,
              completedAt: 1,
              estimatedDistanceMeters: 1,
              fare: 1,
              commissionAmount: 1,
              driverEarnings: 1,
              'pricingSnapshot.admin_commission_type_from_driver': 1,
              'pricingSnapshot.admin_commission_from_driver': 1,
              'pricingSnapshot.rider_platform_fee': 1,
              'pricingSnapshot.fare_breakdown.tax': 1,
              'promo.code': 1,
              'promo.discount_amount': 1,
              'feedback.tipAmount': 1,
              'intercity.fromCity': 1,
              'intercity.toCity': 1,
            },
          },
        ],
      },
    },
  ]);

  const total = Number(facet?.total?.[0]?.count || 0);
  const results = (facet?.rows || []).map((ride) => {
    const commissionType = Number(ride.pricingSnapshot?.admin_commission_type_from_driver ?? 1);
    return {
      rideId: String(ride._id),
      serviceType: ride.serviceType || 'ride',
      paymentMethod: ride.paymentMethod || 'cash',
      pickupAddress: ride.pickupAddress || '',
      dropAddress: ride.dropAddress || '',
      fromCity: ride.intercity?.fromCity || '',
      toCity: ride.intercity?.toCity || '',
      completedAt: ride.completedAt,
      distanceKm: money(Number(ride.estimatedDistanceMeters || 0) / 1000),
      fare: money(ride.fare),
      commission: {
        // 1 = percentage, 2 = fixed, as everywhere else in Set Price.
        type: commissionType === 2 ? 'fixed' : 'percentage',
        rate: Number(ride.pricingSnapshot?.admin_commission_from_driver ?? 0),
        amount: money(ride.commissionAmount),
      },
      riderPlatformFee: money(ride.pricingSnapshot?.rider_platform_fee),
      tax: money(ride.pricingSnapshot?.fare_breakdown?.tax),
      promoCode: ride.promo?.code || '',
      promoDiscount: money(ride.promo?.discount_amount),
      tip: money(ride.feedback?.tipAmount),
      driverEarnings: money(ride.driverEarnings),
      netEarnings: money(Number(ride.driverEarnings || 0) + Number(ride.feedback?.tipAmount || 0)),
    };
  });

  return {
    from: window.from,
    to: window.to,
    results,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      hasNextPage: safePage * safeLimit < total,
      hasPrevPage: safePage > 1,
    },
  };
};
