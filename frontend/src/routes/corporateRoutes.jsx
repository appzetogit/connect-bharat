import { lazy } from 'react';
import { Navigate, Route } from 'react-router-dom';

/**
 * Corporate web panel, at /corporate-panel (the /corporate path is the public
 * marketing page). Lazy so none of it ships with the rider app bundle.
 */
const CorporateLayout = lazy(() => import('../modules/corporate/components/CorporateLayout'));
const CorporateLogin = lazy(() => import('../modules/corporate/pages/Login'));
const CorporateRegister = lazy(() => import('../modules/corporate/pages/Login').then((module) => ({ default: module.CorporateRegister })));
const CorporateDashboard = lazy(() => import('../modules/corporate/pages/Dashboard'));
const CorporateEmployees = lazy(() => import('../modules/corporate/pages/Employees'));
const CorporateDepartments = lazy(() => import('../modules/corporate/pages/Departments'));
const CorporatePolicies = lazy(() => import('../modules/corporate/pages/Policies'));
const CorporateApprovals = lazy(() => import('../modules/corporate/pages/Approvals'));
const CorporateTrips = lazy(() => import('../modules/corporate/pages/Trips'));
const CorporateInvoices = lazy(() => import('../modules/corporate/pages/Invoices'));
const CorporateReports = lazy(() => import('../modules/corporate/pages/Reports'));
const CorporateUsers = lazy(() => import('../modules/corporate/pages/Users'));
const CorporateRoles = lazy(() => import('../modules/corporate/pages/Roles'));
const CorporateTravelZone = lazy(() => import('../modules/corporate/pages/TravelZone'));
const CorporateTravelDesk = lazy(() => import('../modules/corporate/pages/TravelDesk'));

const corporateRoutes = (
  <>
    <Route path="/corporate-panel/login" element={<CorporateLogin />} />
    <Route path="/corporate-panel/register" element={<CorporateRegister />} />
    <Route path="/corporate-panel" element={<CorporateLayout />}>
      <Route index element={<Navigate to="/corporate-panel/dashboard" replace />} />
      <Route path="dashboard" element={<CorporateDashboard />} />
      <Route path="employees" element={<CorporateEmployees />} />
      <Route path="departments" element={<CorporateDepartments />} />
      <Route path="policies" element={<CorporatePolicies />} />
      <Route path="approvals" element={<CorporateApprovals />} />
      <Route path="trips" element={<CorporateTrips />} />
      <Route path="invoices" element={<CorporateInvoices />} />
      <Route path="reports" element={<CorporateReports />} />
      <Route path="users" element={<CorporateUsers />} />
      <Route path="roles" element={<CorporateRoles />} />
      <Route path="travel-zone" element={<CorporateTravelZone />} />
      <Route path="travel-desk" element={<CorporateTravelDesk />} />
      <Route path="*" element={<Navigate to="/corporate-panel/dashboard" replace />} />
    </Route>
  </>
);

export default corporateRoutes;
