import React, { useCallback, useEffect, useState } from 'react';
import { X, Loader2, UserPlus, Phone, Star, MapPin, Clock, AlertTriangle, RefreshCw, Car } from 'lucide-react';
import toast from 'react-hot-toast';
import { operationsApi, unwrap } from '../../services/operationsApi';

const RADIUS_OPTIONS = [5, 10, 20, 50];

const errorMessage = (err, fallback) =>
  err?.response?.data?.message || err?.message || fallback;

const formatKm = (meters) => {
  const value = Number(meters);
  if (!Number.isFinite(value)) return '-';
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} km`;
};

/**
 * Lists drivers near a ride's pickup and lets the admin assign (or reassign)
 * one. Non-eligible drivers whose every reason can be overridden get a
 * "Force assign" action behind an explicit warning.
 *
 * Props: ride ({ id, requestId, driver }), onClose(), onAssigned(result)
 */
const AssignDriverModal = ({ ride, onClose, onAssigned }) => {
  const rideId = ride?.id;
  const isReassign = Boolean(ride?.driver);

  const [radiusKm, setRadiusKm] = useState(10);
  const [includeOffline, setIncludeOffline] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submittingId, setSubmittingId] = useState(null);
  const [forceTarget, setForceTarget] = useState(null);

  const loadCandidates = useCallback(async () => {
    if (!rideId) return;
    setLoading(true);
    setError('');
    try {
      const response = await operationsApi.getCandidateDrivers(rideId, {
        radius_km: radiusKm,
        include_offline: includeOffline ? 1 : undefined,
      });
      const data = unwrap(response) || {};
      setCandidates(Array.isArray(data.candidates) ? data.candidates : []);
      setMeta(data);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load nearby drivers'));
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, [rideId, radiusKm, includeOffline]);

  useEffect(() => {
    loadCandidates();
  }, [loadCandidates]);

  const assign = async (candidate, force = false) => {
    if (!force) {
      const verb = isReassign ? 'Reassign' : 'Assign';
      const ok = window.confirm(`${verb} ${candidate.name || 'this driver'} to request ${ride?.requestId || rideId}?`);
      if (!ok) return;
    }
    setSubmittingId(candidate.driverId);
    try {
      const response = await operationsApi.assignDriver(rideId, candidate.driverId, force);
      const data = unwrap(response) || {};
      toast.success(
        `${candidate.name || 'Driver'} ${data.mode === 'reassign' ? 'reassigned' : 'assigned'}${data.forced ? ' (forced)' : ''}`,
      );
      setForceTarget(null);
      onAssigned?.(data);
    } catch (err) {
      const details = err?.details || err?.response?.data?.details;
      let message = errorMessage(err, 'Failed to assign driver');
      if (Array.isArray(details?.blockingReasons) && details.blockingReasons.length > 0) {
        message += ` (${details.blockingReasons.join(', ')})`;
      }
      toast.error(message);
      setForceTarget(null);
      // The candidate's state probably changed; show the latest.
      loadCandidates();
    } finally {
      setSubmittingId(null);
    }
  };

  if (!ride) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div
        className="bg-white w-full max-w-2xl shadow-2xl flex flex-col rounded-xl overflow-hidden max-h-[90vh] animate-in slide-in-from-bottom-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900 tracking-tight">{isReassign ? 'Reassign Driver' : 'Assign Driver'}</h2>
            <p className="text-[11px] text-gray-500 font-medium mt-0.5">
              <span className="font-mono font-bold text-gray-700">{ride.requestId || rideId}</span>
              {isReassign && ride.driver?.name ? ` • Current driver: ${ride.driver.name}` : ''}
            </p>
            {(meta?.ride?.pickupAddress || ride.pickupLabel) && (
              <p className="text-[11px] text-gray-400 font-medium mt-0.5 flex items-center gap-1 truncate max-w-[480px]">
                <MapPin size={11} /> {meta?.ride?.pickupAddress || ride.pickupLabel}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-6 py-2.5 bg-gray-50/60">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
            <span>Radius</span>
            <div className="flex bg-white p-0.5 rounded-md border border-gray-200">
              {RADIUS_OPTIONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setRadiusKm(r)}
                  className={`px-2 py-0.5 text-[11px] font-bold rounded ${radiusKm === r ? 'bg-yellow-400 text-black shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
                >
                  {r} km
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeOffline}
              onChange={(e) => setIncludeOffline(e.target.checked)}
              className="accent-yellow-400"
            />
            Include offline drivers
          </label>
          <button
            onClick={loadCandidates}
            disabled={loading}
            className="ml-auto flex h-7 items-center gap-1 px-2.5 rounded-md text-[10px] font-bold border bg-white text-gray-700 border-gray-200 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-16 text-center">
              <Loader2 className="animate-spin text-yellow-400 mx-auto" size={28} />
              <p className="mt-3 text-xs font-bold text-gray-400 uppercase tracking-widest">Finding nearby drivers...</p>
            </div>
          ) : error ? (
            <div className="py-12 text-center">
              <div className="bg-red-50 text-red-500 p-4 rounded-lg inline-block border border-red-100">
                <p className="text-sm font-bold">{error}</p>
                <button onClick={loadCandidates} className="mt-3 px-4 py-1.5 bg-red-100 text-red-700 rounded text-xs font-bold hover:bg-red-200">
                  Retry
                </button>
              </div>
            </div>
          ) : candidates.length === 0 ? (
            <div className="py-16 text-center opacity-60">
              <Car size={40} className="text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-bold text-gray-500">No drivers within {radiusKm} km</p>
              <p className="text-xs text-gray-400 font-medium mt-1">Try a larger radius{includeOffline ? '' : ' or include offline drivers'}.</p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {candidates.map((c) => {
                const busy = submittingId === c.driverId;
                const vehicle = [c.vehicleMake, c.vehicleModel, c.vehicleColor].filter(Boolean).join(' ') || c.vehicleType || '';
                const showForce = forceTarget === c.driverId;
                return (
                  <li key={c.driverId} className={`px-6 py-3 ${c.eligible ? '' : 'bg-gray-50/50'}`}>
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] font-bold text-gray-900">{c.name || 'Unnamed driver'}</span>
                          {c.isCurrentDriver && (
                            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-gray-900 text-white">CURRENT</span>
                          )}
                          <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded border ${c.isOnline ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                            {c.isOnline ? 'ONLINE' : 'OFFLINE'}
                          </span>
                          {c.isOnRide && (
                            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded border bg-blue-100 text-blue-700 border-blue-200">ON RIDE</span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500 font-medium">
                          {c.phone && <span className="flex items-center gap-1"><Phone size={11} /> {c.phone}</span>}
                          {vehicle && <span className="capitalize">{vehicle}</span>}
                          {c.vehicleNumber && <span className="font-mono font-bold text-gray-700 bg-yellow-100 px-1 rounded">{c.vehicleNumber}</span>}
                          {Number.isFinite(Number(c.rating)) && Number(c.rating) > 0 && (
                            <span className="flex items-center gap-0.5"><Star size={11} className="text-yellow-500" /> {Number(c.rating).toFixed(1)}</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-gray-600 font-semibold">
                          <span className="flex items-center gap-1"><MapPin size={11} /> {formatKm(c.distanceMeters)}</span>
                          {Number.isFinite(Number(c.etaMinutes)) && (
                            <span className="flex items-center gap-1"><Clock size={11} /> {c.etaMinutes} min <span className="text-gray-400 font-medium">(est.)</span></span>
                          )}
                        </div>
                        {!c.eligible && Array.isArray(c.reasonMessages) && c.reasonMessages.length > 0 && (
                          <ul className="mt-1.5 space-y-0.5">
                            {c.reasonMessages.map((msg, i) => (
                              <li key={i} className="text-[11px] font-medium text-red-600 flex items-start gap-1">
                                <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {msg}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="shrink-0 flex flex-col items-end gap-1">
                        {c.isCurrentDriver ? (
                          <span className="text-[10px] font-bold text-gray-400">Assigned</span>
                        ) : c.eligible ? (
                          <button
                            onClick={() => assign(c, false)}
                            disabled={Boolean(submittingId)}
                            className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-black bg-yellow-400 border border-yellow-500 rounded-lg hover:bg-yellow-500 disabled:opacity-50"
                          >
                            {busy ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
                            {isReassign ? 'Reassign' : 'Assign'}
                          </button>
                        ) : c.forceable ? (
                          <button
                            onClick={() => setForceTarget(showForce ? null : c.driverId)}
                            disabled={Boolean(submittingId)}
                            className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50"
                          >
                            <AlertTriangle size={12} /> Force assign
                          </button>
                        ) : (
                          <span className="text-[10px] font-bold text-gray-400">Not eligible</span>
                        )}
                      </div>
                    </div>

                    {showForce && (
                      <div className="mt-2 p-3 rounded-lg border border-red-200 bg-red-50">
                        <p className="text-[11px] font-bold text-red-700 flex items-center gap-1">
                          <AlertTriangle size={12} /> Force assignment overrides the checks above
                        </p>
                        <p className="text-[11px] text-red-600 font-medium mt-1">
                          This driver would normally not be offered this ride
                          {Array.isArray(c.reasonMessages) && c.reasonMessages.length > 0 ? ` (${c.reasonMessages.join('; ')})` : ''}.
                          They may be offline, short on wallet balance, or driving a different vehicle class. Make sure you have
                          confirmed with the driver before forcing.
                        </p>
                        <div className="mt-2 flex justify-end gap-2">
                          <button
                            onClick={() => setForceTarget(null)}
                            className="px-3 py-1 text-[11px] font-bold text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => assign(c, true)}
                            disabled={Boolean(submittingId)}
                            className="flex items-center gap-1 px-3 py-1 text-[11px] font-bold text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
                          >
                            {busy && <Loader2 size={12} className="animate-spin" />}
                            Yes, force {isReassign ? 'reassign' : 'assign'}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-6 py-3 bg-white flex items-center justify-between gap-3">
          <p className="text-[10px] text-gray-400 font-medium">
            ETA is a straight-line estimate, not a routed time.
            {meta?.requireVehicleApproval ? ' Vehicle approval is required for dispatch.' : ''}
          </p>
          <button onClick={onClose} className="px-5 py-2 text-sm font-bold text-white bg-black rounded-lg shadow-sm hover:bg-gray-900 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssignDriverModal;
