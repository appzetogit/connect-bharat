import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';

/**
 * Small modal that asks the admin for a reason (rejection, block, note...).
 * onConfirm(reason) may return a promise; the dialog stays open while it runs
 * and the caller closes it (via `open`) when done.
 */
const ReasonDialog = ({
  open,
  title = 'Add a reason',
  description = '',
  label = 'Reason',
  placeholder = 'Type the reason...',
  confirmLabel = 'Confirm',
  tone = 'danger',
  required = true,
  initialValue = '',
  busy = false,
  onConfirm,
  onClose,
}) => {
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initialValue || '');
      setTouched(false);
    }
  }, [open, initialValue]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;

  const trimmed = value.trim();
  const invalid = required && !trimmed;
  const confirmClass =
    tone === 'danger'
      ? 'bg-rose-600 text-white hover:bg-rose-700'
      : 'bg-yellow-400 text-black hover:bg-yellow-500';

  const handleSubmit = (event) => {
    event.preventDefault();
    setTouched(true);
    if (invalid || busy) return;
    onConfirm?.(trimmed);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={(event) => {
        event.stopPropagation();
        if (!busy) onClose?.();
      }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md space-y-4 rounded-2xl border border-gray-100 bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-gray-900">{title}</h3>
            {description ? <p className="mt-1 text-xs text-gray-500">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose?.()}
            className="text-gray-400 transition-colors hover:text-gray-900"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-semibold text-gray-500">
            {label}
            {required ? <span className="text-rose-500"> *</span> : <span className="text-gray-400"> (optional)</span>}
          </label>
          <textarea
            autoFocus
            rows={3}
            maxLength={500}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder={placeholder}
            className="w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none transition-colors focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400"
          />
          {touched && invalid ? <p className="mt-1 text-xs font-medium text-rose-600">A reason is required.</p> : null}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onClose?.()}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || invalid}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold shadow-sm transition-colors disabled:opacity-50 ${confirmClass}`}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};

export default ReasonDialog;
