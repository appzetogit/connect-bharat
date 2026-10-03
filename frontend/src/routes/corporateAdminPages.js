import { lazy } from 'react';

// Admin pages for corporate accounts, kept out of lazyPages.js so the corporate
// module only adds one import line to adminRoutes.jsx.
export const AdminCorporateList = lazy(() => import('../modules/admin/pages/corporates/CorporateList'));
export const AdminCorporateCreate = lazy(() => import('../modules/admin/pages/corporates/CorporateCreate'));
export const AdminCorporateDetail = lazy(() => import('../modules/admin/pages/corporates/CorporateDetail'));
export const AdminCorporateOutstanding = lazy(() => import('../modules/admin/pages/corporates/CorporateOutstanding'));
