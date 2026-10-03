import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { hubApi } from '../services/hubApi';
import { StatusBadge } from '../components/ui';
import { formatDateTime, inputClass } from '../components/format';

/**
 * Public tracking page for a receiver or sender with only the AWB (the label
 * QR and the SMS can link here; set logistics.tracking_base_url to
 * https://<site>/track). Names and phones arrive masked from the API.
 */
const PublicTrack = () => {
  const { awb: routeAwb = '' } = useParams();
  const navigate = useNavigate();
  const [awb, setAwb] = useState(routeAwb);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!routeAwb) return undefined;
    let cancelled = false;
    const load = () =>
      hubApi
        .track(routeAwb)
        .then((result) => !cancelled && (setData(result), setError('')))
        .catch((err) => !cancelled && (setData(null), setError(err.message)));
    load();
    // Refresh while a driver is moving the parcel.
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [routeAwb]);

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="max-w-md mx-auto space-y-4">
        <h1 className="text-lg font-semibold text-slate-900 pt-4">Track your parcel</h1>
        <form onSubmit={(event) => { event.preventDefault(); navigate(`/track/${awb.trim().toUpperCase()}`); }} className="flex gap-2">
          <input className={`${inputClass} font-mono`} value={awb} onChange={(event) => setAwb(event.target.value)} placeholder="AWB number" />
          <button type="submit" className="px-4 rounded-lg bg-slate-900 text-white text-[13px]">Track</button>
        </form>
        {error && <p className="text-[13px] text-rose-600">{error}</p>}
        {data && (
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[13px]">{data.awb}</span>
              <StatusBadge status={data.status} label={data.displayStatus} />
            </div>
            <div className="text-[13px] text-slate-600">
              {data.sender?.address || data.originHub?.name} → {data.receiver?.address || data.destinationHub?.name}
              <div className="text-[12px] text-slate-400">To {data.receiver?.name}</div>
              {data.slaDueAt && data.status !== 'delivered' && <div className="text-[12px] text-slate-500 mt-1">Expected by {formatDateTime(data.slaDueAt)}</div>}
            </div>
            {data.liveLocation && (
              <a
                className="block text-[13px] text-sky-700 underline"
                href={`https://www.google.com/maps?q=${data.liveLocation.coordinates[1]},${data.liveLocation.coordinates[0]}`}
                target="_blank"
                rel="noreferrer"
              >
                {data.liveLocation.driverFirstName || 'Driver'} is on the way · see on map
              </a>
            )}
            <ol className="space-y-3 border-l border-slate-200 pl-4">
              {[...(data.timeline || [])].reverse().map((event, index) => (
                <li key={index} className="relative">
                  <span className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full bg-slate-400" />
                  <div className="text-[13px] text-slate-800">{event.displayStatus}{event.hub ? ` · ${event.hub.name}` : ''}</div>
                  <div className="text-[11px] text-slate-400">{formatDateTime(event.at)}</div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
};

export default PublicTrack;
