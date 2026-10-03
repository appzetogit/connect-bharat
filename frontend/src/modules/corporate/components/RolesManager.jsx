import { useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Star } from 'lucide-react';
import {
  Badge, Button, Empty, ErrorNote, Field, Input, Loading, Modal, SERVICE_OPTIONS, Select, Table, formatMoney, useLoad,
} from './ui';
import { allowanceLabel } from './helpers';

/**
 * Role CRUD, shared by the corporate panel (Roles page, /corporate/roles) and
 * the admin corporate detail page (Roles tab, /admin/corporates/:id/roles).
 *
 * Roles are fully dynamic: the seeded set is only a starting point, and any
 * role can be renamed or deleted (employees are moved to a chosen role first).
 *
 * api = { list, create(body), update(id, body), remove(id, reassignToRoleId?), makeDefault(id), vehicleTypes() }
 * Every call resolves to the unwrapped `data` payload. Pass a stable object.
 */

const EMPTY_ROLE = {
  name: '',
  code: '',
  level: 10,
  active: true,
  allowance: { enabled: false, km: '', period: 'monthly' },
  allowedServices: [],
  allowedVehicleTypeIds: [],
  maxFarePerTrip: '',
  requireApprovalAlways: false,
  requireApprovalAbove: '',
  monthlySpendLimit: '',
};

const listOf = (data) => (Array.isArray(data) ? data : data?.results || data?.items || []);
const idOf = (value) => String(value?._id || value?.id || value || '');

const toForm = (role) => ({
  ...EMPTY_ROLE,
  name: role.name || '',
  code: role.code || '',
  level: role.level ?? 10,
  active: role.active !== false,
  allowance: {
    enabled: Boolean(role.allowance?.enabled),
    km: role.allowance?.km ?? '',
    period: role.allowance?.period || 'monthly',
  },
  allowedServices: role.allowedServices || [],
  allowedVehicleTypeIds: (role.allowedVehicleTypeIds || []).map(idOf),
  maxFarePerTrip: role.maxFarePerTrip ?? '',
  requireApprovalAlways: role.requireApprovalAlways === true,
  requireApprovalAbove: role.requireApprovalAbove ?? '',
  monthlySpendLimit: role.monthlySpendLimit || '',
});

const toBody = (form) => ({
  name: form.name.trim(),
  code: form.code.trim().toUpperCase(),
  level: Number(form.level) || 0,
  active: form.active,
  allowance: {
    enabled: form.allowance.enabled,
    km: Number(form.allowance.km) || 0,
    period: form.allowance.period,
  },
  allowedServices: form.allowedServices,
  allowedVehicleTypeIds: form.allowedVehicleTypeIds,
  maxFarePerTrip: form.maxFarePerTrip === '' ? null : Number(form.maxFarePerTrip),
  requireApprovalAlways: form.requireApprovalAlways || null,
  requireApprovalAbove: form.requireApprovalAbove === '' ? null : Number(form.requireApprovalAbove),
  monthlySpendLimit: Number(form.monthlySpendLimit) || 0,
});

const errorOf = (error, fallback = 'Something went wrong') => error?.response?.data?.message || error?.message || fallback;

const toggle = (list, value) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

