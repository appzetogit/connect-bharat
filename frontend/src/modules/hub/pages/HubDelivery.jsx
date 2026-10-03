import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { hubApi } from '../services/hubApi';
import { useHubLiveUpdates } from '../services/hubSocket';
import AssignLegModal from '../components/AssignLegModal';
import ShipmentDetail from '../components/ShipmentDetail';
import { Button, Card, Empty, Field, Modal, PageTitle, ShipmentTable, StatusBadge } from '../components/ui';
import { inputClass } from '../components/format';

/**
 * Last mile: assign parcels waiting at the hub (taxi dispatch, a chosen
 * driver, or a hub runner), then close each run as delivered (with the
 * receiver's OTP) or failed (with a reason code).
 */
export const OutcomeModal = ({ shipment, kind, reasons, onClose, onDone }) => {
  const [otp, setOtp] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [codCollected, setCodCollected] = useState('');
  const [reasonCode, setReasonCode] = useState(Object.keys(reasons || {})[0] || 'customer_unavailable');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  if (!shipment) return null;

  const submit = async () => {
    setLoading(true);
    try {
      if (kind === 'deliver') {
        await hubApi.deliver(shipment.awb, {
          otp: otp || undefined,
          receivedBy: receivedBy || undefined,
          codCollectedAmount: codCollected ? Number(codCollected) : undefined,
        });
        toast.success('Delivered');
      } else {
        const result = await hubApi.fail(shipment.awb, { reasonCode, note: note || undefined });
        toast.success(result?.autoRto ? 'Marked failed; maximum attempts reached, return started' : 'Marked failed');
      }
      onDone?.();
      onClose();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open
      title={`${kind === 'deliver' ? 'Deliver' : 'Failed delivery'} · ${shipment.awb}`}
      onClose={onClose}
      footer={<Button variant={kind === 'deliver' ? 'success' : 'danger'} onClick={submit} loading={loading}>{kind === 'deliver' ? 'Confirm delivery' : 'Mark failed'}</Button>}
    >
      {kind === 'deliver' ? (
        <>
          <Field label="Receiver OTP" hint="Sent to the receiver by SMS when the parcel went out">
            <input className={`${inputClass} font-mono tracking-[0.3em]`} value={otp} onChange={(event) => setOtp(event.target.value)} maxLength={4} inputMode="numeric" autoFocus />
          </Field>
          <Field label="Received by (optional)"><input className={inputClass} value={receivedBy} onChange={(event) => setReceivedBy(event.target.value)} /></Field>
          {shipment.payment?.method === 'cod' && (
            <Field label="COD collected (₹)" hint={`Due ₹${shipment.pricing?.total ?? ''}`}>
              <input className={inputClass} value={codCollected} onChange={(event) => setCodCollected(event.target.value)} inputMode="decimal" />
            </Field>
          )}
        </>
      ) : (
        <>
          <Field label="Reason">
            <select className={inputClass} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
              {Object.entries(reasons || {}).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </Field>
          <Field label="Note"><input className={inputClass} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
        </>
      )}
    </Modal>
  );
};

const HubDelivery = () => {
  const { me } = useOutletContext() || {};
  const [ready, setReady] = useState([]);
  const [out, setOut] = useState([]);
  const [legs, setLegs] = useState([]);
  const [assigning, setAssigning] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [open, setOpen] = useState('');

  const load = useCallback(() => {
    hubApi.shipments({ view: 'delivery', limit: 200 }).then((data) => setReady(data?.results || [])).catch((error) => toast.error(error.message));
    hubApi.shipments({ view: 'out_for_delivery', limit: 200 }).then((data) => setOut(data?.results || [])).catch(() => {});
    hubApi.legs({ type: 'last_mile,rto_last_mile,first_mile' }).then((data) => setLegs(data?.results || [])).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useHubLiveUpdates(load);

  const resend = async (row) => {
    try {
      const result = await hubApi.resendOtp(row.awb);
      toast.success(`OTP resent${result?.debugOtp ? ` (dev: ${result.debugOtp})` : ''}`);
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="space-y-5">
      <PageTitle title="Delivery" subtitle="Assign last-mile runs and close them out." />
      <Card title={`Ready for delivery (${ready.length})`}>
        <ShipmentTable rows={ready} onOpen={(row) => setOpen(row.awb)} actions={(row) => <Button variant="secondary" onClick={() => setAssigning(row)}>Assign</Button>} />
      </Card>
      <Card title={`Out for delivery (${out.length})`}>
        <ShipmentTable
          rows={out}
          onOpen={(row) => setOpen(row.awb)}
          actions={(row) => (
            <div className="flex justify-end gap-1">
              <Button variant="success" onClick={() => setOutcome({ shipment: row, kind: 'deliver' })}>Delivered</Button>
              <Button variant="danger" onClick={() => setOutcome({ shipment: row, kind: 'fail' })}>Failed</Button>
              <Button variant="secondary" onClick={() => resend(row)}>OTP</Button>
            </div>
          )}
        />
      </Card>
      <Card title="Open driver legs">
        {legs.length ? (
          <ul className="divide-y divide-slate-100 text-[13px]">
            {legs.map((leg) => (
              <li key={leg._id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-mono">{leg.awb}</span>
                  <span className="ml-2 text-slate-500">{leg.type.replace(/_/g, ' ')} · {leg.assignmentMode.replace(/_/g, ' ')}</span>
                  <div className="text-[11px] text-slate-400">
                    {leg.ride?.driver ? `${leg.ride.driver.name} · ${leg.ride.driver.phone} · ${leg.ride.driver.vehicleNumber || ''}` : leg.assignee?.name || 'Searching for a driver…'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {leg.ride?.otp && <span className="text-[12px] text-slate-500">Ride OTP <span className="font-mono font-semibold text-slate-900">{leg.ride.otp}</span></span>}
                  <StatusBadge status={leg.status === 'in_progress' ? 'out_for_delivery' : 'pickup_scheduled'} label={leg.ride?.liveStatus || leg.status} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No open legs.</Empty>
        )}
      </Card>
      {assigning && <AssignLegModal shipment={assigning} legType="last_mile" onClose={() => setAssigning(null)} onDone={load} />}
      {outcome && <OutcomeModal {...outcome} reasons={me?.failureReasonCodes} onClose={() => setOutcome(null)} onDone={load} />}
      <ShipmentDetail awb={open} onClose={() => setOpen('')} />
    </div>
  );
};

export default HubDelivery;
