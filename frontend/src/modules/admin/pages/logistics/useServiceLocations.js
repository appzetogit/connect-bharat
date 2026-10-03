import { useEffect, useState } from 'react';
import { logisticsAdminService as service, plain } from '../../services/logisticsAdminService';

const listOf = (value) => (Array.isArray(value) ? value : value?.results || value?.data || []);

/** The admin's service locations (cities), for hub and rate-card pickers. */
export const useServiceLocations = () => {
  const [locations, setLocations] = useState([]);
  useEffect(() => {
    service.serviceLocations().then((data) => setLocations(plain(listOf(data)))).catch(() => {});
  }, []);
  return locations;
};
