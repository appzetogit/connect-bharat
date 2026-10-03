import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { 
  GoogleMap, 
  MarkerF, 
  MarkerClustererF, 
  TrafficLayer, 
  HeatmapLayerF,
  PolylineF
} from '@react-google-maps/api';
import { 
  Search, Filter, Activity, Users, Car, AlertTriangle, IndianRupee, Clock,
  Map as MapIcon, X, Maximize, Minimize, Crosshair, Layers, Flame, Navigation, ArrowLeft, RefreshCw,
  Battery, Gauge, MapPin, Phone, User as UserIcon, ShieldAlert, CheckCircle2, XCircle, History, Loader2
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBaseGoogleMapsLoader, HAS_VALID_GOOGLE_MAPS_KEY } from '../../utils/googleMaps';
import { adminService } from '../../services/adminService';
import { operationsApi, ADMIN_FEED_EVENTS, unwrap } from '../../services/operationsApi';
import { socketService } from '../../../../shared/api/socket';

import CarIcon from '@/assets/icons/car.png';
import BikeIcon from '@/assets/icons/bike.png';
import AutoIcon from '@/assets/icons/auto.png';

const INDIA_CENTER = { lat: 22.7196, lng: 75.8577 };

// While the admin socket is connected, positions arrive live, so polling only
// needs to catch what the socket cannot (new drivers, status, metrics).
const LIVE_MIN_POLL_SECONDS = 60;
const LIFECYCLE_DEBOUNCE_MS = 3000;
const TRAIL_WINDOW_MS = 2 * 60 * 60 * 1000;

const driverKey = (driver) => String(driver?._id || driver?.id || '');

