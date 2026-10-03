import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { hubApi } from '../services/hubApi';
import { Button, Field, Modal } from './ui';
import { inputClass } from './format';

/**
 * Assign a first-mile pickup or last-mile delivery:
 *   auto    the taxi dispatcher finds a driver (a parcel ride)
 *   manual  pick one of the online drivers near the hub
 *   runner  the hub's own delivery staff (last mile only)
 */
const AssignLegModal = ({ shipment, legType, onClose, onDone }) => {
  const [mode, setMode] = useState('auto');
  const [vehicleTypeId, setVehicleTypeId] = useState('');
  const [drivers, setDrivers] = useState([]);
  const [driverId, setDriverId] = useState('');
  const [runner, setRunner] = useState({ name: '', phone: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mode !== 'manual') return;
    hubApi
      .nearbyDrivers({ vehicleTypeId: vehicleTypeId || undefined, radiusKm: 8 })
      .then((result) => setDrivers(result?.results || []))
      .catch((error) => toast.error(error.message));
  }, [mode, vehicleTypeId]);

  if (!shipment) return null;

  const submit = async () => {
    setLoading(true);
    try {
      const payload = { legType, mode, vehicleTypeId: vehicleTypeId || undefined };
      if (mode === 'manual') payload.driverId = driverId;
      if (mode === 'runner') payload.assignee = runner;
      const result = await hubApi.assignLeg(shipment.awb, payload);
      toast.success(
        mode === 'auto'
          ? 'Searching for a driver'
          : mode === 'runner'
            ? 'Out for delivery with runner'
            : `Driver assigned${result?.otp ? ` · ride OTP ${result.otp}` : ''}`,
      );
      onDone?.(result);
      onClose();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  const modes = legType === 'last_mile' ? ['auto', 'manual', 'runner'] : ['auto', 'manual'];

  return (
    <Modal
      open
      title={`${legType === 'first_mile' ? 'Pickup' : legType === 'rto_last_mile' ? 'Return' : 'Delivery'} · ${shipment.awb}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={loading} disabled={(mode === 'manual' && !driverId) || (mode === 'runner' && !runner.name)}>Assign</Button>
        </>
      }
    >
      <div className="flex gap-1 bg-slate-100 rounded-lg p-1 text-[12px]">
        {modes.map((value) => (
          <button key={value} type="button" onClick={() => setMode(value)} className={`flex-1 py-1.5 rounded-md capitalize ${mode === value ? 'bg-white shadow-sm' : 'text-slate-500'}`}>
            {value === 'auto' ? 'Auto dispatch' : value === 'manual' ? 'Pick a driver' : 'Hub runner'}
          </button>
        ))}
      </div>
      {mode !== 'runner' && (
        <Field label="Vehicle type id (optional)" hint="Blank uses the default from logistics settings, or any vehicle">
          <input className={inputClass} value={vehicleTypeId} onChange={(event) => setVehicleTypeId(event.target.value.trim())} />
        </Field>
      )}
      {mode === 'manual' && (
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {drivers.length === 0 && <p className="text-[13px] text-slate-400">No online drivers near the hub.</p>}
          {drivers.map((driver) => (
            <label key={driver.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-[13px] cursor-pointer ${driverId === driver.id ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <input type="radio" name="driver" checked={driverId === driver.id} onChange={() => setDriverId(driver.id)} disabled={driver.isOnRide} />
              <div className="flex-1">
                <div className="font-medium">{driver.name} <span className="text-slate-400 font-normal">{driver.vehicleNumber}</span></div>
                <div className="text-[11px] text-slate-500">{driver.vehicleType} · {driver.distanceKm ?? '?'} km away {driver.isOnRide ? '· on a ride' : ''}</div>
              </div>
            </label>
          ))}
        </div>
      )}
      {mode === 'runner' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Runner name"><input className={inputClass} value={runner.name} onChange={(event) => setRunner({ ...runner, name: event.target.value })} /></Field>
          <Field label="Runner phone"><input className={inputClass} value={runner.phone} onChange={(event) => setRunner({ ...runner, phone: event.target.value })} /></Field>
        </div>
      )}
    </Modal>
  );
};

export default AssignLegModal;
