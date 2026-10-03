import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RIDE_STATUS } from '../../constants/index.js';
import { Driver } from '../../driver/models/Driver.js';
import { toIstDayKey } from '../../driver/services/driverTodaySummaryService.js';
import { BusBooking } from '../../user/models/BusBooking.js';
import { Ride } from '../../user/models/Ride.js';
import { PoolingBooking } from '../models/PoolingBooking.js';
import { RentalBookingRequest } from '../models/RentalBookingRequest.js';
import { ServiceLocation } from '../models/ServiceLocation.js';
import { resolveServiceLocationFilter } from './operationsAccess.js';

/// Dashboard and analytics for the admin panel (SOW 2.1, 2.2, 2.17).
///
/// Everything here is a Mongo aggregation: the old getDashboardData loaded
/// every ride into memory and only counted taxi rides. This covers every
/// service the platform sells - ride, parcel and intercity (all `Ride`),
/// rental (RentalBookingRequest), bus (BusBooking) and pooling
/// (PoolingBooking) - over a date range and optionally one city.
///
/// Days are Indian Standard Time, the same calendar the driver summaries use.

const IST_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

const PAID_COLLECTION_STATUSES = ['paid', 'captured', 'completed'];
const FAILED_COLLECTION_STATUSES = ['failed', 'expired', 'cancelled'];
const RIDE_SERVICE_TYPES = ['ride', 'parcel', 'intercity'];

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/// Percentage to one decimal, or null when there is nothing to divide by - a
/// real "no data" rather than the hardcoded 99.4 the dashboard used to show.
export const computeRate = (numerator, denominator) => {
  const top = Number(numerator) || 0;
  const bottom = Number(denominator) || 0;
  if (bottom <= 0) return null;
  return Math.round((top / bottom) * 1000) / 10;
};

const parseDateInput = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  // A bare YYYY-MM-DD is a calendar day in IST, not UTC midnight.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(new Date(`${raw}T00:00:00.000Z`).getTime() - IST_OFFSET_MS)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `${label} is not a valid date`);
  return date;
};

/// The reporting window. `to` given as a bare date means the end of that IST
/// day. Defaults to the last `defaultDays` days ending now. Pure.
export const resolveReportRange = ({ from, to } = {}, { defaultDays = 30, now = new Date() } = {}) => {
  let end = parseDateInput(to, 'to');
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(String(to).trim())) {
    end = new Date(end.getTime() + DAY_MS - 1);
  }
  end = end || now;
  const start = parseDateInput(from, 'from') || new Date(end.getTime() - defaultDays * DAY_MS);
  if (start > end) throw new ApiError(400, 'from must be before to');
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new ApiError(400, `The range can be at most ${MAX_RANGE_DAYS} days`);
  }
  return { start, end };
};

/// Every IST day between start and end, oldest first, with zeros where the
/// aggregation had no rows - so a chart doesn't silently skip quiet days.
export const fillDailySeries = (rows = [], start, end, emptyRow = () => ({})) => {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const series = [];
  const lastKey = toIstDayKey(end);
  let cursor = new Date(start.getTime());
  for (let guard = 0; guard <= MAX_RANGE_DAYS + 1; guard += 1) {
    const key = toIstDayKey(cursor);
    series.push({ date: key, ...emptyRow(), ...(byDate.get(key) || {}) });
    if (key >= lastKey) break;
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return series;
};

/// Cancellations split by who cancelled. Rows are { _id: role, count }.
/// Rides cancelled before cancelledByRole was recorded land in `unknown`.
export const bucketCancellationActors = (rows = []) => {
  const buckets = { user: 0, driver: 0, admin: 0, system: 0, unknown: 0 };
  for (const row of rows) {
    const key = String(row?._id || '').toLowerCase();
    const count = Number(row?.count || 0);
    if (Object.prototype.hasOwnProperty.call(buckets, key) && key !== 'unknown') {
      buckets[key] += count;
    } else {
      buckets.unknown += count;
    }
  }
  return buckets;
};

/// Combine payment outcomes from several sources into one success rate.
/// Each source is { success, failed }; pending payments are left out because
/// they have not succeeded or failed yet.
export const summarizePaymentOutcomes = (sources = {}) => {
  let success = 0;
  let failed = 0;
  const bySource = {};
  for (const [name, outcome] of Object.entries(sources)) {
    const s = Number(outcome?.success || 0);
    const f = Number(outcome?.failed || 0);
    success += s;
    failed += f;
    bySource[name] = { success: s, failed: f, successRate: computeRate(s, s + f) };
  }
  return { success, failed, successRate: computeRate(success, success + failed), bySource };
};

const toObjectIds = (ids) => (ids || []).map((id) => new mongoose.Types.ObjectId(String(id)));

const emptyServiceBucket = () => ({
  bookings: 0,
  completed: 0,
  cancelled: 0,
  ongoing: 0,
  revenue: 0,
  commission: 0,
});

const istDayExpression = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: IST_TIMEZONE } });

