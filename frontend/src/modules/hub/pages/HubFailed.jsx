import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { hubApi } from '../services/hubApi';
import { useHubLiveUpdates } from '../services/hubSocket';
import AssignLegModal from '../components/AssignLegModal';
import ShipmentDetail from '../components/ShipmentDetail';
import { Button, Card, Field, Modal, PageTitle, ShipmentTable } from '../components/ui';
import { inputClass } from '../components/format';

/**
 * Failed deliveries and returns: reschedule a new attempt (date + slot), or
 * start / finish the return to the sender.
 */
const RescheduleModal = ({ shipment, onClose, onDone }) => {
  const [date, setDate] = useState(() => new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  const [slots, setSlots] = useState([]);
  const [slot, setSlot] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    hubApi.pickupSlots(date).then((data) => {
      const available = (data?.results || []).filter((item) => item.available);
      setSlots(available);
      setSlot(available[0]?.slot || '');
    }).catch(() => setSlots([]));
  }, [date]);

  const submit = async () => {
    setLoading(true);
    try {
      await hubApi.reschedule(shipment.awb, { date, slot });
      toast.success('Reattempt scheduled');
      onDone?.();
      onClose();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open title={`Reschedule · ${shipment.awb}`} onClose={onClose} footer={<Button onClick={submit} loading={loading} disabled={!slot}>Schedule</Button>}>
      <Field label="Date"><input type="date" className={inputClass} value={date} onChange={(event) => setDate(event.target.value)} /></Field>
      <Field label="Slot">
        <select className={inputClass} value={slot} onChange={(event) => setSlot(event.target.value)}>
          {slots.length === 0 && <option value="">No slots available</option>}
          {slots.map((item) => <option key={item.slot} value={item.slot}>{item.slot}</option>)}
        </select>
      </Field>
    </Modal>
  );
};

const HubFailed = () => {
  const [failed, setFailed] = useState([]);
  const [rto, setRto] = useState([]);
  const [rescheduling, setRescheduling] = useState(null);
  const [returning, setReturning] = useState(null);
  const [open, setOpen] = useState('');

  const load = useCallback(() => {
    hubApi.shipments({ view: 'failed', limit: 200 }).then((data) => setFailed(data?.results || [])).catch((error) => toast.error(error.message));
    hubApi.shipments({ view: 'rto', limit: 200 }).then((data) => setRto(data?.results || [])).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useHubLiveUpdates(load);

  const run = async (fn, message) => {
    try {
      await fn();
      toast.success(message);
      load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="space-y-5">
      <PageTitle title="Failed & RTO" subtitle="Reattempt, or send the parcel back to the sender." />
      <Card title={`Failed / rescheduled (${failed.length})`}>
        <ShipmentTable
          rows={failed}
          onOpen={(row) => setOpen(row.awb)}
          actions={(row) => (
            <div className="flex justify-end gap-1">
              {row.status === 'delivery_failed' && <Button variant="secondary" onClick={() => setRescheduling(row)}>Reschedule</Button>}
              <Button variant="danger" onClick={() => run(() => hubApi.rto(row.awb, 'Returned after failed delivery'), 'Return started')}>RTO</Button>
            </div>
          )}
        />
      </Card>
      <Card title={`Returning to sender (${rto.length})`}>
        <ShipmentTable
          rows={rto}
          onOpen={(row) => setOpen(row.awb)}
          actions={(row) =>
            row.currentHub?.id && row.currentHub.id === row.originHub?.id ? (
              <div className="flex justify-end gap-1">
                <Button variant="secondary" onClick={() => setReturning(row)}>Driver to sender</Button>
                <Button variant="success" onClick={() => run(() => hubApi.deliver(row.awb, {}), 'Handed back to sender')}>Handed back</Button>
              </div>
            ) : (
              <span className="text-[11px] text-slate-400">Add to a manifest for {row.originHub?.code}</span>
            )
          }
        />
      </Card>
      {rescheduling && <RescheduleModal shipment={rescheduling} onClose={() => setRescheduling(null)} onDone={load} />}
      {returning && <AssignLegModal shipment={returning} legType="rto_last_mile" onClose={() => setReturning(null)} onDone={load} />}
      <ShipmentDetail awb={open} onClose={() => setOpen('')} />
    </div>
  );
};

export default HubFailed;
