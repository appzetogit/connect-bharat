/** Shared bits for the admin corporate pages. */

export const formatMoney = (value) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '-' : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const PILL = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-emerald-100 text-emerald-800',
  paid: 'bg-emerald-100 text-emerald-800',
  issued: 'bg-blue-100 text-blue-800',
  partially_paid: 'bg-blue-100 text-blue-800',
  overdue: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
  suspended: 'bg-red-100 text-red-800',
  draft: 'bg-gray-100 text-gray-600',
  void: 'bg-gray-100 text-gray-500',
};

export const StatusPill = ({ value }) => (
  <span className={`inline-block text-xs font-semibold rounded-full px-2.5 py-0.5 ${PILL[value] || 'bg-gray-100 text-gray-700'}`}>
    {String(value || '-').replace(/_/g, ' ')}
  </span>
);

export const inputClass = 'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white';

export const Field = ({ label, hint, children }) => (
  <label className="block">
    <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
    {children}
    {hint && <span className="block text-xs text-gray-400 mt-1">{hint}</span>}
  </label>
);

export const SERVICES = [
  { value: 'ride', label: 'Ride' },
  { value: 'parcel', label: 'Parcel' },
  { value: 'intercity', label: 'Outstation' },
  { value: 'rental', label: 'Rental' },
];

/** Credit, terms and discount inputs, shared by create, approve and edit. */
export const TermsFields = ({ value, onChange }) => {
  const set = (patch) => onChange({ ...value, ...patch });
  const discount = value.discount || { type: 'percentage', value: 0, maxPerTrip: 0, appliesTo: SERVICES.map((item) => item.value) };
  const setDiscount = (patch) => set({ discount: { ...discount, ...patch } });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Field label="Credit limit (₹)" hint="0 = no corporate billing">
        <input type="number" min="0" className={inputClass} value={value.creditLimit ?? ''} onChange={(e) => set({ creditLimit: e.target.value })} />
      </Field>
      <Field label="Payment terms (days)">
        <input type="number" min="0" className={inputClass} value={value.paymentTermsDays ?? 30} onChange={(e) => set({ paymentTermsDays: e.target.value })} />
      </Field>
      <Field label="Credit grace (%)" hint="Blank = global setting">
        <input type="number" min="0" className={inputClass} value={value.creditGracePercent ?? ''} onChange={(e) => set({ creditGracePercent: e.target.value === '' ? null : e.target.value })} />
      </Field>
      <Field label="Discount type">
        <select className={inputClass} value={discount.type} onChange={(e) => setDiscount({ type: e.target.value })}>
          <option value="percentage">Percentage</option>
          <option value="flat">Flat per trip</option>
        </select>
      </Field>
      <Field label={discount.type === 'flat' ? 'Discount (₹ per trip)' : 'Discount (%)'}>
        <input type="number" min="0" className={inputClass} value={discount.value ?? 0} onChange={(e) => setDiscount({ value: e.target.value })} />
      </Field>
      <Field label="Max discount per trip (₹)" hint="Percentage only; 0 = no cap">
        <input type="number" min="0" className={inputClass} value={discount.maxPerTrip ?? 0} onChange={(e) => setDiscount({ maxPerTrip: e.target.value })} />
      </Field>
      <Field label="Discount applies to">
        <div className="flex flex-wrap gap-3 text-sm pt-1">
          {SERVICES.map((service) => (
            <label key={service.value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={(discount.appliesTo || []).includes(service.value)}
                onChange={() => setDiscount({
                  appliesTo: (discount.appliesTo || []).includes(service.value)
                    ? discount.appliesTo.filter((item) => item !== service.value)
                    : [...(discount.appliesTo || []), service.value],
                })}
              />
              {service.label}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Allowed services" hint="None ticked = all">
        <div className="flex flex-wrap gap-3 text-sm pt-1">
          {SERVICES.map((service) => (
            <label key={service.value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={(value.allowedServices || []).includes(service.value)}
                onChange={() => set({
                  allowedServices: (value.allowedServices || []).includes(service.value)
                    ? value.allowedServices.filter((item) => item !== service.value)
                    : [...(value.allowedServices || []), service.value],
                })}
              />
              {service.label}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Approval expiry (minutes)" hint="Blank = global setting">
        <input type="number" min="1" className={inputClass} value={value.approvalExpiryMinutes ?? ''} onChange={(e) => set({ approvalExpiryMinutes: e.target.value === '' ? null : e.target.value })} />
      </Field>
    </div>
  );
};

export const termsPayload = (value) => ({
  creditLimit: Number(value.creditLimit) || 0,
  paymentTermsDays: Number(value.paymentTermsDays ?? 30),
  creditGracePercent: value.creditGracePercent === null || value.creditGracePercent === '' || value.creditGracePercent === undefined ? null : Number(value.creditGracePercent),
  approvalExpiryMinutes: value.approvalExpiryMinutes === null || value.approvalExpiryMinutes === '' || value.approvalExpiryMinutes === undefined ? null : Number(value.approvalExpiryMinutes),
  allowedServices: value.allowedServices || [],
  ...(value.discount
    ? {
        discount: {
          type: value.discount.type,
          value: Number(value.discount.value) || 0,
          maxPerTrip: Number(value.discount.maxPerTrip) || 0,
          appliesTo: value.discount.appliesTo || [],
        },
      }
    : {}),
});
