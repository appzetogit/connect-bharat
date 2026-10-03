import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { operationsApi } from '../../services/operationsApi';
import ReasonDialog from './ReasonDialog';
import { getApiErrorDetails, getApiErrorMessage, getApiErrorStatus, humanizeDocumentKey } from './approvalUtils';

/** Lists the documents blocking approval (from a 409 on POST /admin/drivers/:id/approve). */
export const ApprovalBlockers = ({ details, labels = {}, onDismiss }) => {
  if (!details) return null;
  const groups = [
    { key: 'missing', title: 'Missing', className: 'text-gray-700' },
    { key: 'pending', title: 'Awaiting review', className: 'text-amber-700' },
    { key: 'rejected', title: 'Rejected', className: 'text-rose-700' },
  ].filter((group) => Array.isArray(details[group.key]) && details[group.key].length > 0);

  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 font-bold text-rose-700">
          <AlertCircle size={14} /> The driver cannot be approved until every required document is approved.
        </p>
        {onDismiss ? (
          <button type="button" onClick={onDismiss} className="text-rose-400 hover:text-rose-700" aria-label="Dismiss">
            <XCircle size={14} />
          </button>
        ) : null}
      </div>
      {groups.length ? (
        <div className="mt-2 space-y-1">
          {groups.map((group) => (
            <p key={group.key} className={group.className}>
              <span className="font-semibold">{group.title}:</span>{' '}
              {details[group.key].map((key) => labels[key] || humanizeDocumentKey(key)).join(', ')}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Whole-application approve / reject for a driver.
 * Returns handlers plus the blockers state and a reject dialog element to render.
 */
export const useDriverApplicationDecision = (driverId, { onApproved, onRejected, confirmApprove = true } = {}) => {
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState(null);
  const [rejectOpen, setRejectOpen] = useState(false);

  const approve = async () => {
    if (!driverId || busy) return;
    if (confirmApprove && !window.confirm('Are you sure you want to APPROVE this driver?')) return;
    setBusy(true);
    setBlockers(null);
    try {
      await operationsApi.approveDriver(driverId);
      toast.success('Driver approved');
      await onApproved?.();
    } catch (err) {
      const details = getApiErrorDetails(err);
      if (getApiErrorStatus(err) === 409 && details) {
        setBlockers(details);
        toast.error(getApiErrorMessage(err, 'Documents are still outstanding'));
      } else {
        toast.error(getApiErrorMessage(err, 'Failed to approve driver'));
      }
    } finally {
      setBusy(false);
    }
  };

  const reject = async (reason) => {
    if (!driverId) return;
    setBusy(true);
    try {
      await operationsApi.rejectDriver(driverId, reason);
      toast.success('Application rejected');
      setRejectOpen(false);
      await onRejected?.(reason);
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Failed to reject application'));
    } finally {
      setBusy(false);
    }
  };

  const rejectDialog = (
    <ReasonDialog
      open={rejectOpen}
      title="Reject application"
      description="The driver is notified with this reason. They go offline and are marked rejected."
      placeholder="e.g. Licence expired"
      confirmLabel="Reject application"
      busy={busy}
      onClose={() => setRejectOpen(false)}
      onConfirm={reject}
    />
  );

  return {
    busy,
    blockers,
    clearBlockers: () => setBlockers(null),
    approve,
    openReject: () => setRejectOpen(true),
    rejectDialog,
  };
};

/** Default button row for approving / rejecting a driver application. */
const DriverApplicationDecision = ({ driverId, rejectionReason = '', labels, onApproved, onRejected }) => {
  const { busy, blockers, clearBlockers, approve, openReject, rejectDialog } = useDriverApplicationDecision(driverId, {
    onApproved,
    onRejected,
  });

  return (
    <div className="space-y-3">
      {rejectionReason ? (
        <div className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-2 text-xs text-rose-700">
          <span className="font-semibold">Application rejected:</span> {rejectionReason}
        </div>
      ) : null}
      <ApprovalBlockers details={blockers} labels={labels} onDismiss={clearBlockers} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={openReject}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-100 bg-rose-50 px-4 py-2 text-xs font-bold text-rose-600 transition-colors hover:bg-rose-100 disabled:opacity-50"
        >
          <XCircle size={14} /> Reject application
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={approve}
          className="inline-flex items-center gap-1.5 rounded-lg bg-yellow-400 px-4 py-2 text-xs font-bold text-black shadow-sm transition-colors hover:bg-yellow-500 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Approve driver
        </button>
      </div>
      {rejectDialog}
    </div>
  );
};

export default DriverApplicationDecision;