const formatTrailTime = (value) => {
  const d = new Date(value);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const mapOptions = {
  disableDefaultUI: true, // we build our own floating controls
  zoomControl: false,
  streetViewControl: false,
  mapTypeControl: false,
  fullscreenControl: false,
  styles: [
    { elementType: 'geometry', stylers: [{ color: '#f5f5f5' }] },
    { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#f5f5f5' }] },
    { featureType: 'administrative.land_parcel', elementType: 'labels.text.fill', stylers: [{ color: '#bdbdbd' }] },
    { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#eeeeee' }] },
    { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
    { featureType: 'road.arterial', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#dadada' }] },
    { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
    { featureType: 'road.local', elementType: 'labels.text.fill', stylers: [{ color: '#9e9e9e' }] },
    { featureType: 'transit.line', elementType: 'geometry', stylers: [{ color: '#e5e5e5' }] },
    { featureType: 'transit.station', elementType: 'geometry', stylers: [{ color: '#eeeeee' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c9c9c9' }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#9e9e9e' }] }
  ]
};

const getMapIconForVehicle = (iconType = '') => {
  const value = String(iconType || '').trim().toLowerCase();
  if (value.includes('bike')) return BikeIcon;
  if (value.includes('auto')) return AutoIcon;
  return CarIcon;
};

const hasUsableCoordinates = (latitude, longitude) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
};

// Generic white/black/yellow/grey theme classes
const btnClass = "flex items-center justify-center gap-2 px-4 py-2 text-sm font-bold rounded-lg transition-colors border shadow-sm";
const btnPrimary = `${btnClass} bg-yellow-400 text-black border-yellow-500 hover:bg-yellow-500`;
const btnSecondary = `${btnClass} bg-white text-slate-800 border-slate-200 hover:bg-slate-50`;


/// A driver's heading as a compass point, e.g. 44 -> "NE". Null when the driver
/// has not moved since coming online, so nothing is shown rather than a
/// misleading "N".
const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compassFromHeading = (heading) => {
  const degrees = Number(heading);
  if (!Number.isFinite(degrees)) return null;
  return COMPASS_POINTS[Math.round(((degrees % 360) + 360) % 360 / 45) % 8];
};

/// Google Maps cannot rotate an image marker, so the heading is drawn as a
/// separate arrow symbol layered over the vehicle icon.
const headingArrow = (heading) => ({
  path: 'M 0,-9 L 3.2,3 L 0,0.9 L -3.2,3 Z',
  fillColor: '#0F172A',
  fillOpacity: 0.9,
  strokeColor: '#FFFFFF',
  strokeWeight: 1.2,
  scale: 1,
  rotation: Number(heading) || 0,
  anchor: new window.google.maps.Point(0, 0),
});

const GodsEye = () => {
  const navigate = useNavigate();
  const { isLoaded, loadError } = useBaseGoogleMapsLoader();
  const [mapInstance, setMapInstance] = useState(null);

  // Data States
  const [drivers, setDrivers] = useState([]);
  const [rides, setRides] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [dashboardData, setDashboardData] = useState({});
  const [earningsData, setEarningsData] = useState({});
  const [loading, setLoading] = useState(true);
  const [lastSync, setLastSync] = useState(null);

  // Filters State
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState({
    status: 'all', // all, online, offline, busy, idle
    vehicleType: 'all',
    serviceType: 'all',
    city: 'all',
    zone: 'all',
    refreshMode: '30' // seconds, 'manual'
  });

  // Map Controls State
  const [controls, setControls] = useState({
    traffic: false,
    heatmap: false,
    cluster: true,
    autoFollow: false,
    fullscreen: false
  });

  // Selection
  const [selectedDriver, setSelectedDriver] = useState(null);

  // Live feed + trail
  const [socketLive, setSocketLive] = useState(() => socketService.isConnected());
  const [trail, setTrail] = useState(null); // { driverId, points, loading, error, distanceMeters, truncated }
  const [trailIndex, setTrailIndex] = useState(0);
  const [initialCenter, setInitialCenter] = useState(null);

  // Fetch Logic
  const fetchMapData = useCallback(async () => {
    setLoading(true);
    try {
      const [drvRes, ridesRes, alertsRes, dashRes, earnRes] = await Promise.allSettled([
        adminService.getDrivers(1, 1000, {}).catch(() => ({ data: { results: [] }})),
        adminService.getOngoingRides().catch(() => ({ data: { results: [] }})),
        adminService.getSafetyAlerts().catch(() => ({ data: { results: [] }})),
        adminService.getDashboardData().catch(() => ({ data: {} })),
        adminService.getTodayEarnings().catch(() => ({ data: {} }))
      ]);

      const drvList = drvRes.status === 'fulfilled' ? (drvRes.value?.data?.results || drvRes.value?.data || []) : [];
      const ridesList = ridesRes.status === 'fulfilled' ? (ridesRes.value?.data?.results || ridesRes.value?.data || []) : [];
      const alertsList = alertsRes.status === 'fulfilled' ? (alertsRes.value?.data?.results || alertsRes.value?.data || []) : [];
      
      const nextDrivers = Array.isArray(drvList) ? drvList : [];
      setDrivers(nextDrivers);
      // Keep the open drawer in step with the refreshed record.
      setSelectedDriver(prev => {
        if (!prev) return prev;
        return nextDrivers.find(d => driverKey(d) === driverKey(prev)) || prev;
      });
      setRides(Array.isArray(ridesList) ? ridesList : []);
      setAlerts(Array.isArray(alertsList) ? alertsList : []);
      
      if (dashRes.status === 'fulfilled') setDashboardData(dashRes.value?.data || {});
      if (earnRes.status === 'fulfilled') setEarningsData(earnRes.value?.data || {});
      
      setLastSync(new Date());
    } catch (error) {
      console.error('Failed to fetch Gods Eye data', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMapData();
  }, [fetchMapData]);

  useEffect(() => {
    if (filters.refreshMode === 'manual') return;
    const seconds = parseInt(filters.refreshMode, 10);
    if (!isNaN(seconds) && seconds > 0) {
      const effective = socketLive ? Math.max(seconds, LIVE_MIN_POLL_SECONDS) : seconds;
      const interval = setInterval(fetchMapData, effective * 1000);
      return () => clearInterval(interval);
    }
  }, [filters.refreshMode, fetchMapData, socketLive]);

  // Live admin feed: move markers in place, refetch (debounced) on ride lifecycle.
  const fetchMapDataRef = useRef(fetchMapData);
  useEffect(() => { fetchMapDataRef.current = fetchMapData; }, [fetchMapData]);

  useEffect(() => {
    socketService.connect({ role: 'admin' });
    let lifecycleTimer = null;

    const applyLocation = (driver, payload) => ({
      ...driver,
      latitude: Number(payload.lat),
      longitude: Number(payload.lng),
      ...(payload.heading !== null && payload.heading !== undefined && Number.isFinite(Number(payload.heading)) ? { heading: Number(payload.heading) } : {}),
      ...(typeof payload.isOnRide === 'boolean' ? { isOnRide: payload.isOnRide } : {}),
      ...(payload.updatedAt ? { location_updated_at: payload.updatedAt } : {}),
    });

    const onDriverLocation = (payload) => {
      const id = String(payload?.driverId || '');
      if (!id || !hasUsableCoordinates(payload.lat, payload.lng)) return;
      setDrivers(prev => {
        const idx = prev.findIndex(d => driverKey(d) === id);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = applyLocation(prev[idx], payload);
        return next;
      });
      setSelectedDriver(prev => (prev && driverKey(prev) === id ? applyLocation(prev, payload) : prev));
    };

    const onLifecycle = () => {
      if (lifecycleTimer) clearTimeout(lifecycleTimer);
      lifecycleTimer = setTimeout(() => {
        lifecycleTimer = null;
        fetchMapDataRef.current();
      }, LIFECYCLE_DEBOUNCE_MS);
    };

    const onConnect = () => setSocketLive(true);
    const onDisconnect = () => setSocketLive(false);

    socketService.on(ADMIN_FEED_EVENTS.DRIVER_LOCATION, onDriverLocation);
    socketService.on(ADMIN_FEED_EVENTS.RIDE_LIFECYCLE, onLifecycle);
    socketService.on('connect', onConnect);
    socketService.on('disconnect', onDisconnect);
    setSocketLive(socketService.isConnected());

    return () => {
      if (lifecycleTimer) clearTimeout(lifecycleTimer);
      socketService.off(ADMIN_FEED_EVENTS.DRIVER_LOCATION, onDriverLocation);
      socketService.off(ADMIN_FEED_EVENTS.RIDE_LIFECYCLE, onLifecycle);
      socketService.off('connect', onConnect);
      socketService.off('disconnect', onDisconnect);
    };
  }, []);

  // Drop the trail when another driver (or none) is selected.
  const selectedDriverKey = driverKey(selectedDriver);
  useEffect(() => {
    setTrail(prev => (prev && prev.driverId !== selectedDriverKey ? null : prev));
  }, [selectedDriverKey]);

  const loadTrail = async () => {
    const id = selectedDriverKey;
    if (!id) return;
    setTrail({ driverId: id, points: [], loading: true, error: '' });
    setTrailIndex(0);
    try {
      const response = await operationsApi.getDriverLocationHistory(id, {
        from: new Date(Date.now() - TRAIL_WINDOW_MS).toISOString(),
      });
      const data = unwrap(response) || {};
      const points = (Array.isArray(data.points) ? data.points : [])
        .filter(p => hasUsableCoordinates(p?.lat, p?.lng))
        .map(p => ({ lat: Number(p.lat), lng: Number(p.lng), at: p.at }));
      setTrail(prev => (prev && prev.driverId === id ? {
        driverId: id,
        points,
        loading: false,
        error: '',
        distanceMeters: Number(data.distanceMeters) || 0,
        truncated: Boolean(data.truncated),
      } : prev));
      setTrailIndex(points.length > 0 ? points.length - 1 : 0);
      if (mapInstance && points.length > 1 && window.google?.maps) {
        const bounds = new window.google.maps.LatLngBounds();
        points.forEach(p => bounds.extend(p));
        mapInstance.fitBounds(bounds, 60);
      } else if (mapInstance && points.length === 1) {
        mapInstance.panTo(points[0]);
      }
    } catch (err) {
      const message = err?.response?.data?.message || err?.message || 'Failed to load trail';
      setTrail(prev => (prev && prev.driverId === id ? { driverId: id, points: [], loading: false, error: message } : prev));
    }
  };

  const clearTrail = () => {
    setTrail(null);
    setTrailIndex(0);
  };

  const trailPoints = useMemo(() => trail?.points || [], [trail]);
  const trailCursor = trailPoints.length > 0 ? trailPoints[Math.min(trailIndex, trailPoints.length - 1)] : null;
  const trailTraversed = useMemo(
    () => trailPoints.slice(0, Math.min(trailIndex, trailPoints.length - 1) + 1),
    [trailPoints, trailIndex],
  );

  // Handle Fullscreen
  useEffect(() => {
    const handleFullscreenChange = () => {
      setControls(prev => ({ ...prev, fullscreen: !!document.fullscreenElement }));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => console.error(err));
    } else {
      document.exitFullscreen();
    }
  };

  // Derived Data
  const filteredDrivers = useMemo(() => {
    return drivers.filter(d => {
      if (!hasUsableCoordinates(d.latitude, d.longitude)) return false;
      
      // Search
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const match = 
          String(d.name || '').toLowerCase().includes(q) ||
          String(d.phone || '').toLowerCase().includes(q) ||
          String(d.vehicle_number || '').toLowerCase().includes(q);
        if (!match) return false;
      }

      // Status
      if (filters.status !== 'all') {
        const isOnline = Boolean(d.isOnline);
        const isBusy = Boolean(d.isOnRide);
        if (filters.status === 'online' && !isOnline) return false;
        if (filters.status === 'offline' && isOnline) return false;
        if (filters.status === 'busy' && !isBusy) return false;
        if (filters.status === 'idle' && (!isOnline || isBusy)) return false;
      }

      // Vehicle Type
      if (filters.vehicleType !== 'all') {
        const vt = String(d.vehicle_icon_type || d.vehicle_type || d.transport_type || '').toLowerCase();
        if (!vt.includes(filters.vehicleType)) return false;
      }

      // Service Type, City, Zone (Assuming fields exist, simplified matching)
      if (filters.city !== 'all' && d.city !== filters.city) return false;
      if (filters.zone !== 'all' && d.zone_name !== filters.zone) return false;

      return true;
    });
  }, [drivers, filters, searchQuery]);

  // Timelines
  const timelineEvents = useMemo(() => {
    const events = [];
    rides.forEach(r => {
      if (r.createdAt) {
        events.push({ id: `r-${r._id}`, time: new Date(r.createdAt), type: 'Trip Started', desc: `Trip ${r._id?.slice(-4)} started.`, icon: <Activity size={14}/>, color: 'text-yellow-600' });
      }
    });
    alerts.forEach(a => {
      if (a.createdAt) {
        events.push({ id: `a-${a._id}`, time: new Date(a.createdAt), type: 'SOS Alert', desc: `Emergency alert from ${a.user?.name || 'User'}`, icon: <AlertTriangle size={14}/>, color: 'text-red-500' });
      }
    });
    return events.sort((a, b) => b.time - a.time).slice(0, 50); // Most recent 50
  }, [rides, alerts]);

  // Metrics (Derived or from dashboardData)
  const metrics = {
    online: drivers.filter(d => d.isOnline).length,
    offline: drivers.filter(d => !d.isOnline).length,
    busy: drivers.filter(d => d.isOnRide).length,
    idle: drivers.filter(d => d.isOnline && !d.isOnRide).length,
    liveTrips: rides.length,
    sos: alerts.filter(a => a.status === 'active').length,
    revenue: earningsData?.today || 0,
    tripsToday: dashboardData?.totalTripsToday || 0
  };

  const handleMarkerClick = useCallback((driver) => {
    setSelectedDriver(driver);
    if (mapInstance && controls.autoFollow) {
      mapInstance.panTo({ lat: Number(driver.latitude), lng: Number(driver.longitude) });
    }
  }, [mapInstance, controls.autoFollow]);

  const recenterMap = () => {
    if (mapInstance && filteredDrivers.length > 0) {
      mapInstance.panTo({ lat: Number(filteredDrivers[0].latitude), lng: Number(filteredDrivers[0].longitude) });
      mapInstance.setZoom(12);
    }
  };

  // The map's center prop is set once (first driver seen); a fresh object each
  // render would snap the map back on every live position update.
  useEffect(() => {
    if (!initialCenter && filteredDrivers.length > 0) {
      setInitialCenter({ lat: Number(filteredDrivers[0].latitude), lng: Number(filteredDrivers[0].longitude) });
    }
  }, [filteredDrivers, initialCenter]);

  const selectedLat = selectedDriver ? Number(selectedDriver.latitude) : null;
  const selectedLng = selectedDriver ? Number(selectedDriver.longitude) : null;
  useEffect(() => {
    if (!mapInstance || !controls.autoFollow || !hasUsableCoordinates(selectedLat, selectedLng)) return;
    mapInstance.panTo({ lat: selectedLat, lng: selectedLng });
  }, [mapInstance, controls.autoFollow, selectedLat, selectedLng]);

  const mapCenter = initialCenter || INDIA_CENTER;

  return (
    <div className={`flex flex-col h-screen bg-gray-50 font-sans ${controls.fullscreen ? 'fixed inset-0 z-50' : ''}`}>
      
      {/* TOP NAVIGATION / KPI STRIP */}
      <div className="bg-white border-b border-gray-200 px-3 py-1.5 flex items-center justify-between shadow-sm z-10 flex-shrink-0">
        <div className="flex items-center gap-3">
           {!controls.fullscreen && (
             <button onClick={() => navigate('/admin/dashboard')} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg">
                <ArrowLeft size={18} />
             </button>
           )}
           <div>
             <h1 className="text-base font-bold text-gray-900">God's Eye Dashboard</h1>
             <p className="text-xs font-semibold text-gray-500 flex items-center gap-1.5">
                <span
                  title={socketLive ? 'Receiving live driver positions' : 'Live feed unavailable, using polling'}
                  className={`inline-block w-1.5 h-1.5 rounded-full ${socketLive ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`}
                />
                Live Fleet Monitoring {lastSync && ` • Synced ${lastSync.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}`}
             </p>
           </div>
        </div>

        {/* Dynamic Metrics Strip */}
        <div className="hidden lg:flex items-center gap-4">
           <div className="flex flex-col items-end">
              <span className="text-[9px] font-bold text-gray-500 uppercase">Online</span>
              <span className="text-xs font-black text-black">{metrics.online}</span>
           </div>
           <div className="flex flex-col items-end">
              <span className="text-[9px] font-bold text-gray-500 uppercase">Busy / Idle</span>
              <span className="text-xs font-black text-black"><span className="text-yellow-600">{metrics.busy}</span> / {metrics.idle}</span>
           </div>
           <div className="flex flex-col items-end">
              <span className="text-[9px] font-bold text-gray-500 uppercase">Live Trips</span>
              <span className="text-xs font-black text-black">{metrics.liveTrips}</span>
           </div>
           <div className="flex flex-col items-end">
              <span className="text-[9px] font-bold text-gray-500 uppercase">SOS Alerts</span>
              <span className={`text-xs font-black ${metrics.sos > 0 ? 'text-red-500 animate-pulse' : 'text-black'}`}>{metrics.sos}</span>
           </div>
           <div className="flex flex-col items-end">
              <span className="text-[9px] font-bold text-gray-500 uppercase">Revenue (Today)</span>
              <span className="text-xs font-black text-black">₹{metrics.revenue.toLocaleString()}</span>
           </div>
        </div>
      </div>

      {/* MAIN CONTENT SPLIT */}
      <div className="flex flex-1 overflow-hidden relative">
         
         {/* LEFT SIDEBAR - FILTERS */}
         <div className="w-56 bg-white border-r border-gray-200 p-3 flex flex-col gap-3 overflow-y-auto z-10 flex-shrink-0">
            {/* Search */}
            <div className="relative">
               <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
               <input 
                 type="text" 
                 placeholder="Search driver..." 
                 value={searchQuery}
                 onChange={(e) => setSearchQuery(e.target.value)}
                 className="w-full pl-8 pr-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 outline-none transition-all placeholder:text-gray-400 text-black font-medium"
               />
            </div>

            <hr className="border-gray-100" />

            {/* Filter Group */}
            <div className="space-y-3">
               <div>
                  <label className="block text-xs font-semibold capitalize text-gray-500 mb-1">Driver Status</label>
                  <select 
                    value={filters.status} 
                    onChange={e => setFilters(prev => ({...prev, status: e.target.value}))}
                    className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-black outline-none focus:border-yellow-400"
                  >
                     <option value="all">All Drivers</option>
                     <option value="online">Online Only</option>
                     <option value="offline">Offline Only</option>
                     <option value="busy">Busy (On Trip)</option>
                     <option value="idle">Idle (Waiting)</option>
                  </select>
               </div>
               
               <div>
                  <label className="block text-xs font-semibold capitalize text-gray-500 mb-1">Vehicle Type</label>
                  <select 
                    value={filters.vehicleType} 
                    onChange={e => setFilters(prev => ({...prev, vehicleType: e.target.value}))}
                    className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-black outline-none focus:border-yellow-400"
                  >
                     <option value="all">All Types</option>
                     <option value="car">Car (Taxi)</option>
                     <option value="bike">Bike</option>
                     <option value="auto">Auto</option>
                  </select>
               </div>

               <div>
                  <label className="block text-xs font-semibold capitalize text-gray-500 mb-1">Refresh Mode</label>
                  <select 
                    value={filters.refreshMode} 
                    onChange={e => setFilters(prev => ({...prev, refreshMode: e.target.value}))}
                    className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-black outline-none focus:border-yellow-400"
                  >
                     <option value="15">Every 15s</option>
                     <option value="30">Every 30s</option>
                     <option value="60">Every 1m</option>
                     <option value="300">Every 5m</option>
                     <option value="manual">Manual</option>
                  </select>
               </div>
            </div>

            <div className="mt-auto space-y-2 pt-4">
               <button onClick={fetchMapData} className={btnPrimary + " w-full"}>
                  <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                  Force Refresh
               </button>
               <button onClick={() => setFilters({ status: 'all', vehicleType: 'all', serviceType: 'all', city: 'all', zone: 'all', refreshMode: '30' })} className={btnSecondary + " w-full"}>
                  Reset Filters
               </button>
            </div>
         </div>

         {/* MAP CANVAS */}
         <div className="flex-1 relative bg-gray-200 flex flex-col">
            
            {/* FLOATING MAP CONTROLS */}
            <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
               <button 
                  onClick={() => setControls(c => ({...c, cluster: !c.cluster}))}
                  className={`p-2.5 rounded-lg shadow-md transition-colors ${controls.cluster ? 'bg-yellow-400 text-black' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  title="Toggle Clustering"
               >
                  <Layers size={18} />
               </button>
               <button 
                  onClick={() => setControls(c => ({...c, traffic: !c.traffic}))}
                  className={`p-2.5 rounded-lg shadow-md transition-colors ${controls.traffic ? 'bg-yellow-400 text-black' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  title="Traffic Layer"
               >
                  <Navigation size={18} />
               </button>
               <button 
                  onClick={() => setControls(c => ({...c, heatmap: !c.heatmap}))}
                  className={`p-2.5 rounded-lg shadow-md transition-colors ${controls.heatmap ? 'bg-yellow-400 text-black' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  title="Heatmap Layer"
               >
                  <Flame size={18} />
               </button>
               <button 
                  onClick={() => setControls(c => ({...c, autoFollow: !c.autoFollow}))}
                  className={`p-2.5 rounded-lg shadow-md transition-colors ${controls.autoFollow ? 'bg-yellow-400 text-black' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  title="Auto Follow Selected"
               >
                  <Crosshair size={18} />
               </button>
            </div>

            <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
               <button 
                  onClick={toggleFullscreen}
                  className="p-2.5 bg-white text-gray-600 hover:bg-gray-50 rounded-lg shadow-md transition-colors"
                  title="Toggle Fullscreen"
               >
                  {controls.fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
               </button>
               <button 
                  onClick={recenterMap}
                  className="p-2.5 bg-white text-gray-600 hover:bg-gray-50 rounded-lg shadow-md transition-colors"
                  title="Recenter Map"
               >
                  <MapPin size={18} />
               </button>
            </div>

            {/* Google Map */}
            <div className="flex-1 w-full h-full relative">
               {loadError ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-50 text-red-500 font-bold uppercase tracking-widest text-sm">Map Load Error</div>
               ) : HAS_VALID_GOOGLE_MAPS_KEY && isLoaded ? (
                  <GoogleMap
                     mapContainerStyle={{ width: '100%', height: '100%' }} 
                     center={mapCenter} 
                     zoom={12} 
                     options={mapOptions}
                     onLoad={setMapInstance}
                     onClick={() => setSelectedDriver(null)}
                  >
                     {controls.traffic && <TrafficLayer />}
                     
                     {controls.heatmap && (
                        <HeatmapLayerF 
                           data={filteredDrivers.map(d => new window.google.maps.LatLng(Number(d.latitude), Number(d.longitude)))}
                           options={{ radius: 40, opacity: 0.6 }}
                        />
                     )}

                     {!controls.heatmap && controls.cluster ? (
                        <MarkerClustererF options={{ maxZoom: 15, styles: [{ width: 40, height: 40, textColor: 'white', textSize: 14, url: 'https://developers.google.com/maps/documentation/javascript/examples/markerclusterer/m1.png' }] }}>
                           {(clusterer) => (
                              <>
                                 {filteredDrivers.map(driver => (
                                    <React.Fragment key={driver._id || driver.id}>
                                       <MarkerF
                                             position={{ lat: Number(driver.latitude), lng: Number(driver.longitude) }}
                                             onClick={() => handleMarkerClick(driver)}
                                             clusterer={clusterer}
                                             icon={{
                                                url: getMapIconForVehicle(driver.vehicle_icon_type || driver.vehicle_type),
                                                scaledSize: new window.google.maps.Size(32, 32),
                                                anchor: new window.google.maps.Point(16, 16),
                                             }}
                                       />
                                       {Number.isFinite(Number(driver.heading)) && (
                                          <MarkerF
                                             position={{ lat: Number(driver.latitude), lng: Number(driver.longitude) }}
                                             clickable={false}
                                             icon={headingArrow(driver.heading)}
                                             zIndex={999}
                                          />
                                       )}
                                    </React.Fragment>
                                 ))}
                              </>
                           )}
                        </MarkerClustererF>
                     ) : !controls.heatmap && !controls.cluster ? (
                        filteredDrivers.map(driver => (
                           <MarkerF 
                              key={driver._id || driver.id} 
                              position={{ lat: Number(driver.latitude), lng: Number(driver.longitude) }}
                              onClick={() => handleMarkerClick(driver)}
                              icon={{
                                 url: getMapIconForVehicle(driver.vehicle_icon_type || driver.vehicle_type),
                                 scaledSize: new window.google.maps.Size(32, 32),
                                 anchor: new window.google.maps.Point(16, 16),
                              }}
                           />
                        ))
                     ) : null}

                     {trailPoints.length > 1 && (
                        <>
                           <PolylineF
                              path={trailPoints}
                              options={{ strokeColor: '#0F172A', strokeOpacity: 0.55, strokeWeight: 4, clickable: false, zIndex: 50 }}
                           />
                           <PolylineF
                              path={trailTraversed}
                              options={{ strokeColor: '#EAB308', strokeOpacity: 0.95, strokeWeight: 5, clickable: false, zIndex: 51 }}
                           />
                        </>
                     )}
                     {trailCursor && (
                        <MarkerF
                           position={{ lat: trailCursor.lat, lng: trailCursor.lng }}
                           clickable={false}
                           zIndex={1000}
                           icon={{
                              path: window.google.maps.SymbolPath.CIRCLE,
                              scale: 7,
                              fillColor: '#FACC15',
                              fillOpacity: 1,
                              strokeColor: '#0F172A',
                              strokeWeight: 2,
                           }}
                        />
                     )}

                  </GoogleMap>
               ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-50">
                     <MapIcon size={48} className="text-gray-300 mb-4" />
                     <p className="text-xs font-black text-gray-400 uppercase tracking-[0.2em]">Map Offline</p>
                  </div>
               )}

               {/* Empty State Overlay */}
               {filteredDrivers.length === 0 && !loading && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                     <div className="bg-white/90 backdrop-blur-sm px-6 py-4 rounded-2xl shadow-xl border border-gray-200 flex flex-col items-center text-center max-w-sm">
                        <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center text-gray-400 mb-3">
                           <Car size={24} />
                        </div>
                        <h3 className="text-base font-black text-black mb-1">No live fleet available</h3>
                        <p className="text-xs text-gray-500 font-medium">Waiting for GPS updates or adjust your filters.</p>
                     </div>
                  </div>
               )}
            </div>

            {/* BOTTOM TIMELINE */}
            <div className="h-36 bg-white border-t border-gray-200 flex flex-col flex-shrink-0 z-10">
               <div className="px-3 py-1.5 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
                  <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Real-Time Event Timeline</h3>
                  <span className="text-[10px] font-bold text-gray-400">{timelineEvents.length} Recent Events</span>
               </div>
               <div className="flex-1 overflow-x-auto overflow-y-auto whitespace-nowrap p-3 flex items-start gap-3">
                  {timelineEvents.length === 0 ? (
                     <div className="flex w-full h-full items-center justify-center text-[10px] text-gray-400 font-medium">No recent events logged.</div>
                  ) : (
                     timelineEvents.map(evt => (
                        <div key={evt.id} className="inline-flex flex-col min-w-[180px] bg-gray-50 border border-gray-100 rounded-lg p-2 shadow-sm">
                           <div className="flex items-center gap-2 mb-2">
                              <div className={`p-1.5 bg-white rounded-lg shadow-sm ${evt.color}`}>
                                 {evt.icon}
                              </div>
                              <div>
                                 <p className="text-xs font-black text-black">{evt.type}</p>
                                 <p className="text-[9px] text-gray-500 font-bold">{evt.time.toLocaleTimeString()}</p>
                              </div>
                           </div>
                           <p className="text-[10px] text-gray-600 font-medium whitespace-normal leading-tight">{evt.desc}</p>
                        </div>
                     ))
                  )}
               </div>
            </div>

         </div>

         {/* RIGHT DRAWER - SELECTED MARKER */}
         {selectedDriver && (
            <div className="w-72 bg-white border-l border-gray-200 flex flex-col z-20 shadow-2xl flex-shrink-0 absolute right-0 top-0 bottom-0 lg:relative slide-in-from-right animate-in duration-300">
               {/* Drawer Header */}
               <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between bg-yellow-400 text-black">
                  <h2 className="text-xs font-black uppercase tracking-wider">Driver Telemetry</h2>
                  <button onClick={() => setSelectedDriver(null)} className="p-1 hover:bg-yellow-500 rounded-md transition-colors">
                     <X size={16} />
                  </button>
               </div>

               <div className="flex-1 overflow-y-auto p-3 space-y-4">
                  
                  {/* Driver Profile Summary */}
                  <div className="flex items-center gap-3">
                     <div className="w-14 h-14 bg-gray-100 rounded-full border-2 border-gray-200 overflow-hidden flex items-center justify-center text-gray-400 flex-shrink-0">
                        {selectedDriver.profile_image ? (
                           <img src={selectedDriver.profile_image} alt={selectedDriver.name} className="w-full h-full object-cover" />
                        ) : (
                           <UserIcon size={24} />
                        )}
                     </div>
                     <div>
                        <h3 className="text-base font-black text-black leading-tight">{selectedDriver.name || 'Unknown Driver'}</h3>
                        <p className="text-xs text-gray-500 font-medium">{selectedDriver.phone || 'No Phone'}</p>
                        {compassFromHeading(selectedDriver.heading) && (
                           <p className="text-xs text-gray-600 font-semibold mt-0.5">
                              Heading {compassFromHeading(selectedDriver.heading)} &middot; {Math.round(Number(selectedDriver.heading))}&deg;
                           </p>
                        )}
                        <div className="flex items-center gap-1 mt-1">
                           {selectedDriver.isOnline ? (
                              <><CheckCircle2 size={12} className="text-green-500" /><span className="text-[10px] font-bold text-green-600">ONLINE</span></>
                           ) : (
                              <><XCircle size={12} className="text-gray-400" /><span className="text-[10px] font-bold text-gray-500">OFFLINE</span></>
                           )}
                           {selectedDriver.isOnRide && <span className="text-[10px] font-bold text-yellow-600 ml-1">• ON TRIP</span>}
                        </div>
                     </div>
                  </div>

                  <hr className="border-gray-100" />

                  {/* Vehicle Info */}
                  <div className="space-y-2">
                     <h4 className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Vehicle Information</h4>
                     <div className="bg-gray-50 rounded-lg p-2.5 flex flex-col gap-1.5 border border-gray-100">
                        <div className="flex justify-between items-center">
                           <span className="text-xs text-gray-500 font-medium">Model</span>
                           <span className="text-xs font-black text-black">{selectedDriver.vehicle_model || selectedDriver.vehicle_type || 'N/A'}</span>
                        </div>
                        <div className="flex justify-between items-center">
                           <span className="text-xs text-gray-500 font-medium">Number Plate</span>
                           <span className="text-xs font-black text-black bg-yellow-100 px-1.5 py-0.5 rounded">{selectedDriver.vehicle_number || 'N/A'}</span>
                        </div>
                        <div className="flex justify-between items-center">
                           <span className="text-xs text-gray-500 font-medium">City / Zone</span>
                           <span className="text-xs font-bold text-gray-700">{selectedDriver.city || selectedDriver.service_location_name || 'N/A'}</span>
                        </div>
                     </div>
                  </div>

                  {/* Telemetry Stats */}
                  <div className="space-y-2">
                     <h4 className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Live Telemetry</h4>
                     <div className="grid grid-cols-2 gap-2">
                        <div className="bg-white border border-gray-200 rounded-lg p-2.5 flex items-center gap-2 shadow-sm">
                           <div className="text-gray-400"><Gauge size={16} /></div>
                           <div>
                              <p className="text-[9px] font-bold text-gray-400 uppercase">Speed</p>
                              <p className="text-sm font-black text-black">{selectedDriver.speed || '0'} <span className="text-[10px]">km/h</span></p>
                           </div>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-lg p-2.5 flex items-center gap-2 shadow-sm">
                           <div className="text-gray-400"><Navigation size={16} /></div>
                           <div>
                              <p className="text-[9px] font-bold text-gray-400 uppercase">Heading</p>
                              <p className="text-sm font-black text-black">{selectedDriver.heading || 'N/A'}°</p>
                           </div>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-lg p-2.5 flex items-center gap-2 shadow-sm">
                           <div className="text-gray-400"><MapPin size={16} /></div>
                           <div>
                              <p className="text-[9px] font-bold text-gray-400 uppercase">Accuracy</p>
                              <p className="text-sm font-black text-black">± {selectedDriver.accuracy || '5'}m</p>
                           </div>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-lg p-2.5 flex items-center gap-2 shadow-sm">
                           <div className="text-gray-400"><Battery size={16} /></div>
                           <div>
                              <p className="text-[9px] font-bold text-gray-400 uppercase">Battery</p>
                              <p className="text-sm font-black text-black">{selectedDriver.battery || 'N/A'}</p>
                           </div>
                        </div>
                     </div>
                  </div>

                  {/* Location Trail */}
                  <div className="space-y-2">
                     <h4 className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Location Trail</h4>
                     {!trail ? (
                        <button onClick={loadTrail} className={btnSecondary + " w-full"}>
                           <History size={14} /> Show trail (last 2h)
                        </button>
                     ) : trail.loading ? (
                        <div className="flex items-center justify-center gap-2 py-3 text-xs font-bold text-gray-500">
                           <Loader2 size={14} className="animate-spin text-yellow-500" /> Loading trail...
                        </div>
                     ) : trail.error ? (
                        <div className="bg-red-50 border border-red-100 rounded-lg p-2.5 text-xs font-semibold text-red-600 space-y-2">
                           <p>{trail.error}</p>
                           <div className="flex gap-2">
                              <button onClick={loadTrail} className="px-2 py-1 bg-red-100 text-red-700 rounded text-[10px] font-bold hover:bg-red-200">Retry</button>
                              <button onClick={clearTrail} className="px-2 py-1 bg-white text-gray-700 border border-gray-200 rounded text-[10px] font-bold hover:bg-gray-50">Dismiss</button>
                           </div>
                        </div>
                     ) : trailPoints.length === 0 ? (
                        <div className="bg-gray-50 border border-gray-100 rounded-lg p-2.5 text-xs font-medium text-gray-500 space-y-2">
                           <p>No location points recorded in the last 2 hours.</p>
                           <button onClick={clearTrail} className="px-2 py-1 bg-white text-gray-700 border border-gray-200 rounded text-[10px] font-bold hover:bg-gray-50">Dismiss</button>
                        </div>
                     ) : (
                        <div className="bg-gray-50 border border-gray-100 rounded-lg p-2.5 space-y-2">
                           <div className="flex justify-between items-center text-[10px] font-bold text-gray-500">
                              <span>{trailPoints.length} points</span>
                              {trail.distanceMeters > 0 && <span>{(trail.distanceMeters / 1000).toFixed(1)} km</span>}
                           </div>
                           <input
                              type="range"
                              min={0}
                              max={Math.max(trailPoints.length - 1, 0)}
                              value={Math.min(trailIndex, trailPoints.length - 1)}
                              onChange={e => setTrailIndex(Number(e.target.value))}
                              className="w-full accent-yellow-400"
                           />
                           <div className="flex justify-between items-center text-[10px] font-semibold text-gray-400">
                              <span>{formatTrailTime(trailPoints[0]?.at)}</span>
                              <span className="text-xs font-black text-black">{formatTrailTime(trailCursor?.at)}</span>
                              <span>{formatTrailTime(trailPoints[trailPoints.length - 1]?.at)}</span>
                           </div>
                           {trail.truncated && (
                              <p className="text-[10px] font-medium text-yellow-700">Trail truncated to the first 20,000 points.</p>
                           )}
                           <button onClick={clearTrail} className={btnSecondary + " w-full !py-1.5 !text-xs"}>
                              <X size={12} /> Clear trail
                           </button>
                        </div>
                     )}
                  </div>

                  {/* Trip Info if on trip */}
                  {selectedDriver.isOnRide && (
                     <div className="space-y-2">
                        <h4 className="text-[9px] font-bold text-gray-400 uppercase tracking-widest text-yellow-600">Active Trip</h4>
                        <div className="bg-yellow-50 rounded-lg p-2.5 flex flex-col gap-1.5 border border-yellow-100">
                           <div className="flex justify-between items-center">
                              <span className="text-xs text-yellow-700 font-medium">Passenger</span>
                              <span className="text-xs font-black text-black">{selectedDriver.passenger_name || 'N/A'}</span>
                           </div>
                           <div className="flex justify-between items-center">
                              <span className="text-xs text-yellow-700 font-medium">Started</span>
                              <span className="text-xs font-black text-black">Just now</span>
                           </div>
                        </div>
                     </div>
                  )}
               </div>

               {/* Drawer Footer Actions */}
               <div className="p-3 border-t border-gray-100 bg-gray-50 flex flex-col gap-2 mt-auto">
                  <button className={btnPrimary + " w-full"}>
                     <Search size={14} /> Locate Vehicle
                  </button>
                  <button onClick={() => navigate(`/admin/owner-management/manage-owners/${selectedDriver._id || selectedDriver.id}`)} className={btnSecondary + " w-full"}>
                     <UserIcon size={14} /> View Driver Profile
                  </button>
               </div>
            </div>
         )}
      </div>
    </div>
  );
};

export default GodsEye;
