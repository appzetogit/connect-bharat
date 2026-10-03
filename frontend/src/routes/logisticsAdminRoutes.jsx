import { Navigate, Route } from 'react-router-dom';
import {
  LogisticsHubs,
  LogisticsPerformance,
  LogisticsRateCards,
  LogisticsSettings,
  LogisticsShipments,
} from './hubLazyPages';

/** Child routes of /admin for the hub parcel network admin pages. */
const logisticsAdminRoutes = (
  <>
    <Route path="logistics" element={<Navigate to="/admin/logistics/hubs" replace />} />
    <Route path="logistics/hubs" element={<LogisticsHubs />} />
    <Route path="logistics/rate-cards" element={<LogisticsRateCards />} />
    <Route path="logistics/shipments" element={<LogisticsShipments />} />
    <Route path="logistics/performance" element={<LogisticsPerformance />} />
    <Route path="logistics/settings" element={<LogisticsSettings />} />
  </>
);

export default logisticsAdminRoutes;
