import React, { useState } from 'react';
import { Car, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { operationsApi, unwrap } from '../../services/operationsApi';
import ReasonDialog from './ReasonDialog';
import { formatReviewDate, getApiErrorMessage, isFleetAttachedDriver } from './approvalUtils';

const STATUS_STYLES = {
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  rejected: 'bg-rose-50 text-rose-700 border-rose-100',
  pending: 'bg-amber-50 text-amber-700 border-amber-100',
};

const pick = (...values) => values.find((value) => String(value ?? '').trim()) || '';

/**
 * Approval of a driver's own (self-owned) vehicle. Renders a short note instead
 * for drivers attached to a fleet owner, whose company vehicle is approved in
 * Manage Fleet.
 */
const VehicleApprovalCard = ({ driver, onChange }) => {
  const [approval, setApproval] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  if (!driver) return null;

  const driverId = driver._id || driver.id;

  if (isFleetAttachedDriver(driver)) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-500">
        <span className="font-semibold text-gray-700">Vehicle:</span> this driver drives a fleet owner&apos;s vehicle, which is approved from Manage Fleet.
      </div>
    );
  }

  const current = approval || driver.vehicleApproval || {};
  const status = String(current.status || 'pending').toLowerCase();

  const vehicleInfo = [
    { label: 'Type', value: pick(driver.vehicleType, driver.vehicle_type, driver.transport_type, driver.register_for) },
    { label: 'Make / Model', value: [pick(driver.vehicleMake, driver.car_make, driver.car_brand), pick(driver.vehicleModel, driver.car_model)].filter(Boolean).join(' ') },
    { label: 'Number', value: pick(driver.vehicleNumber, driver.vehicle_number, driver.car_number) },
    { label: 'Color', value: pick(driver.vehicleColor, driver.car_color) },
  ];

  const submit = async (nextStatus, reason = '') => {
    setBusy(true);
    try {
      const response =
        nextStatus === 'approved'
          ? await operationsApi.approveDriverVehicle(driverId)
          : await operationsApi.rejectDriverVehicle(driverId, reason);
      const data = unwrap(response) || {};
      setApproval({ status: data.status || nextStatus, reason: data.reason ?? reason, reviewedAt: data.reviewedAt || new Date().toISOString() });
      setRejectOpen(false);
      toast.success(nextStatus === 'approved' ? 'Vehicle approved' : 'Vehicle rejected');
      onChange?.(data);
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Failed to update vehicle approval'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Car size={15} className="text-gray-500" />
          <h4 className="text-sm font-bold text-gray-900">Own vehicle</h4>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLES[status] || STATUS_STYLES.pending}`}>
            {status}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || status === 'approved'}
            onClick={() => submit('approved')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition-all hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            Approve vehicle
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRejectOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-all hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <XCircle size={13} />
            Reject vehicle
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 px-4 py-3 md:grid-cols-4">
        {vehicleInfo.map((item) => (
          <div key={item.label}>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{item.label}</p>
            <p className="text-xs font-semibold text-gray-800">{item.value || 'Not set'}</p>
          </div>
        ))}
      </div>
      {status === 'rejected' && current.reason ? (
        <p className="px-4 pb-3 text-xs text-rose-600">Reason: {current.reason}</p>
      ) : null}
      {current.reviewedAt && status !== 'pending' ? (
        <p className="px-4 pb-3 text-[11px] text-gray-400">Reviewed {formatReviewDate(current.reviewedAt)}</p>
      ) : null}

      <ReasonDialog
        open={rejectOpen}
        title="Reject vehicle"
        description="The driver is notified with this reason."
        placeholder="e.g. RC does not match plate"
        confirmLabel="Reject vehicle"
        initialValue={status === 'rejected' ? current.reason || '' : ''}
        busy={busy}
        onClose={() => setRejectOpen(false)}
        onConfirm={(reason) => submit('rejected', reason)}
      />
    </div>
  );
};

export default VehicleApprovalCard;
