import { LedgerEntry } from '../models/LedgerEntry.js';
import { Payout } from '../models/Payout.js';
import { Refund } from '../models/Refund.js';

/// Settlement and payout reports (gap 2.15) read from the ledger.
///
/// Each transfer has exactly one credit line, so summing credit lines per
/// category counts every movement once. Sums use `amountMinor` (paise) to
/// avoid float drift and are converted back to rupees at the end.

const REPORT_TIMEZONE = 'Asia/Kolkata';
const HEADLINE_CATEGORIES = ['gateway_collection', 'wallet_topup', 'refund', 'payout', 'commission', 'withdrawal', 'corporate_charge'];

const toRupees = (paise) => Math.round(Number(paise || 0)) / 100;

const resolveRange = ({ from, to } = {}) => {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return resolveRange({});
  }
  return { start, end };
};

export const getPaymentSummaryReport = async (query = {}) => {
  const { start, end } = resolveRange(query);
  const match = { createdAt: { $gte: start, $lte: end }, direction: 'credit' };
  if (query.service) match.service = String(query.service).toLowerCase();

  const [byCategory, byDay, byService, refundStatus, payoutStatus] = await Promise.all([
    LedgerEntry.aggregate([
      { $match: match },
      { $group: { _id: '$category', amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
    LedgerEntry.aggregate([
      { $match: { ...match, category: { $in: HEADLINE_CATEGORIES } } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: REPORT_TIMEZONE } },
            category: '$category',
          },
          amountMinor: { $sum: '$amountMinor' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.day': 1 } },
    ]),
    LedgerEntry.aggregate([
      { $match: match },
      {
        $group: {
          _id: { service: { $ifNull: ['$service', ''] }, category: '$category' },
          amountMinor: { $sum: '$amountMinor' },
          count: { $sum: 1 },
        },
      },
    ]),
    Refund.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$status', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payout.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$status', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);

  const totals = Object.fromEntries(
    byCategory.map((row) => [row._id, { amount: toRupees(row.amountMinor), count: row.count }]),
  );

  const dayMap = new Map();
  for (const row of byDay) {
    const day = row._id.day;
    if (!dayMap.has(day)) {
      dayMap.set(day, Object.fromEntries([['date', day], ...HEADLINE_CATEGORIES.map((category) => [category, 0])]));
    }
    dayMap.get(day)[row._id.category] = toRupees(row.amountMinor);
  }

  const serviceMap = new Map();
  for (const row of byService) {
    const service = row._id.service || 'unassigned';
    if (!serviceMap.has(service)) serviceMap.set(service, { service, categories: {} });
    serviceMap.get(service).categories[row._id.category] = { amount: toRupees(row.amountMinor), count: row.count };
  }

  const pick = (category) => totals[category] || { amount: 0, count: 0 };

  return {
    range: { from: start, to: end, timezone: REPORT_TIMEZONE },
    headline: {
      gateway_collections: pick('gateway_collection'),
      wallet_topups: pick('wallet_topup'),
      refunds: pick('refund'),
      payouts: pick('payout'),
      commission: pick('commission'),
      withdrawals: pick('withdrawal'),
      corporate_charges: pick('corporate_charge'),
    },
    byCategory: totals,
    byDay: [...dayMap.values()],
    byService: [...serviceMap.values()],
    refunds: Object.fromEntries(refundStatus.map((row) => [row._id, { amount: Math.round(row.amount * 100) / 100, count: row.count }])),
    payouts: Object.fromEntries(payoutStatus.map((row) => [row._id, { amount: Math.round(row.amount * 100) / 100, count: row.count }])),
  };
};
