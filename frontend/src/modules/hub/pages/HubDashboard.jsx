import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hubApi } from '../services/hubApi';
import { useHubLiveUpdates } from '../services/hubSocket';
import { Card, Empty, PageTitle, Stat, StatusBadge } from '../components/ui';
import { formatDateTime } from '../components/format';

const HubDashboard = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    hubApi.dashboard().then(setData).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  // Live: any shipment or manifest change at my hub refreshes the counts.
  useHubLiveUpdates(load);

  if (error) return <p className="text-rose-600 text-sm">{error}</p>;
  if (!data) return <p className="text-slate-400 text-sm">Loading…</p>;

  return (
    <div className="space-y-5">
      <PageTitle title="Dashboard" subtitle={`${data.hub.name} · ${data.hub.code}`} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="On hand" value={data.onHand} hint={data.utilisationPercent != null ? `${data.utilisationPercent}% of capacity` : undefined} />
        <Stat label="Pending outbound" value={data.pendingOutbound} />
        <Stat label="Waiting for delivery" value={data.pendingDelivery} />
        <Stat label="Out for delivery" value={data.outForDelivery} tone="text-violet-700" />
        <Stat label="Pickups pending" value={data.pendingPickups} />
        <Stat label="Driver legs open" value={data.openDriverLegs} />
        <Stat label="Delivered today" value={data.deliveredToday} tone="text-emerald-700" />
        <Stat label="Failed today" value={data.failedToday} tone="text-rose-700" />
      </div>
      <div className="grid lg:grid-cols-2 gap-5">
        <Card title="Expected inbound manifests" right={<Link to="/hub/inbound" className="text-[12px] text-slate-500 hover:text-slate-900">Receive →</Link>}>
          {data.expectedInbound.length ? (
            <ul className="divide-y divide-slate-100 text-[13px]">
              {data.expectedInbound.map((manifest) => (
                <li key={manifest.id} className="py-2 flex justify-between gap-2">
                  <div>
                    <div className="font-mono">{manifest.code}</div>
                    <div className="text-[11px] text-slate-400">from {manifest.fromHub?.code} · dispatched {formatDateTime(manifest.dispatchedAt)}</div>
                  </div>
                  <div className="text-right">
                    <div className="tabular-nums">{manifest.count} parcels</div>
                    <StatusBadge status={manifest.status === 'in_transit' ? 'in_transit' : 'booked'} label={manifest.status} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No manifests on the way.</Empty>
          )}
        </Card>
        <Card title="Parcels at this hub by status">
          {Object.keys(data.countsByStatus).length ? (
            <ul className="space-y-2 text-[13px]">
              {Object.entries(data.countsByStatus).map(([status, count]) => (
                <li key={status} className="flex justify-between">
                  <StatusBadge status={status} />
                  <span className="tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>The hub is empty.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
};

export default HubDashboard;
