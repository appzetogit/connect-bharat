import { Navigate, Route } from 'react-router-dom';
import {
  HubCounterBooking,
  HubDashboard,
  HubDelivery,
  HubFailed,
  HubInbound,
  HubLayout,
  HubLogin,
  HubManifests,
  HubReports,
  HubScan,
  PublicTrack,
} from './hubLazyPages';

/** Hub panel (parcel network) and the public parcel tracking page. */
const hubRoutes = (
  <>
    <Route path="/hub/login" element={<HubLogin />} />
    <Route path="/hub" element={<HubLayout />}>
      <Route index element={<Navigate to="/hub/dashboard" replace />} />
      <Route path="dashboard" element={<HubDashboard />} />
      <Route path="scan" element={<HubScan />} />
      <Route path="inbound" element={<HubInbound />} />
      <Route path="manifests" element={<HubManifests />} />
      <Route path="delivery" element={<HubDelivery />} />
      <Route path="failed" element={<HubFailed />} />
      <Route path="book" element={<HubCounterBooking />} />
      <Route path="reports" element={<HubReports />} />
    </Route>
    <Route path="/track" element={<PublicTrack />} />
    <Route path="/track/:awb" element={<PublicTrack />} />
  </>
);

export default hubRoutes;