const aggregateRides = async ({ start, end, serviceLocationIds }) => {
  const match = {
    createdAt: { $gte: start, $lte: end },
    ...(serviceLocationIds ? { service_location_id: { $in: toObjectIds(serviceLocationIds) } } : {}),
  };
  const isCompleted = { $eq: ['$status', RIDE_STATUS.COMPLETED] };
  const isCancelled = { $eq: ['$status', RIDE_STATUS.CANCELLED] };
  const fareIfCompleted = { $cond: [isCompleted, { $ifNull: ['$fare', 0] }, 0] };

  const [result] = await Ride.aggregate([
    { $match: match },
    {
      $facet: {
        byService: [
          {
            $group: {
              _id: { $ifNull: ['$serviceType', 'ride'] },
              bookings: { $sum: 1 },
              completed: { $sum: { $cond: [isCompleted, 1, 0] } },
              cancelled: { $sum: { $cond: [isCancelled, 1, 0] } },
              revenue: { $sum: fareIfCompleted },
              commission: { $sum: { $cond: [isCompleted, { $ifNull: ['$commissionAmount', 0] }, 0] } },
            },
          },
        ],
        cancellations: [
          { $match: { status: RIDE_STATUS.CANCELLED } },
          { $group: { _id: { $ifNull: ['$cancelledByRole', ''] }, count: { $sum: 1 } } },
        ],
        acceptance: [
          // Rides still searching have not had their chance yet; scheduled
          // rides waiting for their time are excluded for the same reason.
          { $match: { status: { $ne: RIDE_STATUS.SEARCHING } } },
          {
            $group: {
              _id: null,
              decided: { $sum: 1 },
              accepted: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$acceptedAt', null] }, null] }, 1, 0] } },
              manuallyAssigned: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$assignedBy.adminId', null] }, null] }, 1, 0] } },
            },
          },
        ],
        byCity: [
          {
            $group: {
              _id: '$service_location_id',
              bookings: { $sum: 1 },
              completed: { $sum: { $cond: [isCompleted, 1, 0] } },
              cancelled: { $sum: { $cond: [isCancelled, 1, 0] } },
              revenue: { $sum: fareIfCompleted },
            },
          },
        ],
        daily: [
          {
            $group: {
              _id: istDayExpression('$createdAt'),
              bookings: { $sum: 1 },
              completed: { $sum: { $cond: [isCompleted, 1, 0] } },
              cancelled: { $sum: { $cond: [isCancelled, 1, 0] } },
              revenue: { $sum: fareIfCompleted },
            },
          },
        ],
        payments: [
          { $match: { status: RIDE_STATUS.COMPLETED } },
          {
            $group: {
              _id: {
                $cond: [
                  {
                    $regexMatch: {
                      input: { $ifNull: ['$driverPaymentCollection.source', ''] },
                      regex: 'wallet',
                      options: 'i',
                    },
                  },
                  'wallet',
                  { $ifNull: ['$paymentMethod', 'cash'] },
                ],
              },
              count: { $sum: 1 },
              amount: { $sum: { $ifNull: ['$fare', 0] } },
            },
          },
        ],
        onlineOutcomes: [
          { $match: { paymentMethod: 'online', status: { $in: [RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED] } } },
          {
            $group: {
              _id: null,
              success: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $in: ['$driverPaymentCollection.status', PAID_COLLECTION_STATUSES] },
                        { $ne: [{ $ifNull: ['$driverPaymentCollection.paidAt', null] }, null] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              failed: { $sum: { $cond: [{ $in: ['$driverPaymentCollection.status', FAILED_COLLECTION_STATUSES] }, 1, 0] } },
            },
          },
        ],
      },
    },
  ]);

  return result || {};
};

