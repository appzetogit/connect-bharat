import { ApiError } from '../../../utils/ApiError.js';

/**
 * Date-range parsing shared by ride history and driver earnings.
 *
 * Pure on purpose (no models, no env) so it can be unit tested without Mongo.
 *
 * The apps send either a plain calendar date ("2026-10-03") or a full ISO
 * timestamp. A plain date is read as an India calendar day, because that is
 * the day the rider or driver sees on their phone: `from` is the start of that
 * IST day and `to` is the *end* of it, so "to=2026-10-03" includes trips taken
 * on the evening of the 3rd. Reading it as UTC midnight would silently drop
 * the last 5.5 hours of the day.
 */

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/// Start of the IST calendar day `YYYY-MM-DD`, as a UTC instant.
export const istDayStart = (dayKey) => new Date(Date.parse(`${dayKey}T00:00:00.000Z`) - IST_OFFSET_MS);

/// IST calendar day key (`YYYY-MM-DD`) for an instant.
export const toIstDayKey = (value = new Date()) =>
  new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const parseBoundary = (value, { endOfDay = false, field }) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const raw = String(value).trim();

  if (DATE_ONLY.test(raw)) {
    const start = istDayStart(raw);
    if (Number.isNaN(start.getTime())) {
      throw new ApiError(400, `${field} must be a valid date (YYYY-MM-DD or ISO timestamp)`);
    }
    return endOfDay ? new Date(start.getTime() + DAY_MS - 1) : start;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, `${field} must be a valid date (YYYY-MM-DD or ISO timestamp)`);
  }
  return parsed;
};

/**
 * `{ from, to }` as Dates (either may be null), or throws a 400.
 */
export const parseDateRange = ({ from, to } = {}) => {
  const fromDate = parseBoundary(from, { field: 'from' });
  const toDate = parseBoundary(to, { field: 'to', endOfDay: true });

  if (fromDate && toDate && fromDate > toDate) {
    throw new ApiError(400, 'from must be on or before to');
  }

  return { from: fromDate, to: toDate };
};

/**
 * A Mongo `{ $gte, $lte }` condition for the range, or null when neither end
 * was given — so callers can skip the filter entirely and keep the old query.
 */
export const buildDateRangeCondition = ({ from, to } = {}) => {
  const range = parseDateRange({ from, to });
  if (!range.from && !range.to) {
    return null;
  }

  const condition = {};
  if (range.from) condition.$gte = range.from;
  if (range.to) condition.$lte = range.to;
  return condition;
};

/// Every IST day key from `from` to `to` inclusive. Used to zero-fill daily
/// buckets so a chart gets a bar for a day with no trips.
export const listIstDayKeys = (from, to) => {
  const keys = [];
  if (!from || !to) return keys;

  let cursor = istDayStart(toIstDayKey(from)).getTime();
  const end = new Date(to).getTime();
  while (cursor <= end && keys.length < 400) {
    keys.push(toIstDayKey(new Date(cursor)));
    cursor += DAY_MS;
  }
  return keys;
};

/**
 * Resolves an earnings range keyword to concrete IST boundaries.
 *
 *   day    - today
 *   week   - this calendar week, Monday to today
 *   month  - this calendar month, 1st to today
 *   custom - `from`/`to` from the query, capped at `maxDays`
 */
export const resolveNamedRange = ({ range = 'day', from, to, now = new Date(), maxDays = 92 } = {}) => {
  const keyword = String(range || 'day').trim().toLowerCase();
  const todayKey = toIstDayKey(now);
  const todayStart = istDayStart(todayKey);
  const todayEnd = new Date(todayStart.getTime() + DAY_MS - 1);

  if (keyword === 'day' || keyword === 'today') {
    return { range: 'day', from: todayStart, to: todayEnd };
  }

  if (keyword === 'week') {
    // getUTCDay on the shifted instant gives the IST weekday (0 = Sunday).
    const istWeekday = new Date(todayStart.getTime() + IST_OFFSET_MS).getUTCDay();
    const daysSinceMonday = (istWeekday + 6) % 7;
    return { range: 'week', from: new Date(todayStart.getTime() - daysSinceMonday * DAY_MS), to: todayEnd };
  }

  if (keyword === 'month') {
    return { range: 'month', from: istDayStart(`${todayKey.slice(0, 7)}-01`), to: todayEnd };
  }

  if (keyword === 'custom') {
    const parsed = parseDateRange({ from, to });
    if (!parsed.from || !parsed.to) {
      throw new ApiError(400, 'from and to are required when range=custom');
    }
    if (parsed.to.getTime() - parsed.from.getTime() > maxDays * DAY_MS) {
      throw new ApiError(400, `A custom range can cover at most ${maxDays} days`);
    }
    return { range: 'custom', from: parsed.from, to: parsed.to };
  }

  throw new ApiError(400, 'range must be one of day, week, month, custom');
};
