import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, FileText, Loader2, RefreshCw, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { operationsApi, unwrap } from '../../services/operationsApi';
import { adminService } from '../../services/adminService';
import { getDocumentPreviewUrl } from '../../../driver/utils/documentTemplates';
import ReasonDialog from './ReasonDialog';
import { formatReviewDate, getApiErrorMessage, humanizeDocumentKey } from './approvalUtils';

const STATUS_STYLES = {
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  rejected: 'bg-rose-50 text-rose-700 border-rose-100',
  pending: 'bg-amber-50 text-amber-700 border-amber-100',
  missing: 'bg-gray-100 text-gray-500 border-gray-200',
};

const isPdfUrl = (url = '') => /\.pdf($|\?)/i.test(String(url));

const StatusChip = ({ status }) => (
  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLES[status] || STATUS_STYLES.pending}`}>
    {status === 'approved' ? <CheckCircle2 size={11} /> : null}
    {status === 'rejected' ? <XCircle size={11} /> : null}
    {status}
  </span>
);

const collectPreviewUrls = (value) => {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  const urls = [
    ...(Array.isArray(value.images) ? value.images : []),
    getDocumentPreviewUrl(value),
  ]
    .map((item) => (typeof item === 'string' ? item : getDocumentPreviewUrl(item)))
    .filter(Boolean);
  return urls.filter((url, index) => urls.indexOf(url) === index);
};

/**
 * Per-document review for a driver: loads GET /admin/drivers/:id/documents/review,
 * shows each required + other document with a preview, a status chip and
 * Approve / Reject (with reason) actions.
 *
 * Props:
 * - driverId (required)
 * - documents: the driver's `documents` map (for preview URLs). Fetched when omitted.
 * - labels: optional { [documentKey]: label }
 * - onReviewChange(review): called whenever the review summary is (re)loaded
 */
const DocumentReviewPanel = ({ driverId, documents, labels = {}, onReviewChange }) => {
  const [review, setReview] = useState(null);
  const [fetchedDocuments, setFetchedDocuments] = useState(null);
  const [documentOverrides, setDocumentOverrides] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [rejecting, setRejecting] = useState(null); // { key, label, initialValue }

  const loadReview = useCallback(async () => {
    if (!driverId) return;
    setError('');
    try {
      const [reviewResponse, driverResponse] = await Promise.all([
        operationsApi.getDriverDocumentReview(driverId),
        documents === undefined ? adminService.getDriver(driverId) : Promise.resolve(null),
      ]);
      const nextReview = unwrap(reviewResponse);
      setReview(nextReview);
      if (driverResponse) {
        const driverData = unwrap(driverResponse);
        setFetchedDocuments(driverData?.documents || {});
      }
      onReviewChange?.(nextReview);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to load document review'));
    } finally {
      setIsLoading(false);
    }
    // onReviewChange is intentionally left out so an inline callback doesn't refetch on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverId, documents === undefined]);

  useEffect(() => {
    setIsLoading(true);
    setDocumentOverrides({});
    loadReview();
  }, [loadReview]);

  const documentMap = useMemo(
    () => ({ ...(documents || fetchedDocuments || {}), ...documentOverrides }),
    [documents, fetchedDocuments, documentOverrides],
  );

  const rows = useMemo(() => {
    if (!review) return [];
    const toRow = (entry, required) => {
      const status = !entry.uploaded ? 'missing' : entry.reviewStatus || 'pending';
      return {
        key: entry.key,
        label: labels[entry.key] || humanizeDocumentKey(entry.key),
        required,
        uploaded: Boolean(entry.uploaded),
        status,
        reason: entry.reviewReason || documentMap[entry.key]?.reviewReason || '',
        reviewedAt: documentMap[entry.key]?.reviewedAt || entry.reviewedAt || null,
        previews: collectPreviewUrls(documentMap[entry.key]),
      };
    };
    return [
      ...(review.required || []).map((entry) => toRow(entry, true)),
      ...(review.others || []).map((entry) => toRow(entry, false)),
    ];
  }, [review, labels, documentMap]);

  const requiredRows = rows.filter((row) => row.required);
  const approvedRequired = requiredRows.filter((row) => row.status === 'approved').length;

  const submitReview = async (key, status, reason = '') => {
    setBusyKey(key);
    try {
      const response = await operationsApi.reviewDriverDocument(driverId, key, status, reason);
      const data = unwrap(response);
      if (data?.document) {
        setDocumentOverrides((current) => ({ ...current, [key]: data.document }));
      }
      toast.success(status === 'approved' ? 'Document approved' : 'Document rejected');
      setRejecting(null);
      await loadReview();
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Failed to update document'));
    } finally {
      setBusyKey('');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-500">
        <Loader2 size={14} className="animate-spin" /> Loading documents...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-100 bg-rose-50 p-4 text-xs font-semibold text-rose-600">
        <span className="flex items-center gap-2"><AlertCircle size={14} /> {error}</span>
        <button type="button" onClick={() => { setIsLoading(true); loadReview(); }} className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-gray-700 border border-gray-200">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="text-sm font-bold text-gray-900">Document review</h4>
          <p className="text-xs text-gray-500">
            {approvedRequired} of {requiredRows.length} required documents approved
            {review?.missing?.length ? ` · ${review.missing.length} missing` : ''}
            {review?.rejected?.length ? ` · ${review.rejected.length} rejected` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadReview()}
          className="inline-flex items-center gap-1.5 self-start rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {review?.requireVerifiedDocumentsForApproval ? (
        <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          Every required document must be approved before this driver can be approved.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="p-4 text-center text-xs text-gray-400">No documents configured or uploaded.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                {row.previews[0] && !isPdfUrl(row.previews[0]) ? (
                  <a href={row.previews[0]} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={row.previews[0]} alt={row.label} className="h-10 w-14 rounded border border-gray-200 object-cover" />
                  </a>
                ) : (
                  <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 text-gray-400">
                    <FileText size={16} />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900">{row.label}</span>
                    {row.required ? (
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Required</span>
                    ) : null}
                    <StatusChip status={row.status} />
                  </div>
                  {row.status === 'rejected' && row.reason ? (
                    <p className="mt-0.5 text-xs text-rose-600">Reason: {row.reason}</p>
                  ) : null}
                  <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-gray-400">
                    {row.previews.map((url, index) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline">
                        <ExternalLink size={11} /> {row.previews.length > 1 ? `View ${index + 1}` : 'View'}
                      </a>
                    ))}
                    {row.reviewedAt && row.status !== 'pending' && row.status !== 'missing' ? (
                      <span>Reviewed {formatReviewDate(row.reviewedAt)}</span>
                    ) : null}
                  </div>
                </div>
              </div>

              {row.uploaded ? (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={Boolean(busyKey) || row.status === 'approved'}
                    onClick={() => submitReview(row.key, 'approved')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition-all hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyKey === row.key ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busyKey)}
                    onClick={() => setRejecting({ key: row.key, label: row.label, initialValue: row.status === 'rejected' ? row.reason : '' })}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-all hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <XCircle size={13} />
                    Reject
                  </button>
                </div>
              ) : (
                <span className="text-xs font-medium text-gray-400">Not uploaded</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <ReasonDialog
        open={Boolean(rejecting)}
        title={`Reject ${rejecting?.label || 'document'}`}
        description="The driver is notified with this reason and can upload the document again."
        placeholder="e.g. Photo is blurred"
        confirmLabel="Reject document"
        initialValue={rejecting?.initialValue || ''}
        busy={Boolean(busyKey)}
        onClose={() => setRejecting(null)}
        onConfirm={(reason) => submitReview(rejecting.key, 'rejected', reason)}
      />
    </div>
  );
};

export default DocumentReviewPanel;
