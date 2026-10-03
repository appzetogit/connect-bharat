import { Routes } from 'react-router-dom';
import adminRoutes from './adminRoutes';
import driverRoutes from './driverRoutes';
import hubRoutes from './hubRoutes';
import ownerRoutes from './ownerRoutes';
import publicRoutes from './publicRoutes';
import userRoutes from './userRoutes';
import corporateRoutes from './corporateRoutes';

const AppRoutes = () => (
  <Routes>
    {corporateRoutes}
    {publicRoutes}
    {userRoutes}
    {driverRoutes}
    {ownerRoutes}
    {adminRoutes}
    {hubRoutes}
  </Routes>
);

export default AppRoutes;
