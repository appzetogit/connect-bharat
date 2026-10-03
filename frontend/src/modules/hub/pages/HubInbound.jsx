import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { hubApi } from '../services/hubApi';
import { useHubLiveUpdates } from '../services/hubSocket';
import AssignLegModal from '../components/AssignLegModal';
import ScanInput from '../components/ScanInput';
import ShipmentDetail from '../components/ShipmentDetail';
import { Button, Card, Empty, Field, Modal, PageTitle, ShipmentTable, StatusBadge } from '../components/ui';
import { formatDateTime, inputClass } from '../components/format';

/**
 * Inbound: manifests arriving from other hubs (receive + reconcile), and
 * parcels coming from senders (assign a pickup driver, then inbound-scan
 * them on the Scan screen when they arrive).
 */
const ReceiveManifest = ({ manifest, onClose, onDone }) => {
  const [scanned, setScanned] = useState([]);
  const [sealNumber, setSealNumber] = useState('');
  const [sealIntact, setSealIntact] = useState(true);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const expected = new Set((manifest.shipments || []).map((item) => item.awb));

  const submit = async () => {
    setLoading(true);
    try {
      const response = await hubApi.manifestReceive(manifest.id, { awbs: scanned, sealNumber: sealNumber || undefined, sealIntact });
      setResult(response);
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open title={`Receive ${manifest.code}`} onClose={onClose} footer={!result && <Button onClick={submit} loading={loading}>Receive & reconcile</Button>}>
      {result ? (
        <div className="space-y-2 text-[13px]">
          <p>Received {result.manifest.receivedCount} of {result.manifest.count}.</p>
          {result.discrepancies.length ? (
            <ul className="space-y-1">
              {result.discrepancies.map((item, index) => (
                <li key={index} className="text-amber-800 bg-amber-50 rounded px-2 py-1">{item.type.replace('_', ' ')}: {item.awb || ''} {item.note}</li>
              ))}
            </ul>
          ) : (
            <p className="text-emerald-700">No discrepancies.</p>
          )}
          {result.results.filter((row) => !row.ok).map((row) => <p key={row.awb} className="text-rose-700">{row.awb}: {row.error}</p>)}
        </div>
      ) : (
        <>
          <p className="text-[13px] text-slate-500">From {manifest.fromHub?.code} · {manifest.count} parcels · seal {manifest.sealNumber || '—'}</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Seal number on arrival"><input className={inputClass} value={sealNumber} onChange={(event) => setSealNumber(event.target.value)} /></Field>
            <label className="flex items-center gap-2 text-[13px] mt-5"><input type="checkbox" checked={sealIntact} onChange={(event) => setSealIntact(event.target.checked)} /> Seal intact</label>
          </div>
          <ScanInput onScan={(awb) => setScanned((list) => (list.includes(awb) ? list : [...list, awb]))} />
          <ul className="text-[12px] font-mono grid grid-cols-2 gap-1">
            {(manifest.shipments || []).map((item) => (
              <li key={item.awb} className={item.received || scanned.includes(item.awb) ? 'text-emerald-700' : 'text-slate-400'}>
                {item.received || scanned.includes(item.awb) ? '✓' : '○'} {item.awb}
              </li>
            ))}
            {scanned.filter((awb) => !expected.has(awb)).map((awb) => <li key={awb} className="text-amber-700">+ {awb} (extra)</li>)}
          </ul>
        </>
      )}
    </Modal>
  );
};

const HubInbound = () => {
  const [manifests, setManifests] = useState([]);
  const [pickups, setPickups] = useState([]);
  const [receiving, setReceiving] = useState(null);
  const [assigning, setAssigning] = useState(null);
  const [open, setOpen] = useState('');

  const load = useCallback(() => {
    hubApi.manifests({ direction: 'inbound' }).then((data) => setManifests(data?.results || [])).catch((error) => toast.error(error.message));
    hubApi.shipments({ view: 'pickups', limit: 100 }).then((data) => setPickups(data?.results || [])).catch(() => {});
  }, []);

  useEffect(load, [load]);
  useHubLiveUpdates(load);

  const openReceive = async (manifest) => {
    try {
      setReceiving(await hubApi.manifest(manifest.id));
    } catch (error) {
      toast.error(error.message);
    }
  };

  const closeManifest = async (manifest) => {
    try {
      await hubApi.manifestClose(manifest.id);
      toast.success('Manifest closed');
      load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="space-y-5">
      <PageTitle title="Inbound" subtitle="Receive manifests from other hubs and bring in parcels from senders." />
      <Card title="Inbound manifests">
        {manifests.length ? (
          <ul className="divide-y divide-slate-100 text-[13px]">
            {manifests.map((manifest) => (
              <li key={manifest.id} className="py-2 flex items-center justify-between gap-3">
                <div>
                  <div className="font-mono">{manifest.code}</div>
                  <div className="text-[11px] text-slate-400">from {manifest.fromHub?.code} · {manifest.count} parcels · dispatched {formatDateTime(manifest.dispatchedAt)}</div>
                  {manifest.discrepancies?.filter((item) => !item.resolved).length > 0 && (
                    <div className="text-[11px] text-amber-700">{manifest.discrepancies.filter((item) => !item.resolved).length} open discrepancies</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={manifest.status === 'received' ? 'received_at_destination_hub' : 'in_transit'} label={manifest.status} />
                  {['dispatched', 'in_transit'].includes(manifest.status) && <Button onClick={() => openReceive(manifest)}>Receive</Button>}
                  {manifest.status === 'received' && <Button variant="secondary" onClick={() => closeManifest(manifest)}>Close</Button>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No inbound manifests.</Empty>
        )}
      </Card>
      <Card title="Pickups from senders">
        <ShipmentTable
          rows={pickups}
          onOpen={(row) => setOpen(row.awb)}
          actions={(row) =>
            row.status === 'booked' && row.pickupMode === 'pickup' ? (
              <Button variant="secondary" onClick={() => setAssigning(row)}>Assign pickup</Button>
            ) : null
          }
        />
      </Card>
      {receiving && <ReceiveManifest manifest={receiving} onClose={() => setReceiving(null)} onDone={load} />}
      {assigning && <AssignLegModal shipment={assigning} legType="first_mile" onClose={() => setAssigning(null)} onDone={load} />}
      <ShipmentDetail awb={open} onClose={() => setOpen('')} />
    </div>
  );
};

export default HubInbound;
