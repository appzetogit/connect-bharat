import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { adminService } from '../../services/adminService';
import { unwrap } from '../../services/operationsApi';
import DocumentReviewPanel from './DocumentReviewPanel';
import VehicleApprovalCard from './VehicleApprovalCard';
import DriverApplicationDecision from './DriverApplicationDecision';
import { getApiErrorMessage } from './approvalUtils';

/**
 * Full review of one driver application: documents, own vehicle and the
 * approve / reject decision. `onDecision` runs after approve or reject.
 */
const DriverReviewModal = ({ driverId, open, onClose, onDecision, labels }) => {
  const [driver, setDriver] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const loadDriver = useCallback(async () => {
    if (!driverId) return;
    setIsLoading(true);
    setError('');
    try {
      const response = await adminService.getDriver(driverId);
      setDriver(unwrap(response) || null);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to load driver'));
      setDriver(null);
    } finally {
      setIsLoading(false);
    }
  }, [driverId]);

  useEffect(() => {
    if (open) loadDriver();
    else setDriver(null);
  }, [open, loadDriver]);

  if (!open) return null;

  const handleDecision = async () => {
    await onDecision?.();
    onClose?.();
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="my-6 w-full max-w-3xl space-y-4 rounded-2xl border border-gray-100 bg-gray-50 p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-gray-900">Review application</h3>
            <p className="text-xs text-gray-500">
              {driver ? `${driver.name || 'Driver'} · ${driver.phone || driver.mobile || ''}` : 'Loading driver...'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 transition-colors hover:text-gray-900" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-500">
            <Loader2 size={14} className="animate-spin" /> Loading driver...
          </div>
        ) : error ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-100 bg-rose-50 p-4 text-xs font-semibold text-rose-600">
            <span className="flex items-center gap-2"><AlertCircle size={14} /> {error}</span>
            <button type="button" onClick={loadDriver} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-bold text-gray-700">
              Retry
            </button>
          </div>
        ) : driver ? (
          <>
            <DocumentReviewPanel driverId={driverId} documents={driver.documents || {}} labels={labels} />
            <VehicleApprovalCard driver={driver} />
            <DriverApplicationDecision
              driverId={driverId}
              rejectionReason={driver.rejectionReason || ''}
              labels={labels}
              onApproved={handleDecision}
              onRejected={handleDecision}
            />
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
};

export default DriverReviewModal;