const aggregateRentals = async ({ start, end, serviceLocationIds }) => {
  const match = {
    createdAt: { $gte: start, $lte: end },
    ...(serviceLocationIds ? { 'serviceLocation.locationId': { $in: serviceLocationIds.map(String) } } : {}),
  };
  const [result] = await RentalBookingRequest.aggregate([
    { $match: match },
    {
      $facet: {
        byStatus: [
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
              revenue: {
                $sum: {
                  $cond: [{ $gt: [{ $ifNull: ['$finalCharge', 0] }, 0] }, '$finalCharge', { $ifNull: ['$totalCost', 0] }],
                },
              },
            },
          },
        ],
        payments: [{ $group: { _id: '$paymentStatus', count: { $sum: 1 } } }],
        daily: [
          {
            $group: {
              _id: istDayExpression('$createdAt'),
              bookings: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
              revenue: {
                $sum: {
                  $cond: [
                    { $eq: ['$status', 'completed'] },
                    { $cond: [{ $gt: [{ $ifNull: ['$finalCharge', 0] }, 0] }, '$finalCharge', { $ifNull: ['$totalCost', 0] }] },
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ]);
  return result || {};
};

const aggregateBus = async ({ start, end }) => {
  const [result] = await BusBooking.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$amount', 0] } } } }],
        daily: [
          {
            $group: {
              _id: istDayExpression('$createdAt'),
              bookings: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
              revenue: { $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, { $ifNull: ['$amount', 0] }, 0] } },
            },
          },
        ],
      },
    },
  ]);
  return result || {};
};

const aggregatePooling = async ({ start, end }) => {
  const [result] = await PoolingBooking.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    {
      $facet: {
        byStatus: [
          {
            $group: {
              _id: { status: '$bookingStatus', payment: '$paymentStatus' },
              count: { $sum: 1 },
              amount: { $sum: { $ifNull: ['$fare', 0] } },
            },
          },
        ],
        daily: [
          {
            $group: {
              _id: istDayExpression('$createdAt'),
              bookings: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'completed'] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'cancelled'] }, 1, 0] } },
              revenue: {
                $sum: {
                  $cond: [
                    { $and: [{ $eq: ['$paymentStatus', 'paid'] }, { $ne: ['$bookingStatus', 'cancelled'] }] },
                    { $ifNull: ['$fare', 0] },
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ]);
  return result || {};
};

const mergeDailyRows = (...lists) => {
  const merged = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const key = row._id;
      const current = merged.get(key) || { date: key, bookings: 0, completed: 0, cancelled: 0, revenue: 0 };
      current.bookings += Number(row.bookings || 0);
      current.completed += Number(row.completed || 0);
      current.cancelled += Number(row.cancelled || 0);
      current.revenue = round2(current.revenue + Number(row.revenue || 0));
      merged.set(key, current);
    }
  }
  return [...merged.values()];
};

