import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { hubApi } from '../services/hubApi';
import { useHubLiveUpdates } from '../services/hubSocket';
import ScanInput from '../components/ScanInput';
import { Button, Card, Empty, Field, PageTitle, ShipmentTable, StatusBadge } from '../components/ui';
import { formatDateTime, inputClass } from '../components/format';

/**
 * Outbound manifests: create one for a destination hub, scan parcels into it
 * (or out of it), seal, dispatch. Dispatch moves every parcel in transit at
 * once and refuses if any of them cannot go.
 */
const ManifestEditor = ({ manifestId, onChanged }) => {
  const [manifest, setManifest] = useState(null);
  const [removeMode, setRemoveMode] = useState(false);
  const [sealNumber, setSealNumber] = useState('');
  const [vehicle, setVehicle] = useState({ number: '', type: '' });
  const [driver, setDriver] = useState({ name: '', phone: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    hubApi.manifest(manifestId).then(setManifest).catch((error) => toast.error(error.message));
  }, [manifestId]);
  useEffect(load, [load]);

  const act = async (fn, success) => {
    setBusy(true);
    try {
      const result = await fn();
      const next = result?.manifest || result;
      if (next?.id) setManifest(next);
      else load();
      result?.warnings?.forEach((warning) => toast(warning, { icon: '⚠️' }));
      if (success) toast.success(success);
      onChanged?.();
    } catch (error) {
      const blocked = error.details?.blocked;
      toast.error(blocked ? `${error.message}: ${blocked.map((row) => `${row.awb} (${row.reason})`).join(', ')}` : error.message);
    } finally {
      setBusy(false);
    }
  };

  if (!manifest) return <p className="text-slate-400 text-sm">Loading…</p>;
  const editable = manifest.status === 'created' && !manifest.sealedAt;

  return (
    <Card
      title={<span className="font-mono">{manifest.code}</span>}
      right={<StatusBadge status={manifest.status === 'created' ? 'booked' : 'in_transit'} label={manifest.status} />}
    >
      <p className="text-[13px] text-slate-500 mb-3">
        To {manifest.toHub?.code} · {manifest.toHub?.name} · {manifest.count} parcels
        {manifest.sealNumber && ` · seal ${manifest.sealNumber}`}
      </p>
      {editable && (
        <div className="space-y-2 mb-4">
          <label className="flex items-center gap-2 text-[12px] text-slate-600">
            <input type="checkbox" checked={removeMode} onChange={(event) => setRemoveMode(event.target.checked)} /> Scanning removes parcels
          </label>
          <ScanInput
            placeholder={removeMode ? 'Scan to REMOVE from manifest' : 'Scan to ADD to manifest'}
            onScan={(awb) => act(() => (removeMode ? hubApi.manifestRemove(manifest.id, awb) : hubApi.manifestAdd(manifest.id, awb)))}
          />
        </div>
      )}
      <ShipmentTable rows={(manifest.shipments || []).map((row) => ({ ...row, statusUpdatedAt: null }))} />
      {manifest.status === 'created' && (
        <div className="grid md:grid-cols-2 gap-4 mt-4">
          <div className="space-y-2">
            <Field label="Seal number">
              <input className={inputClass} value={sealNumber || manifest.sealNumber} onChange={(event) => setSealNumber(event.target.value)} disabled={Boolean(manifest.sealedAt)} />
            </Field>
            {!manifest.sealedAt && <Button variant="secondary" loading={busy} onClick={() => act(() => hubApi.manifestSeal(manifest.id, sealNumber), 'Sealed')}>Seal</Button>}
          </div>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Vehicle number"><input className={inputClass} value={vehicle.number} onChange={(event) => setVehicle({ ...vehicle, number: event.target.value })} /></Field>
              <Field label="Vehicle type"><input className={inputClass} value={vehicle.type} onChange={(event) => setVehicle({ ...vehicle, type: event.target.value })} placeholder="van, truck…" /></Field>
              <Field label="Driver name"><input className={inputClass} value={driver.name} onChange={(event) => setDriver({ ...driver, name: event.target.value })} /></Field>
              <Field label="Driver phone"><input className={inputClass} value={driver.phone} onChange={(event) => setDriver({ ...driver, phone: event.target.value })} /></Field>
            </div>
            <Button loading={busy} onClick={() => act(() => hubApi.manifestDispatch(manifest.id, { vehicle, driver }), 'Dispatched')}>Dispatch</Button>
          </div>
        </div>
      )}
      {manifest.status === 'dispatched' && (
        <Button className="mt-4" variant="secondary" loading={busy} onClick={() => act(() => hubApi.manifestInTransit(manifest.id), 'Marked in transit')}>Mark in transit</Button>
      )}
    </Card>
  );
};

const HubManifests = () => {
  const [manifests, setManifests] = useState([]);
  const [hubs, setHubs] = useState([]);
  const [toHubId, setToHubId] = useState('');
  const [selected, setSelected] = useState('');
  const [outbound, setOutbound] = useState([]);

  const load = useCallback(() => {
    hubApi.manifests({ direction: 'outbound' }).then((data) => setManifests(data?.results || [])).catch((error) => toast.error(error.message));
    hubApi.shipments({ view: 'outbound', limit: 200 }).then((data) => setOutbound(data?.results || [])).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    hubApi.hubDirectory().then((data) => setHubs(data?.results || [])).catch(() => {});
  }, [load]);
  useHubLiveUpdates(load);

  const create = async () => {
    try {
      const manifest = await hubApi.createManifest({ toHubId });
      setSelected(manifest.id);
      load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="space-y-5">
      <PageTitle
        title="Manifests"
        subtitle="Group parcels for another hub, seal the bag, dispatch."
        right={
          <div className="flex gap-2">
            <select className={inputClass} value={toHubId} onChange={(event) => setToHubId(event.target.value)}>
              <option value="">Destination hub…</option>
              {hubs.map((hub) => <option key={hub.id} value={hub.id}>{hub.code} · {hub.name}</option>)}
            </select>
            <Button onClick={create} disabled={!toHubId}>New manifest</Button>
          </div>
        }
      />
      <div className="grid lg:grid-cols-[320px_1fr] gap-5 items-start">
        <Card title="Outbound manifests">
          {manifests.length ? (
            <ul className="divide-y divide-slate-100 text-[13px] -my-2">
              {manifests.map((manifest) => (
                <li key={manifest.id}>
                  <button type="button" onClick={() => setSelected(manifest.id)} className={`w-full text-left py-2 ${selected === manifest.id ? 'text-slate-900' : 'text-slate-600'}`}>
                    <div className="font-mono">{manifest.code}</div>
                    <div className="text-[11px] text-slate-400">to {manifest.toHub?.code} · {manifest.count} · {manifest.status} · {formatDateTime(manifest.createdAt)}</div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No manifests yet.</Empty>
          )}
        </Card>
        <div className="space-y-5">
          {selected ? <ManifestEditor key={selected} manifestId={selected} onChanged={load} /> : null}
          <Card title={`Waiting to leave this hub (${outbound.length})`}>
            <ShipmentTable rows={outbound} />
          </Card>
        </div>
      </div>
    </div>
  );
};

export default HubManifests;
