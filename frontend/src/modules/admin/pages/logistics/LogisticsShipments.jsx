import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import AdminPageHeader from '../../components/ui/AdminPageHeader';
import { logisticsAdminService as service, plain } from '../../services/logisticsAdminService';
import { Button, Card, Field, Modal, ShipmentTable, StatusBadge } from '../../../hub/components/ui';
import { formatDateTime, inputClass, money } from '../../../hub/components/format';

/** Admin: search every hub shipment, with its custody timeline. */
const STATUSES = [
  'booked', 'pickup_scheduled', 'picked_up', 'received_at_origin_hub', 'in_transit', 'received_at_destination_hub',
  'out_for_delivery', 'delivered', 'delivery_failed', 'reattempt_scheduled', 'rto_initiated', 'rto_in_transit',
  'rto_delivered', 'cancelled', 'lost', 'damaged',
];

const Detail = ({ awb, onClose }) => {
  const [shipment, setShipment] = useState(null);
  useEffect(() => {
    service.shipment(awb).then((data) => setShipment(plain(data))).catch((error) => toast.error(error.message));
  }, [awb]);
  return (
    <Modal open title={awb} onClose={onClose}>
      {!shipment ? (
        <p className="text-[13px] text-slate-400">Loading…</p>
      ) : (
        <div className="space-y-3 text-[13px]">
          <div className="flex gap-2 items-center"><StatusBadge status={shipment.status} label={shipment.displayStatus} /> {shipment.scope}</div>
          <div>{shipment.sender.name} ({shipment.sender.phone}) → {shipment.receiver.name} ({shipment.receiver.phone})</div>
          <div>{shipment.originHub?.code} → {shipment.destinationHub?.code} · now at {shipment.currentHub?.code || 'in motion'}</div>
          <div>{money(shipment.pricing?.total)} · {shipment.payment?.method} · {shipment.payment?.status}</div>
          <ol className="border-l border-slate-200 pl-4 space-y-2">
            {shipment.timeline.map((event) => (
              <li key={event.id}>
                <span className="font-medium">{event.type.replace(/_/g, ' ')}</span>
                {event.hub && <span className="text-slate-500"> @ {event.hub.code}</span>}
                <span className="text-[11px] text-slate-400"> · {formatDateTime(event.at)} · {event.actorType}</span>
                {event.note && <div className="text-[12px] text-slate-600">{event.note}</div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
};

const LogisticsShipments = () => {
  const [filters, setFilters] = useState({ awb: '', phone: '', status: '', hubId: '', from: '', to: '' });
  const [hubs, setHubs] = useState([]);
  const [result, setResult] = useState({ results: [], total: 0, page: 1 });
  const [open, setOpen] = useState('');

  const search = useCallback(
    (page = 1) => {
      const params = Object.fromEntries(Object.entries({ ...filters, page }).filter(([, value]) => value));
      service.shipments(params).then((data) => setResult(plain(data))).catch((error) => toast.error(error.message));
    },
    [filters],
  );

  useEffect(() => {
    service.hubs().then((data) => setHubs(plain(data?.results || []))).catch(() => {});
    search(1);
    // Initial load only; later searches are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (key) => (event) => setFilters({ ...filters, [key]: event.target.value });

  return (
    <div className="p-6 lg:p-8 space-y-5">
      <AdminPageHeader module="Parcel network" page="Shipments" title="Shipments" />
      <Card>
        <form className="grid md:grid-cols-6 gap-2 items-end" onSubmit={(event) => { event.preventDefault(); search(1); }}>
          <Field label="AWB"><input className={inputClass} value={filters.awb} onChange={set('awb')} /></Field>
          <Field label="Phone"><input className={inputClass} value={filters.phone} onChange={set('phone')} /></Field>
          <Field label="Status">
            <select className={inputClass} value={filters.status} onChange={set('status')}>
              <option value="">All</option>
              {STATUSES.map((status) => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
            </select>
          </Field>
          <Field label="Hub">
            <select className={inputClass} value={filters.hubId} onChange={set('hubId')}>
              <option value="">All</option>
              {hubs.map((hub) => <option key={hub.id} value={hub.id}>{hub.code}</option>)}
            </select>
          </Field>
          <Field label="From"><input type="date" className={inputClass} value={filters.from} onChange={set('from')} /></Field>
          <Field label="To"><input type="date" className={inputClass} value={filters.to} onChange={set('to')} /></Field>
          <Button type="submit" className="md:col-span-6 md:w-32">Search</Button>
        </form>
      </Card>
      <Card title={`${result.total} shipments`}>
        <ShipmentTable rows={result.results} onOpen={(row) => setOpen(row.awb)} />
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="secondary" disabled={result.page <= 1} onClick={() => search(result.page - 1)}>Previous</Button>
          <Button variant="secondary" disabled={result.page * (result.limit || 50) >= result.total} onClick={() => search(result.page + 1)}>Next</Button>
        </div>
      </Card>
      {open && <Detail awb={open} onClose={() => setOpen('')} />}
    </div>
  );
};

export default LogisticsShipments;