export const getDashboardOverview = async ({ query = {}, admin = null } = {}) => {
  const { start, end } = resolveReportRange(query, { defaultDays: 30 });
  const serviceLocationIds = resolveServiceLocationFilter(admin, query.service_location_id);
  // Bus and pooling bookings carry no city, so with a city filter they are
  // left out rather than counted against every city.
  const includeCityless = !serviceLocationIds;

  const [rides, rentals, bus, pooling] = await Promise.all([
    aggregateRides({ start, end, serviceLocationIds }),
    aggregateRentals({ start, end, serviceLocationIds }),
    includeCityless ? aggregateBus({ start, end }) : Promise.resolve(null),
    includeCityless ? aggregatePooling({ start, end }) : Promise.resolve(null),
  ]);

  const services = {};
  for (const type of RIDE_SERVICE_TYPES) services[type] = emptyServiceBucket();
  for (const row of rides.byService || []) {
    const type = RIDE_SERVICE_TYPES.includes(row._id) ? row._id : 'ride';
    const bucket = services[type];
    bucket.bookings += row.bookings;
    bucket.completed += row.completed;
    bucket.cancelled += row.cancelled;
    bucket.revenue = round2(bucket.revenue + row.revenue);
    bucket.commission = round2(bucket.commission + row.commission);
  }
  for (const type of RIDE_SERVICE_TYPES) {
    const bucket = services[type];
    bucket.ongoing = bucket.bookings - bucket.completed - bucket.cancelled;
  }

  const rental = emptyServiceBucket();
  for (const row of rentals.byStatus || []) {
    rental.bookings += row.count;
    if (row._id === 'completed') {
      rental.completed += row.count;
      rental.revenue = round2(rental.revenue + row.revenue);
    } else if (row._id === 'cancelled') {
      rental.cancelled += row.count;
    } else {
      rental.ongoing += row.count;
    }
  }
  services.rental = rental;

  if (bus) {
    const bucket = emptyServiceBucket();
    for (const row of bus.byStatus || []) {
      // pending/expired holds never became bookings; they are not counted.
      if (row._id === 'confirmed') {
        bucket.bookings += row.count;
        bucket.completed += row.count;
        bucket.revenue = round2(bucket.revenue + row.amount);
      } else if (row._id === 'cancelled') {
        bucket.bookings += row.count;
        bucket.cancelled += row.count;
      }
    }
    services.bus = bucket;
  } else {
    services.bus = null;
  }

  if (pooling) {
    const bucket = emptyServiceBucket();
    for (const row of pooling.byStatus || []) {
      const status = row._id?.status;
      const payment = row._id?.payment;
      bucket.bookings += row.count;
      if (status === 'cancelled') bucket.cancelled += row.count;
      else if (status === 'completed') bucket.completed += row.count;
      else bucket.ongoing += row.count;
      if (payment === 'paid' && status !== 'cancelled') bucket.revenue = round2(bucket.revenue + row.amount);
    }
    services.pooling = bucket;
  } else {
    services.pooling = null;
  }

  const totals = Object.values(services).filter(Boolean).reduce(
    (acc, bucket) => ({
      bookings: acc.bookings + bucket.bookings,
      completed: acc.completed + bucket.completed,
      cancelled: acc.cancelled + bucket.cancelled,
      revenue: round2(acc.revenue + bucket.revenue),
      commission: round2(acc.commission + bucket.commission),
    }),
    { bookings: 0, completed: 0, cancelled: 0, revenue: 0, commission: 0 },
  );

  const acceptance = rides.acceptance?.[0] || { decided: 0, accepted: 0, manuallyAssigned: 0 };

  const rentalPayments = Object.fromEntries((rentals.payments || []).map((row) => [row._id, row.count]));
  const busStatuses = Object.fromEntries((bus?.byStatus || []).map((row) => [row._id, row.count]));
  const poolingPayments = (pooling?.byStatus || []).reduce((acc, row) => {
    const key = row._id?.payment || 'pending';
    acc[key] = (acc[key] || 0) + row.count;
    return acc;
  }, {});
  const onlineOutcome = rides.onlineOutcomes?.[0] || { success: 0, failed: 0 };
  const paymentOutcomes = summarizePaymentOutcomes({
    ride: onlineOutcome,
    rental: { success: rentalPayments.paid || 0, failed: rentalPayments.failed || 0 },
    ...(bus ? { bus: { success: busStatuses.confirmed || 0, failed: busStatuses.failed || 0 } } : {}),
    ...(pooling ? { pooling: { success: (poolingPayments.paid || 0) + (poolingPayments.refunded || 0), failed: poolingPayments.failed || 0 } } : {}),
  });

  const byMethod = { cash: { count: 0, amount: 0 }, online: { count: 0, amount: 0 }, wallet: { count: 0, amount: 0 } };
  for (const row of rides.payments || []) {
    const key = Object.prototype.hasOwnProperty.call(byMethod, row._id) ? row._id : 'cash';
    byMethod[key].count += row.count;
    byMethod[key].amount = round2(byMethod[key].amount + row.amount);
  }

  const cityRows = rides.byCity || [];
  const cityIds = cityRows.map((row) => row._id).filter(Boolean);
  const cityDocs = cityIds.length
    ? await ServiceLocation.find({ _id: { $in: cityIds } }).select('name service_location_name').lean()
    : [];
  const cityNames = new Map(cityDocs.map((doc) => [String(doc._id), doc.service_location_name || doc.name || '']));
  const cities = cityRows
    .map((row) => ({
      serviceLocationId: row._id ? String(row._id) : null,
      name: row._id ? cityNames.get(String(row._id)) || 'Unknown' : 'Unassigned',
      bookings: row.bookings,
      completed: row.completed,
      cancelled: row.cancelled,
      revenue: round2(row.revenue),
      completionRate: computeRate(row.completed, row.completed + row.cancelled),
    }))
    .sort((left, right) => right.revenue - left.revenue || right.bookings - left.bookings);

  const daily = fillDailySeries(
    mergeDailyRows(rides.daily, rentals.daily, bus?.daily, pooling?.daily),
    start,
    end,
    () => ({ bookings: 0, completed: 0, cancelled: 0, revenue: 0 }),
  );

  return {
    range: { from: start, to: end, timezone: IST_TIMEZONE },
    serviceLocationIds: serviceLocationIds || null,
    services,
    totals,
    rates: {
      /// Over bookings that have finished (completed or cancelled).
      completionRate: computeRate(totals.completed, totals.completed + totals.cancelled),
      cancellationRate: computeRate(totals.cancelled, totals.completed + totals.cancelled),
      /// Ride/parcel/intercity only: of the rides no longer searching, how
      /// many ever got a driver (accepted by a driver or assigned by an admin).
      acceptanceRate: computeRate(acceptance.accepted, acceptance.decided),
      paymentSuccessRate: paymentOutcomes.successRate,
    },
    acceptance: {
      decided: acceptance.decided,
      accepted: acceptance.accepted,
      manuallyAssigned: acceptance.manuallyAssigned,
    },
    cancellationsByActor: bucketCancellationActors(rides.cancellations),
    payments: {
      byMethod,
      outcomes: paymentOutcomes,
    },
    cities,
    daily,
  };
};

