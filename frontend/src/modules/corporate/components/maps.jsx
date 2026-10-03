import { useEffect, useRef, useState } from 'react';
import { Autocomplete, CircleF, GoogleMap, MarkerF } from '@react-google-maps/api';
import { Loader2, Search } from 'lucide-react';
import { INDIA_CENTER, useAppGoogleMapsLoader } from '../../admin/utils/googleMaps';
import { inputClass } from './ui';
import { MAPS_AVAILABLE, hasPoint } from './helpers';

/**
 * Google Maps pieces shared by the corporate panel and the admin corporate
 * pages. The loader hook is only called inside components that mount when a
 * Maps key is configured, so without a key nothing tries to load the script
 * and callers fall back to plain address + lat/lng inputs.
 */

/** Places search box. Calls onPick({ address, lat, lng }). */
function PlaceSearchBox({ onPick, placeholder }) {
  const { isLoaded, loadError } = useAppGoogleMapsLoader();
  const [autocomplete, setAutocomplete] = useState(null);

  if (loadError) return null;
  if (!isLoaded) return <div className="text-xs text-gray-400 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Loading maps…</div>;

  const handlePlace = () => {
    const place = autocomplete?.getPlace?.();
    const location = place?.geometry?.location;
    if (!location) return;
    onPick({
      address: place.formatted_address || place.name || '',
      lat: Number(location.lat().toFixed(6)),
      lng: Number(location.lng().toFixed(6)),
    });
  };

  return (
    <Autocomplete onLoad={setAutocomplete} onPlaceChanged={handlePlace} options={{ componentRestrictions: { country: 'in' } }}>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input type="text" placeholder={placeholder || 'Search a place'} className={`${inputClass} pl-8`} />
      </div>
    </Autocomplete>
  );
}

/**
 * Address with coordinates. With a Maps key: a Places search that fills all
 * three; the address and coordinates stay editable either way.
 * value = { address, lat, lng }
 */
export function LocationInput({ label, value, onChange, disabled = false, placeholder }) {
  const current = value || { address: '', lat: '', lng: '' };
  const set = (patch) => onChange({ ...current, ...patch });
  return (
    <div className="space-y-2">
      {label && <span className="block text-xs font-medium text-gray-600">{label}</span>}
      {MAPS_AVAILABLE && !disabled && <PlaceSearchBox placeholder={placeholder} onPick={(place) => onChange(place)} />}
      <input className={inputClass} disabled={disabled} placeholder="Address" value={current.address || ''} onChange={(e) => set({ address: e.target.value })} />
      <div className="grid grid-cols-2 gap-2">
        <input className={inputClass} disabled={disabled} type="number" step="any" placeholder="Latitude" value={current.lat ?? ''} onChange={(e) => set({ lat: e.target.value })} />
        <input className={inputClass} disabled={disabled} type="number" step="any" placeholder="Longitude" value={current.lng ?? ''} onChange={(e) => set({ lng: e.target.value })} />
      </div>
    </div>
  );
}

function OfficeCirclesMap({ offices, selectedIndex, onMapClick, height }) {
  const { isLoaded, loadError } = useAppGoogleMapsLoader();
  const mapRef = useRef(null);
  const points = offices.filter(hasPoint);
  const pointsKey = points.map((office) => `${office.lat},${office.lng},${office.radiusKm}`).join('|');

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoaded || !points.length || !window.google?.maps) return;
    const bounds = new window.google.maps.LatLngBounds();
    points.forEach((office) => {
      const circle = new window.google.maps.Circle({ center: { lat: Number(office.lat), lng: Number(office.lng) }, radius: Math.max(0.1, Number(office.radiusKm) || 0) * 1000 });
      const circleBounds = circle.getBounds();
      if (circleBounds) bounds.union(circleBounds);
    });
    map.fitBounds(bounds);
    // Refit only when the circles themselves change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, pointsKey]);

  if (loadError) return <p className="text-xs text-red-600">Google Maps could not load. Use the coordinates fields.</p>;
  if (!isLoaded) return <div className="flex items-center justify-center bg-gray-50 rounded-lg" style={{ height }}><Loader2 className="animate-spin text-gray-300" /></div>;

  return (
    <div className="rounded-lg overflow-hidden border border-gray-200" style={{ height }}>
      <GoogleMap
        mapContainerStyle={{ width: '100%', height: '100%' }}
        center={points[0] ? { lat: Number(points[0].lat), lng: Number(points[0].lng) } : INDIA_CENTER}
        zoom={points.length ? 12 : 5}
        onLoad={(map) => { mapRef.current = map; }}
        onClick={(event) => onMapClick?.({ lat: Number(event.latLng.lat().toFixed(6)), lng: Number(event.latLng.lng().toFixed(6)) })}
        options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false }}
      >
        {offices.map((office, index) => (hasPoint(office) ? (
          <CircleF
            key={`circle-${index}`}
            center={{ lat: Number(office.lat), lng: Number(office.lng) }}
            radius={Math.max(0, Number(office.radiusKm) || 0) * 1000}
            options={{
              clickable: false,
              fillColor: index === selectedIndex ? '#111827' : '#2563eb',
              fillOpacity: 0.08,
              strokeColor: index === selectedIndex ? '#111827' : '#2563eb',
              strokeOpacity: 0.6,
              strokeWeight: 2,
            }}
          />
        ) : null))}
        {offices.map((office, index) => (hasPoint(office) ? (
          <MarkerF key={`marker-${index}`} position={{ lat: Number(office.lat), lng: Number(office.lng) }} label={String(index + 1)} title={office.name} />
        ) : null))}
      </GoogleMap>
    </div>
  );
}

/** Map with a circle per office; renders nothing without a Maps key. */
export function OfficesMap({ offices, selectedIndex = -1, onMapClick, height = 320 }) {
  if (!MAPS_AVAILABLE) return null;
  return <OfficeCirclesMap offices={offices} selectedIndex={selectedIndex} onMapClick={onMapClick} height={height} />;
}
