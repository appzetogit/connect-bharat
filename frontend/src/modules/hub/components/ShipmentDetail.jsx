import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { hubApi, printLabel } from '../services/hubApi';
import { Button, Modal, StatusBadge } from './ui';
import { formatDateTime, money } from './format';

/** Shipment detail with the custody timeline and label printing. */
const ShipmentDetailBody = ({ awb, onClose }) => {
  const [shipment, setShipment] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    hubApi.shipment(awb).then(setShipment).catch((err) => setError(err.message));
  }, [awb]);

  return (
    <Modal
      open
      title={awb || ''}
      onClose={onClose}
      footer={<Button variant="secondary" onClick={() => printLabel(awb)}><Printer size={14} /> Print label</Button>}
    >
      {error && <p className="text-[13px] text-rose-600">{error}</p>}
      {!shipment && !error && <p className="text-[13px] text-slate-400">Loading…</p>}
      {shipment && (
        <div className="space-y-4 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={shipment.status} label={shipment.displayStatus} />
            <span className="text-slate-500">{shipment.scope?.replace('_', ' ')}</span>
            {shipment.express && <span className="text-amber-700 font-semibold text-[11px]">EXPRESS</span>}
            {shipment.fragile && <span className="text-rose-700 font-semibold text-[11px]">FRAGILE</span>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase text-slate-400">Sender</div>
              <div>{shipment.sender?.name}</div>
              <div className="text-slate-500">{shipment.sender?.phone}</div>
              <div className="text-slate-500">{shipment.sender?.address}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-slate-400">Receiver</div>
              <div>{shipment.receiver?.name}</div>
              <div className="text-slate-500">{shipment.receiver?.phone}</div>
              <div className="text-slate-500">{shipment.receiver?.address}</div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><div className="text-[11px] uppercase text-slate-400">Route</div>{shipment.originHub?.code} → {shipment.destinationHub?.code}</div>
            <div><div className="text-[11px] uppercase text-slate-400">Chargeable</div>{shipment.chargeableWeight} kg</div>
            <div><div className="text-[11px] uppercase text-slate-400">Price</div>{money(shipment.pricing?.total)} · {shipment.payment?.method}</div>
            <div><div className="text-[11px] uppercase text-slate-400">SLA due</div>{formatDateTime(shipment.slaDueAt)}</div>
            <div><div className="text-[11px] uppercase text-slate-400">Attempts</div>{shipment.attemptsCount}</div>
            <div><div className="text-[11px] uppercase text-slate-400">OTP</div>{shipment.deliveryOtp?.verified ? 'Verified' : shipment.deliveryOtp?.sentAt ? 'Sent' : '—'}</div>
          </div>
          {shipment.weightDiscrepancy?.flagged && (
            <div className="rounded-lg bg-amber-50 text-amber-900 px-3 py-2">
              Weight discrepancy: booked {shipment.weightDiscrepancy.bookedChargeableKg} kg, measured {shipment.weightDiscrepancy.measuredChargeableKg} kg
            </div>
          )}
          <div>
            <div className="text-[11px] uppercase text-slate-400 mb-2">Timeline</div>
            <ol className="space-y-2 border-l border-slate-200 pl-4">
              {(shipment.timeline || []).map((event) => (
                <li key={event.id} className="relative">
                  <span className={`absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full ${event.discrepancy ? 'bg-amber-500' : 'bg-slate-400'}`} />
                  <div className="flex flex-wrap gap-x-2">
                    <span className="font-medium text-slate-800">{event.type.replace(/_/g, ' ')}</span>
                    {event.toStatus && event.toStatus !== event.fromStatus && <StatusBadge status={event.toStatus} label={event.displayStatus} />}
                    {event.hub && <span className="text-slate-500">@ {event.hub.code}</span>}
                  </div>
                  <div className="text-[11px] text-slate-400">{formatDateTime(event.at)} · {event.actorType}</div>
                  {event.note && <div className="text-[12px] text-slate-600">{event.note}</div>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Modal>
  );
};

/** Keyed on the AWB so opening another parcel starts from a clean state. */
const ShipmentDetail = ({ awb, onClose }) => (awb ? <ShipmentDetailBody key={awb} awb={awb} onClose={onClose} /> : null);

export default ShipmentDetail;
