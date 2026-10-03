import { lazy } from 'react';

/** Lazy pages for the hub panel and the admin parcel-network screens. */
export const HubLayout = lazy(() => import('../modules/hub/components/HubLayout'));
export const HubLogin = lazy(() => import('../modules/hub/pages/HubLogin'));
export const HubDashboard = lazy(() => import('../modules/hub/pages/HubDashboard'));
export const HubScan = lazy(() => import('../modules/hub/pages/HubScan'));
export const HubInbound = lazy(() => import('../modules/hub/pages/HubInbound'));
export const HubManifests = lazy(() => import('../modules/hub/pages/HubManifests'));
export const HubDelivery = lazy(() => import('../modules/hub/pages/HubDelivery'));
export const HubFailed = lazy(() => import('../modules/hub/pages/HubFailed'));
export const HubCounterBooking = lazy(() => import('../modules/hub/pages/HubCounterBooking'));
export const HubReports = lazy(() => import('../modules/hub/pages/HubReports'));
export const PublicTrack = lazy(() => import('../modules/hub/pages/PublicTrack'));

export const LogisticsHubs = lazy(() => import('../modules/admin/pages/logistics/LogisticsHubs'));
export const LogisticsRateCards = lazy(() => import('../modules/admin/pages/logistics/LogisticsRateCards'));
export const LogisticsShipments = lazy(() => import('../modules/admin/pages/logistics/LogisticsShipments'));
export const LogisticsPerformance = lazy(() => import('../modules/admin/pages/logistics/LogisticsPerformance'));
export const LogisticsSettings = lazy(() => import('../modules/admin/pages/logistics/LogisticsSettings'));