/// Real values for the legacy dashboard's payment tiles (adminService
/// getDashboardData): success rate across online ride payments, rentals,
/// bus and pooling, and the wallet-paid share of completed rides. All-time and
/// today, matching that dashboard's other figures.
export const getDashboardPaymentStats = async ({ startOfToday, endOfToday } = {}) => {
  const todayStart = startOfToday || new Date(new Date().setHours(0, 0, 0, 0));
  const todayEnd = endOfToday || new Date(new Date().setHours(23, 59, 59, 999));
  const walletMatch = {
    status: RIDE_STATUS.COMPLETED,
    'driverPaymentCollection.source': { $regex: 'wallet', $options: 'i' },
  };

  const [rideOutcome, walletRows, rentalRows, busRows, poolingRows] = await Promise.all([
    Ride.aggregate([
      { $match: { paymentMethod: 'online', status: { $in: [RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED] } } },
      {
        $group: {
          _id: null,
          success: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $in: ['$driverPaymentCollection.status', PAID_COLLECTION_STATUSES] },
                    { $ne: [{ $ifNull: ['$driverPaymentCollection.paidAt', null] }, null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          failed: { $sum: { $cond: [{ $in: ['$driverPaymentCollection.status', FAILED_COLLECTION_STATUSES] }, 1, 0] } },
        },
      },
    ]),
    Ride.aggregate([
      { $match: walletMatch },
      {
        $group: {
          _id: null,
          overall: { $sum: { $ifNull: ['$fare', 0] } },
          today: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$completedAt', todayStart] }, { $lte: ['$completedAt', todayEnd] }] },
                { $ifNull: ['$fare', 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
    RentalBookingRequest.aggregate([{ $group: { _id: '$paymentStatus', count: { $sum: 1 } } }]),
    BusBooking.aggregate([{ $match: { status: { $in: ['confirmed', 'failed'] } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    PoolingBooking.aggregate([{ $group: { _id: '$paymentStatus', count: { $sum: 1 } } }]),
  ]);

  const countsOf = (rows) => Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const rental = countsOf(rentalRows);
  const busCounts = countsOf(busRows);
  const poolingCounts = countsOf(poolingRows);
  const outcomes = summarizePaymentOutcomes({
    ride: rideOutcome[0] || { success: 0, failed: 0 },
    rental: { success: rental.paid || 0, failed: rental.failed || 0 },
    bus: { success: busCounts.confirmed || 0, failed: busCounts.failed || 0 },
    pooling: { success: (poolingCounts.paid || 0) + (poolingCounts.refunded || 0), failed: poolingCounts.failed || 0 },
  });

  return {
    successRate: outcomes.successRate,
    outcomes,
    byWallet: {
      overall: round2(walletRows[0]?.overall || 0),
      today: round2(walletRows[0]?.today || 0),
    },
  };
};

/// Utilisation is time on trips over time online, capped at 100% (clock skew
/// between the two sources can push it slightly over). Null when the driver
/// was never online in the window. Pure.
export const computeUtilization = (onTripMinutes, onlineMinutes) => {
  const online = Number(onlineMinutes) || 0;
  if (online <= 0) return null;
  return Math.min(100, Math.round(((Number(onTripMinutes) || 0) / online) * 1000) / 10);
};

/// Online minutes in [startKey, endKey] from the per-day activity log. Today's
/// running total lives in todaySummary until it is rolled into the log, so it
/// is used for today only when the log has no entry for today yet. Pure.
export const sumOnlineMinutes = ({ dailyActivity = [], todaySummary = null, startKey, endKey, todayKey }) => {
  let total = 0;
  let hasToday = false;
  for (const entry of Array.isArray(dailyActivity) ? dailyActivity : []) {
    const key = String(entry?.date || '');
    if (!key || key < startKey || key > endKey) continue;
    if (key === todayKey) hasToday = true;
    total += Number(entry?.activeMinutes || 0);
  }
  if (!hasToday && todayKey >= startKey && todayKey <= endKey && todaySummary?.dateKey === todayKey) {
    total += Number(todaySummary.activeMinutes || 0);
  }
  return Math.round(total);
};

const DRIVER_SORTS = {
  trips: (row) => row.trips,
  earnings: (row) => row.earnings,
  utilization: (row) => row.utilization ?? -1,
  rating: (row) => row.rating,
  online: (row) => row.onlineMinutes,
};

export const getDriverAnalytics = async ({ query = {}, admin = null } = {}) => {
  const { start, end } = resolveReportRange(query, { defaultDays: 7 });
  const serviceLocationIds = resolveServiceLocationFilter(admin, query.service_location_id);
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.page_size) || 50));
  const sortKey = DRIVER_SORTS[query.sort] ? query.sort : 'trips';
  const minOnlineMinutesForBottom = Math.max(0, Number(query.min_online_minutes) || 60);

  const rideStats = await Ride.aggregate([
    {
      $match: {
        driverId: { $ne: null },
        createdAt: { $gte: start, $lte: end },
        ...(serviceLocationIds ? { service_location_id: { $in: toObjectIds(serviceLocationIds) } } : {}),
      },
    },
    {
      $group: {
        _id: '$driverId',
        assigned: { $sum: 1 },
        trips: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.COMPLETED] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.CANCELLED] }, 1, 0] } },
        earnings: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.COMPLETED] }, { $ifNull: ['$driverEarnings', 0] }, 0] } },
        revenue: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.COMPLETED] }, { $ifNull: ['$fare', 0] }, 0] } },
        onTripMs: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', RIDE_STATUS.COMPLETED] },
                  { $ne: [{ $ifNull: ['$completedAt', null] }, null] },
                  { $ne: [{ $ifNull: [{ $ifNull: ['$startedAt', '$acceptedAt'] }, null] }, null] },
                ],
              },
              { $max: [0, { $subtract: ['$completedAt', { $ifNull: ['$startedAt', '$acceptedAt'] }] }] },
              0,
            ],
          },
        },
      },
    },
  ]);

  const startKey = toIstDayKey(start);
  const endKey = toIstDayKey(end);
  const todayKey = toIstDayKey(new Date());

  const drivers = await Driver.aggregate([
    {
      $match: {
        deletedAt: null,
        ...(serviceLocationIds ? { service_location_id: { $in: toObjectIds(serviceLocationIds) } } : {}),
      },
    },
    {
      $project: {
        name: 1,
        phone: 1,
        vehicleType: 1,
        vehicleNumber: 1,
        service_location_id: 1,
        rating: 1,
        ratingCount: 1,
        isOnline: 1,
        todaySummary: 1,
        dailyActivity: {
          $filter: {
            input: { $ifNull: ['$incentiveTracking.dailyActivity', []] },
            as: 'day',
            cond: { $and: [{ $gte: ['$$day.date', startKey] }, { $lte: ['$$day.date', endKey] }] },
          },
        },
      },
    },
  ]);

  const statsByDriver = new Map(rideStats.map((row) => [String(row._id), row]));
  const rows = drivers.map((driver) => {
    const stats = statsByDriver.get(String(driver._id)) || {};
    const onlineMinutes = sumOnlineMinutes({
      dailyActivity: driver.dailyActivity,
      todaySummary: driver.todaySummary,
      startKey,
      endKey,
      todayKey,
    });
    const onTripMinutes = Math.round(Number(stats.onTripMs || 0) / 60000);
    return {
      driverId: String(driver._id),
      name: driver.name || '',
      phone: driver.phone || '',
      vehicleType: driver.vehicleType || '',
      vehicleNumber: driver.vehicleNumber || '',
      serviceLocationId: driver.service_location_id ? String(driver.service_location_id) : null,
      isOnline: Boolean(driver.isOnline),
      rating: Number(driver.ratingCount || 0) > 0 ? Number(driver.rating || 0) : 0,
      ratingCount: Number(driver.ratingCount || 0),
      assigned: Number(stats.assigned || 0),
      trips: Number(stats.trips || 0),
      cancelled: Number(stats.cancelled || 0),
      earnings: round2(stats.earnings || 0),
      revenue: round2(stats.revenue || 0),
      onlineMinutes,
      onTripMinutes,
      utilization: computeUtilization(onTripMinutes, onlineMinutes),
    };
  });

  const active = rows.filter((row) => row.trips > 0 || row.onlineMinutes > 0 || row.assigned > 0);
  const byTrips = [...active].sort((a, b) => b.trips - a.trips || b.earnings - a.earnings);
  const bottom = active
    .filter((row) => row.onlineMinutes >= minOnlineMinutesForBottom)
    .sort((a, b) => (a.utilization ?? 0) - (b.utilization ?? 0) || a.trips - b.trips)
    .slice(0, limit);

  const sorter = DRIVER_SORTS[sortKey];
  const sorted = [...active].sort((a, b) => sorter(b) - sorter(a));

  const totalOnline = active.reduce((sum, row) => sum + row.onlineMinutes, 0);
  const totalOnTrip = active.reduce((sum, row) => sum + row.onTripMinutes, 0);

  return {
    range: { from: start, to: end, timezone: IST_TIMEZONE },
    summary: {
      drivers: rows.length,
      activeDrivers: active.length,
      trips: active.reduce((sum, row) => sum + row.trips, 0),
      earnings: round2(active.reduce((sum, row) => sum + row.earnings, 0)),
      onlineMinutes: totalOnline,
      onTripMinutes: totalOnTrip,
      utilization: computeUtilization(totalOnTrip, totalOnline),
    },
    top: byTrips.slice(0, limit),
    bottom,
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, total: sorted.length, sort: sortKey },
  };
};
