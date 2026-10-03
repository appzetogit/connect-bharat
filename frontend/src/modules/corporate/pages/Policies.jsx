import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import { corporateApi, errorMessage } from '../services/corporateApi';
import { Button, Card, ErrorNote, Field, Input, Loading, PageHeader, SERVICE_OPTIONS, Select, useLoad } from '../components/ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const toForm = (policy = {}) => ({
  allowedServices: policy.allowedServices || [],
  allowedHours: policy.allowedHours || [],
  outsideHoursAction: policy.outsideHoursAction || '',
  maxFarePerTrip: policy.maxFarePerTrip ?? '',
  overMaxFareAction: policy.overMaxFareAction || '',
  requireApprovalAbove: policy.requireApprovalAbove ?? '',
  requireApprovalAlways: policy.requireApprovalAlways === true,
});

const toBody = (form) => ({
  ...form,
  outsideHoursAction: form.outsideHoursAction || null,
  overMaxFareAction: form.overMaxFareAction || null,
  maxFarePerTrip: form.maxFarePerTrip === '' ? null : Number(form.maxFarePerTrip),
  requireApprovalAbove: form.requireApprovalAbove === '' ? null : Number(form.requireApprovalAbove),
  requireApprovalAlways: form.requireApprovalAlways || null,
});

