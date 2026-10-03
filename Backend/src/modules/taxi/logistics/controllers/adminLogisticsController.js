import {
  createHub,
  createHubStaff,
  createRateCard,
  deleteHub,
  deleteHubStaff,
  deleteRateCard,
  getHub,
  getShipmentForAdmin,
  listHubStaff,
  listHubs,
  listRateCards,
  searchShipments,
  updateHub,
  updateHubStaff,
  updateRateCard,
} from '../services/adminLogisticsService.js';
import { getHubLeagueTable, getHubPerformance, getHubRevenueReport, revenueReportToCsv } from '../services/hubReportService.js';
import {
  getDeliverySurchargeSettings,
  getLogisticsSettings,
  updateSettingsSection,
} from '../services/logisticsSettingsService.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const hubsList = async (req, res) => ok(res, { results: await listHubs(req.query) });
export const hubGet = async (req, res) => ok(res, await getHub(req.params.id));
export const hubCreate = async (req, res) => ok(res, await createHub(req.body || {}), 201);
export const hubUpdate = async (req, res) => ok(res, await updateHub(req.params.id, req.body || {}));
export const hubDelete = async (req, res) => ok(res, await deleteHub(req.params.id));

export const staffList = async (req, res) => ok(res, { results: await listHubStaff(req.query) });
export const staffCreate = async (req, res) => ok(res, await createHubStaff(req.body || {}), 201);
export const staffUpdate = async (req, res) => ok(res, await updateHubStaff(req.params.id, req.body || {}));
export const staffDelete = async (req, res) => ok(res, await deleteHubStaff(req.params.id));

export const rateCardsList = async (req, res) => ok(res, { results: await listRateCards(req.query) });
export const rateCardCreate = async (req, res) => ok(res, await createRateCard(req.body || {}), 201);
export const rateCardUpdate = async (req, res) => ok(res, await updateRateCard(req.params.id, req.body || {}));
export const rateCardDelete = async (req, res) => ok(res, await deleteRateCard(req.params.id));

export const shipmentsSearch = async (req, res) => ok(res, await searchShipments(req.query));
export const shipmentGet = async (req, res) => ok(res, await getShipmentForAdmin(req.params.awb));

export const leagueTable = async (req, res) => ok(res, { results: await getHubLeagueTable(req.query) });

export const hubPerformance = async (req, res) => {
  const hub = await getHub(req.params.id);
  ok(res, await getHubPerformance({ hub, from: req.query.from, to: req.query.to }));
};

export const hubRevenue = async (req, res) => {
  const hub = await getHub(req.params.id);
  const report = await getHubRevenueReport({ hub, from: req.query.from, to: req.query.to });
  if (String(req.query.format || '').toLowerCase() === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hub-${hub.code}-revenue-${report.from}-to-${report.to}.csv"`);
    res.send(revenueReportToCsv(report));
    return;
  }
  ok(res, report);
};

export const settingsGet = async (_req, res) =>
  ok(res, { logistics: await getLogisticsSettings(), delivery: await getDeliverySurchargeSettings() });

export const settingsUpdate = async (req, res) => {
  const body = req.body || {};
  const [logistics, delivery] = await Promise.all([
    body.logistics ? updateSettingsSection('logistics', body.logistics) : getLogisticsSettings(),
    body.delivery ? updateSettingsSection('delivery', body.delivery) : getDeliverySurchargeSettings(),
  ]);
  ok(res, { logistics, delivery });
};
