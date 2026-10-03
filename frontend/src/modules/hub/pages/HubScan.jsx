import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { hubApi } from '../services/hubApi';
import ScanInput from '../components/ScanInput';
import ShipmentDetail from '../components/ShipmentDetail';
import { Card, Field, PageTitle, StatusBadge } from '../components/ui';
import { inputClass } from '../components/format';

const SCAN_TYPES = [
  { value: 'inbound', label: 'Inbound (receive at hub)' },
  { value: 'outbound', label: 'Outbound (leaves hub, no manifest)' },
  { value: 'out_for_delivery', label: 'Out for delivery' },
  { value: 'delivered', label: 'Delivered at counter / RTO handover' },
  { value: 'failed', label: 'Delivery failed' },
  { value: 'rto', label: 'Return to sender' },
  { value: 'exception', label: 'Exception (lost / damaged)' },
];

/** A short tone so a scan's outcome is heard without looking at the screen. */
const beep = (ok) => {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = ok ? 880 : 220;
    oscillator.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + (ok ? 0.08 : 0.3));
  } catch {
    // No audio: the coloured log row is enough.
  }
};

const HubScan = () => {
  const { me } = useOutletContext() || {};
  const [type, setType] = useState('inbound');
  const [weightKg, setWeightKg] = useState('');
  const [dims, setDims] = useState({ l: '', w: '', h: '' });
  const [reasonCode, setReasonCode] = useState('customer_unavailable');
  const [otp, setOtp] = useState('');
  const [exceptionType, setExceptionType] = useState('damaged');
  const [note, setNote] = useState('');
  const [runner, setRunner] = useState({ name: '', phone: '' });
  const [log, setLog] = useState([]);
  const [open, setOpen] = useState('');

  const reasons = me?.failureReasonCodes || { customer_unavailable: 'Customer not available' };

  const onScan = async (awb) => {
    const body = { awb, type, note: note || undefined };
    if (type === 'inbound' && weightKg) {
      body.weightKg = Number(weightKg);
      if (dims.l && dims.w && dims.h) body.dimensions = { l: Number(dims.l), w: Number(dims.w), h: Number(dims.h) };
    }
    if (type === 'failed') body.reasonCode = reasonCode;
    if (type === 'delivered') body.otp = otp || undefined;
    if (type === 'exception') body.exceptionType = exceptionType;
    if (type === 'out_for_delivery' && runner.name) body.assignee = runner;
    try {
      const result = await hubApi.scan(body);
      beep(true);
      setLog((rows) => [{ ok: true, awb, at: new Date(), ...result }, ...rows].slice(0, 100));
      if (type === 'inbound') setWeightKg('');
      if (type === 'delivered') setOtp('');
    } catch (error) {
      beep(false);
      setLog((rows) => [{ ok: false, awb, at: new Date(), error: error.message }, ...rows].slice(0, 100));
    }
  };

  return (
    <div className="space-y-5">
      <PageTitle title="Scan" subtitle="Scanners type the AWB and press Enter; the box stays focused for the next parcel." />
      <Card>
        <div className="grid md:grid-cols-3 gap-3 mb-4">
          <Field label="Scan type">
            <select className={inputClass} value={type} onChange={(event) => setType(event.target.value)}>
              {SCAN_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </Field>
          {type === 'inbound' && (
            <>
              <Field label="Re-weigh (kg, optional)" hint="Flags a discrepancy if outside tolerance">
                <input className={inputClass} value={weightKg} onChange={(event) => setWeightKg(event.target.value)} inputMode="decimal" />
              </Field>
              <Field label="Dimensions L × W × H cm (optional)">
                <div className="flex gap-1">
                  {['l', 'w', 'h'].map((key) => (
                    <input key={key} className={inputClass} value={dims[key]} placeholder={key.toUpperCase()} onChange={(event) => setDims({ ...dims, [key]: event.target.value })} inputMode="decimal" />
                  ))}
                </div>
              </Field>
            </>
          )}
          {type === 'failed' && (
            <Field label="Reason">
              <select className={inputClass} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
                {Object.entries(reasons).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </Field>
          )}
          {type === 'delivered' && (
            <Field label="Receiver OTP" hint="Not needed for an RTO handover">
              <input className={`${inputClass} font-mono`} value={otp} onChange={(event) => setOtp(event.target.value)} maxLength={4} inputMode="numeric" />
            </Field>
          )}
          {type === 'exception' && (
            <Field label="Exception">
              <select className={inputClass} value={exceptionType} onChange={(event) => setExceptionType(event.target.value)}>
                <option value="damaged">Damaged</option>
                <option value="lost">Lost</option>
              </select>
            </Field>
          )}
          {type === 'out_for_delivery' && (
            <Field label="Runner (hub delivery staff)">
              <div className="flex gap-1">
                <input className={inputClass} placeholder="Name" value={runner.name} onChange={(event) => setRunner({ ...runner, name: event.target.value })} />
                <input className={inputClass} placeholder="Phone" value={runner.phone} onChange={(event) => setRunner({ ...runner, phone: event.target.value })} />
              </div>
            </Field>
          )}
          <Field label="Note (optional)">
            <input className={inputClass} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </div>
        <ScanInput onScan={onScan} />
      </Card>

      <Card title={`Scan log (${log.length})`}>
        {log.length === 0 ? (
          <p className="text-[13px] text-slate-400">Scans appear here.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-[13px]">
            {log.map((row, index) => (
              <li key={`${row.awb}-${index}`} className={`py-2 flex items-start gap-3 ${row.ok ? '' : 'bg-rose-50/60 -mx-4 px-4'}`}>
                {row.ok ? <CheckCircle2 size={16} className="text-emerald-600 mt-0.5" /> : <XCircle size={16} className="text-rose-600 mt-0.5" />}
                <div className="flex-1 min-w-0">
                  <button type="button" className="font-mono hover:underline" onClick={() => setOpen(row.awb)}>{row.awb}</button>
                  {row.ok ? (
                    <span className="ml-2 inline-flex items-center gap-1">
                      <StatusBadge status={row.fromStatus} /> → <StatusBadge status={row.toStatus} label={row.displayStatus} />
                    </span>
                  ) : (
                    <span className="ml-2 text-rose-700">{row.error}</span>
                  )}
                  {row.warnings?.map((warning) => <div key={warning} className="text-amber-700 text-[12px]">{warning}</div>)}
                  {row.deliveryOtp?.debugOtp && <div className="text-[11px] text-slate-400">Dev delivery OTP: {row.deliveryOtp.debugOtp}</div>}
                </div>
                <span className="text-[11px] text-slate-400">{row.at.toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ShipmentDetail awb={open} onClose={() => setOpen('')} />
    </div>
  );
};

export default HubScan;