function PolicyEditor({ title, subtitle, policy, onSave, onDelete, readOnly, inheritLabel }) {
  const [form, setForm] = useState(toForm(policy));
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(toForm(policy)), [policy]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave(toBody(form));
      toast.success('Policy saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const setWindow = (index, patch) =>
    setForm((previous) => ({ ...previous, allowedHours: previous.allowedHours.map((window, i) => (i === index ? { ...window, ...patch } : window)) }));

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-900">{title}</h2>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {onDelete && !readOnly && <Button variant="secondary" onClick={onDelete}><Trash2 size={14} /> Remove</Button>}
      </div>

      <Field label="Allowed services" hint={`None ticked = ${inheritLabel}`}>
        <div className="flex flex-wrap gap-3 text-sm">
          {SERVICE_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                disabled={readOnly}
                checked={form.allowedServices.includes(option.value)}
                onChange={() => setForm((previous) => ({
                  ...previous,
                  allowedServices: previous.allowedServices.includes(option.value)
                    ? previous.allowedServices.filter((item) => item !== option.value)
                    : [...previous.allowedServices, option.value],
                }))}
              />
              {option.label}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Allowed travel hours (IST)" hint={`No windows = ${inheritLabel}`}>
        <div className="space-y-2">
          {form.allowedHours.map((window, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
              {DAYS.map((day, dayIndex) => (
                <label key={day} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={(window.days || []).includes(dayIndex)}
                    onChange={() => setWindow(index, { days: (window.days || []).includes(dayIndex) ? window.days.filter((d) => d !== dayIndex) : [...(window.days || []), dayIndex] })}
                  />
                  {day}
                </label>
              ))}
              <input type="time" disabled={readOnly} className="border border-gray-200 rounded px-2 py-1" value={window.start} onChange={(e) => setWindow(index, { start: e.target.value })} />
              <span>to</span>
              <input type="time" disabled={readOnly} className="border border-gray-200 rounded px-2 py-1" value={window.end} onChange={(e) => setWindow(index, { end: e.target.value })} />
              {!readOnly && <button type="button" className="text-red-600 text-xs" onClick={() => setForm((previous) => ({ ...previous, allowedHours: previous.allowedHours.filter((_, i) => i !== index) }))}>remove</button>}
            </div>
          ))}
          {!readOnly && (
            <Button variant="secondary" onClick={() => setForm((previous) => ({ ...previous, allowedHours: [...previous.allowedHours, { days: [1, 2, 3, 4, 5], start: '08:00', end: '21:00' }] }))}>
              <Plus size={14} /> Add window
            </Button>
          )}
        </div>
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Outside those hours">
          <Select disabled={readOnly} value={form.outsideHoursAction} onChange={(e) => setForm({ ...form, outsideHoursAction: e.target.value })}>
            <option value="">{inheritLabel === 'inherit company policy' ? 'Inherit' : 'Needs approval'}</option>
            <option value="approval">Needs approval</option>
            <option value="block">Not allowed</option>
          </Select>
        </Field>
        <Field label="Max fare per trip (₹)" hint="Blank = no cap">
          <Input disabled={readOnly} type="number" min="0" value={form.maxFarePerTrip} onChange={(e) => setForm({ ...form, maxFarePerTrip: e.target.value })} />
        </Field>
        <Field label="Above the max fare">
          <Select disabled={readOnly} value={form.overMaxFareAction} onChange={(e) => setForm({ ...form, overMaxFareAction: e.target.value })}>
            <option value="">{inheritLabel === 'inherit company policy' ? 'Inherit' : 'Not allowed'}</option>
            <option value="block">Not allowed</option>
            <option value="approval">Needs approval</option>
          </Select>
        </Field>
        <Field label="Approval needed above (₹)" hint="Blank = not on fare alone; 0 = every trip">
          <Input disabled={readOnly} type="number" min="0" value={form.requireApprovalAbove} onChange={(e) => setForm({ ...form, requireApprovalAbove: e.target.value })} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={readOnly} checked={form.requireApprovalAlways} onChange={(e) => setForm({ ...form, requireApprovalAlways: e.target.checked })} />
        Every trip needs approval
      </label>
      {!readOnly && <div className="flex justify-end"><Button busy={busy} onClick={save}>Save policy</Button></div>}
    </Card>
  );
}

export default function CorporatePolicies() {
  const { session } = useOutletContext() || {};
  const readOnly = !['owner', 'admin'].includes(session?.admin?.role);
  const { data: policies, loading, error, reload } = useLoad(() => corporateApi.policies(), []);
  const { data: departments } = useLoad(() => corporateApi.departments(), []);
  const [newDepartmentId, setNewDepartmentId] = useState('');

  if (loading) return <Loading />;

  const companyPolicy = (policies || []).find((policy) => !policy.departmentId);
  const departmentPolicies = (policies || []).filter((policy) => policy.departmentId);
  const withoutPolicy = (departments || []).filter((department) => !departmentPolicies.some((policy) => String(policy.departmentId?._id || policy.departmentId) === department._id));

  return (
    <>
      <PageHeader title="Travel policies" subtitle="The company policy applies to everyone; a department policy overrides it only where it sets something." />
      <ErrorNote message={error} />
      <div className="space-y-4">
        <PolicyEditor
          title="Company policy"
          policy={companyPolicy}
          readOnly={readOnly}
          inheritLabel="anything"
          onSave={async (body) => { await corporateApi.saveCompanyPolicy(body); reload(); }}
        />
        {departmentPolicies.map((policy) => (
          <PolicyEditor
            key={policy._id}
            title={`${policy.departmentId?.name || 'Department'} policy`}
            subtitle="Overrides the company policy where set"
            policy={policy}
            readOnly={readOnly}
            inheritLabel="inherit company policy"
            onSave={async (body) => { await corporateApi.saveDepartmentPolicy(policy.departmentId?._id || policy.departmentId, body); reload(); }}
            onDelete={async () => { await corporateApi.deletePolicy(policy._id); reload(); }}
          />
        ))}
        {!readOnly && withoutPolicy.length > 0 && (
          <Card className="p-4 flex flex-wrap items-end gap-3">
            <div className="w-64">
              <Field label="Add a department policy">
                <Select value={newDepartmentId} onChange={(e) => setNewDepartmentId(e.target.value)}>
                  <option value="">Choose department</option>
                  {withoutPolicy.map((department) => <option key={department._id} value={department._id}>{department.name}</option>)}
                </Select>
              </Field>
            </div>
            <Button
              disabled={!newDepartmentId}
              onClick={async () => {
                try {
                  await corporateApi.saveDepartmentPolicy(newDepartmentId, { name: '' });
                  setNewDepartmentId('');
                  reload();
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            >
              <Plus size={14} /> Add
            </Button>
          </Card>
        )}
      </div>
    </>
  );
}
