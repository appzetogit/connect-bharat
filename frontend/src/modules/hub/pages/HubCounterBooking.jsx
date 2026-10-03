import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Printer } from 'lucide-react';
import { hubApi, printLabel } from '../services/hubApi';
import { Button, Card, Field, PageTitle } from '../components/ui';
import { inputClass, money } from '../components/format';

/**
 * Counter booking: a walk-in sender hands a parcel over at the hub. The
 * booking is created as already received at this hub, priced on the same
 * rate cards the app uses, and the label can be printed straight away.
 */
const parseLatLng = (text) => {
  const [lat, lng] = String(text || '').split(',').map((part) => Number(part.trim()));
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
};

const emptyParty = { name: '', phone: '', address: '', pincode: '', latLng: '' };

const HubCounterBooking = () => {
  const { me } = useOutletContext() || {};
  const [sender, setSender] = useState(emptyParty);
  const [receiver, setReceiver] = useState(emptyParty);
  const [parcel, setParcel] = useState({ weightKg: '', l: '', w: '', h: '', description: '', declaredValue: '', fragile: false, express: false, insurance: false, paymentMethod: 'cash' });
  const [quote, setQuote] = useState(null);
  const [booked, setBooked] = useState(null);
  const [loading, setLoading] = useState(false);

  const hubLocation = me?.activeHub?.location;

  const payload = () => {
    const senderLocation = parseLatLng(sender.latLng) || hubLocation;
    const receiverLocation = parseLatLng(receiver.latLng);
    if (!receiverLocation) throw new Error('Receiver location must be "lat, lng"');
    return {
      sender: { ...sender, location: senderLocation },
      receiver: { ...receiver, location: receiverLocation },
      weightKg: Number(parcel.weightKg),
      dimensions: parcel.l && parcel.w && parcel.h ? { l: Number(parcel.l), w: Number(parcel.w), h: Number(parcel.h) } : undefined,
      description: parcel.description,
      declaredValue: Number(parcel.declaredValue) || 0,
      fragile: parcel.fragile,
      express: parcel.express,
      insurance: { opted: parcel.insurance },
      paymentMethod: parcel.paymentMethod,
      pickupMode: 'drop_at_hub',
      forceHub: true,
    };
  };

  const run = async (fn) => {
    setLoading(true);
    try {
      await fn();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  const partyFields = (party, setParty, title, optionalLocation) => (
    <Card title={title}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name"><input className={inputClass} value={party.name} onChange={(event) => setParty({ ...party, name: event.target.value })} /></Field>
        <Field label="Phone"><input className={inputClass} value={party.phone} onChange={(event) => setParty({ ...party, phone: event.target.value })} inputMode="numeric" /></Field>
        <div className="col-span-2"><Field label="Address"><input className={inputClass} value={party.address} onChange={(event) => setParty({ ...party, address: event.target.value })} /></Field></div>
        <Field label="Pincode"><input className={inputClass} value={party.pincode} onChange={(event) => setParty({ ...party, pincode: event.target.value })} /></Field>
        <Field label="Location (lat, lng)" hint={optionalLocation ? 'Blank = this hub' : 'From the map pin'}>
          <input className={inputClass} value={party.latLng} onChange={(event) => setParty({ ...party, latLng: event.target.value })} placeholder="12.97, 77.59" />
        </Field>
      </div>
    </Card>
  );

  return (
    <div className="space-y-5 max-w-4xl">
      <PageTitle title="Counter booking" subtitle="Book a parcel a sender drops at this hub." />
      <div className="grid md:grid-cols-2 gap-5">
        {partyFields(sender, setSender, 'Sender', true)}
        {partyFields(receiver, setReceiver, 'Receiver', false)}
      </div>
      <Card title="Parcel">
        <div className="grid md:grid-cols-4 gap-2">
          <Field label="Weight (kg)"><input className={inputClass} value={parcel.weightKg} onChange={(event) => setParcel({ ...parcel, weightKg: event.target.value })} inputMode="decimal" /></Field>
          {['l', 'w', 'h'].map((key) => (
            <Field key={key} label={`${key.toUpperCase()} (cm)`}><input className={inputClass} value={parcel[key]} onChange={(event) => setParcel({ ...parcel, [key]: event.target.value })} inputMode="decimal" /></Field>
          ))}
          <div className="md:col-span-2"><Field label="Contents"><input className={inputClass} value={parcel.description} onChange={(event) => setParcel({ ...parcel, description: event.target.value })} /></Field></div>
          <Field label="Declared value (₹)"><input className={inputClass} value={parcel.declaredValue} onChange={(event) => setParcel({ ...parcel, declaredValue: event.target.value })} inputMode="decimal" /></Field>
          <Field label="Payment">
            <select className={inputClass} value={parcel.paymentMethod} onChange={(event) => setParcel({ ...parcel, paymentMethod: event.target.value })}>
              <option value="cash">Cash at counter</option>
              <option value="cod">Cash on delivery</option>
              <option value="online">Online</option>
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-4 mt-3 text-[13px]">
          {[['fragile', 'Fragile'], ['express', 'Express'], ['insurance', 'Insure declared value']].map(([key, label]) => (
            <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={parcel[key]} onChange={(event) => setParcel({ ...parcel, [key]: event.target.checked })} /> {label}</label>
          ))}
        </div>
        <div className="flex gap-2 mt-4">
          <Button loading={loading} onClick={() => run(async () => { const result = await hubApi.counterBooking(payload()); setBooked(result); setQuote(result.quote); toast.success(`Booked ${result.shipment.awb}`); })}>
            Book parcel
          </Button>
        </div>
      </Card>
      {booked && (
        <Card title={`Booked · ${booked.shipment.awb}`} right={<Button variant="secondary" onClick={() => printLabel(booked.shipment.awb)}><Printer size={14} /> Print label</Button>}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[13px]">
            <div><div className="text-[11px] uppercase text-slate-400">Route</div>{quote?.originHub?.code} → {quote?.destinationHub?.code}</div>
            <div><div className="text-[11px] uppercase text-slate-400">Scope</div>{quote?.scope}</div>
            <div><div className="text-[11px] uppercase text-slate-400">Chargeable</div>{quote?.chargeableWeightKg} kg ({quote?.billedOn})</div>
            <div><div className="text-[11px] uppercase text-slate-400">Total</div>{money(quote?.pricing?.total)}</div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default HubCounterBooking;