export default function RolesManager({ api, canManage = true }) {
  const { data, loading, error, reload } = useLoad(() => api.list(), [api]);
  const { data: vehicleData } = useLoad(() => api.vehicleTypes().catch(() => []), [api]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_ROLE);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [reassignTo, setReassignTo] = useState('');

  const roles = [...listOf(data)].sort((a, b) => (b.level || 0) - (a.level || 0));
  const vehicles = listOf(vehicleData);
  const vehicleName = (id) => vehicles.find((vehicle) => idOf(vehicle) === idOf(id))?.name || 'Vehicle';

  const open = (role = null) => {
    setEditing(role || {});
    setForm(role ? toForm(role) : EMPTY_ROLE);
  };

  const save = async () => {
    if (!form.name.trim() || !form.code.trim()) {
      toast.error('Name and code are required');
      return;
    }
    if (form.allowance.enabled && !(Number(form.allowance.km) >= 0 && form.allowance.km !== '')) {
      toast.error('Enter the free km for the allowance');
      return;
    }
    setBusy(true);
    try {
      const id = editing?._id || editing?.id;
      if (id) await api.update(id, toBody(form));
      else await api.create(toBody(form));
      toast.success('Role saved');
      setEditing(null);
      reload();
    } catch (err) {
      toast.error(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (role) => {
    try {
      await api.makeDefault(role._id || role.id);
      toast.success(`${role.name} is now the default role`);
      reload();
    } catch (err) {
      toast.error(errorOf(err));
    }
  };

  const runDelete = async (role, reassignToRoleId = '') => {
    setBusy(true);
    try {
      await api.remove(role._id || role.id, reassignToRoleId || undefined);
      toast.success(reassignToRoleId ? 'Employees moved and role deleted' : 'Role deleted');
      setDeleting(null);
      reload();
    } catch (err) {
      if (err?.response?.status === 409) {
        if (role.isDefault) {
          toast.error(`${role.name} is the default role. Make another role the default first.`, { duration: 6000 });
          setDeleting(null);
        } else {
          // Employees still use it (the count may have changed since the list
          // loaded): ask where to move them.
          setDeleting({ role, needsReassign: true });
          toast.error(err?.response?.data?.message || `${role.name} still has employees. Choose a role to move them to.`, { duration: 6000 });
        }
      } else {
        toast.error(errorOf(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = (role) => {
    const fallback = roles.find((item) => item.isDefault && idOf(item) !== idOf(role));
    setReassignTo(fallback ? idOf(fallback) : '');
    setDeleting({ role, needsReassign: Number(role.employeeCount) > 0 });
  };

  return (
    <>
      {canManage && (
        <div className="flex justify-end mb-3">
          <Button onClick={() => open()}><Plus size={14} /> Add role</Button>
        </div>
      )}
      <ErrorNote message={error} />
      {loading ? <Loading /> : !roles.length ? (
        <Empty title="No roles yet." hint="Roles set each group's free km allowance and travel rules." />
      ) : (
        <Table
          rowKey={(row) => row._id || row.id}
          columns={[
            {
              key: 'name',
              label: 'Role',
              render: (row) => (
                <div>
                  <p className="font-medium text-gray-900 flex items-center gap-2">
                    {row.name}
                    {row.isDefault && <span className="text-[10px] font-semibold uppercase tracking-wide bg-gray-900 text-white rounded px-1.5 py-0.5">Default</span>}
                  </p>
                  <p className="text-xs text-gray-500">{row.code} · level {row.level ?? 0}</p>
                </div>
              ),
            },
            { key: 'employeeCount', label: 'Employees', align: 'right', render: (row) => row.employeeCount ?? 0 },
            { key: 'allowance', label: 'Km allowance', render: (row) => allowanceLabel(row.allowance) },
            {
              key: 'rules',
              label: 'Travel rules',
              render: (row) => (
                <div className="text-xs text-gray-600 space-y-0.5 max-w-xs">
                  <p>Services: {row.allowedServices?.length ? row.allowedServices.map((value) => SERVICE_OPTIONS.find((option) => option.value === value)?.label || value).join(', ') : 'inherit'}</p>
                  {row.allowedVehicleTypeIds?.length > 0 && <p>Vehicles: {row.allowedVehicleTypeIds.map(vehicleName).join(', ')}</p>}
                  {row.maxFarePerTrip != null && <p>Max fare {formatMoney(row.maxFarePerTrip)}</p>}
                  {row.requireApprovalAlways && <p>Every trip needs approval</p>}
                  {row.requireApprovalAbove != null && <p>Approval above {formatMoney(row.requireApprovalAbove)}</p>}
                  {row.monthlySpendLimit > 0 && <p>Monthly cap {formatMoney(row.monthlySpendLimit)}</p>}
                </div>
              ),
            },
            { key: 'status', label: 'Status', render: (row) => <Badge value={row.active === false ? 'inactive' : 'active'} /> },
            {
              key: 'actions',
              label: '',
              render: (row) => canManage && (
                <div className="flex gap-2 justify-end">
                  <Button variant="secondary" onClick={() => open(row)}>Edit</Button>
                  {!row.isDefault && <Button variant="secondary" onClick={() => makeDefault(row)} title="New employees get this role"><Star size={14} /> Default</Button>}
                  <Button
                    variant="danger"
                    disabled={row.isDefault}
                    title={row.isDefault ? 'The default role cannot be deleted' : undefined}
                    onClick={() => remove(row)}
                  >
                    Delete
                  </Button>
                </div>
              ),
            },
          ]}
          rows={roles}
        />
      )}

      <Modal
        open={Boolean(editing)}
        title={editing?._id || editing?.id ? `Edit ${editing.name}` : 'Add role'}
        onClose={() => setEditing(null)}
        wide
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button busy={busy} onClick={save}>Save</Button></>}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Any name" /></Field>
          <Field label="Code" hint="Short and unique; the roleCode column in CSV imports"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="e.g. TL" /></Field>
          <Field label="Level" hint="Higher = more senior"><Input type="number" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} /></Field>
        </div>

        <div className="border border-gray-200 rounded-lg p-3 space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={form.allowance.enabled} onChange={(e) => setForm({ ...form, allowance: { ...form.allowance, enabled: e.target.checked } })} />
            Free km allowance
          </label>
          <p className="text-xs text-gray-500">
            {form.allowance.enabled
              ? 'The company pays for trips up to this many km per period. Beyond it, the employee pays the excess share of the fare.'
              : 'Off: no km limit, the company pays every km.'}
          </p>
          {form.allowance.enabled && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Free km"><Input type="number" min="0" step="0.1" value={form.allowance.km} onChange={(e) => setForm({ ...form, allowance: { ...form.allowance, km: e.target.value } })} /></Field>
              <Field label="Per">
                <Select value={form.allowance.period} onChange={(e) => setForm({ ...form, allowance: { ...form.allowance, period: e.target.value } })}>
                  <option value="monthly">Month</option>
                  <option value="weekly">Week (Mon–Sun)</option>
                </Select>
              </Field>
            </div>
          )}
        </div>

        <Field label="Allowed services" hint="None ticked = inherit from department / company policy">
          <div className="flex flex-wrap gap-3 text-sm">
            {SERVICE_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-1.5">
                <input type="checkbox" checked={form.allowedServices.includes(option.value)} onChange={() => setForm({ ...form, allowedServices: toggle(form.allowedServices, option.value) })} /> {option.label}
              </label>
            ))}
          </div>
        </Field>

        <Field label="Allowed vehicle types" hint="None ticked = inherit">
          {vehicles.length ? (
            <div className="flex flex-wrap gap-3 text-sm">
              {vehicles.map((vehicle) => (
                <label key={idOf(vehicle)} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={form.allowedVehicleTypeIds.includes(idOf(vehicle))} onChange={() => setForm({ ...form, allowedVehicleTypeIds: toggle(form.allowedVehicleTypeIds, idOf(vehicle)) })} /> {vehicle.name}
                </label>
              ))}
            </div>
          ) : <p className="text-xs text-gray-400">Vehicle list unavailable.</p>}
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Max fare per trip (₹)" hint="Blank = inherit"><Input type="number" min="0" value={form.maxFarePerTrip} onChange={(e) => setForm({ ...form, maxFarePerTrip: e.target.value })} /></Field>
          <Field label="Approval needed above (₹)" hint="Blank = inherit; 0 = every trip"><Input type="number" min="0" value={form.requireApprovalAbove} onChange={(e) => setForm({ ...form, requireApprovalAbove: e.target.value })} /></Field>
          <Field label="Monthly spend limit (₹)" hint="Company-paid amount; blank = none"><Input type="number" min="0" value={form.monthlySpendLimit} onChange={(e) => setForm({ ...form, monthlySpendLimit: e.target.value })} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requireApprovalAlways} onChange={(e) => setForm({ ...form, requireApprovalAlways: e.target.checked })} /> Every trip needs approval</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        title={deleting ? `Delete ${deleting.role.name}?` : ''}
        onClose={() => setDeleting(null)}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              busy={busy}
              disabled={deleting?.needsReassign && !reassignTo}
              onClick={() => runDelete(deleting.role, deleting.needsReassign ? reassignTo : '')}
            >
              {deleting?.needsReassign ? 'Move employees and delete' : 'Delete role'}
            </Button>
          </>
        )}
      >
        {deleting && (deleting.needsReassign ? (
          <>
            <p className="text-sm text-gray-600">
              {Number(deleting.role.employeeCount) > 0
                ? `${deleting.role.employeeCount} employee${Number(deleting.role.employeeCount) === 1 ? ' has' : 's have'} this role.`
                : 'Some employees still have this role.'}
              {' '}Move them to another role before it is deleted. Their allowance for the current period follows the new role.
            </p>
            <Field label="Move employees to">
              <Select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                <option value="">Choose a role</option>
                {roles.filter((item) => idOf(item) !== idOf(deleting.role) && item.active !== false).map((item) => (
                  <option key={idOf(item)} value={idOf(item)}>{item.name} ({item.code}){item.isDefault ? ' · default' : ''}</option>
                ))}
              </Select>
            </Field>
          </>
        ) : (
          <p className="text-sm text-gray-600">No employees have this role. It will be removed permanently.</p>
        ))}
      </Modal>
    </>
  );
}
