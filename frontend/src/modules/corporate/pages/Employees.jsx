import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Download, Gauge, Plus, Upload } from 'lucide-react';
import { corporateApi, downloadFile, errorMessage } from '../services/corporateApi';
import {
  Badge, Button, Card, Drawer, Empty, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pager, SERVICE_OPTIONS, Select, Table, formatDate, formatMoney, useLoad,
} from '../components/ui';
import { allowanceLabel, formatKm } from '../components/helpers';
import ChangeRoleModal from '../components/ChangeRoleModal';

const EMPTY_FORM = { name: '', phone: '', email: '', employeeCode: '', designation: '', departmentId: '', roleId: '', monthlyLimit: '', requiresApproval: false, allowedServices: [], sendInvite: true };

const idOf = (value) => String(value?._id || value?.id || value || '');

const periodLabel = (period) => (period === 'weekly' ? 'week' : 'month');

/** used / allowance km for one usage row (employee list or allowance history). */
function AllowanceCell({ usage, role }) {
  const enabled = role ? role.allowance?.enabled : Number(usage?.allowanceKm) > 0;
  if (!enabled || !usage) return <span className="text-gray-400 text-xs">{role ? 'No km limit' : '-'}</span>;
  const allowanceKm = Number(usage.allowanceKm) || 0;
  const usedKm = Number(usage.usedKm) || 0;
  const reservedKm = Number(usage.reservedKm) || 0;
  const percent = allowanceKm > 0 ? Math.min(100, ((usedKm + reservedKm) / allowanceKm) * 100) : 100;
  return (
    <div className="min-w-[9rem]">
      <p className="tabular-nums text-sm">{formatKm(usedKm)} <span className="text-gray-400">/ {formatKm(allowanceKm)}</span></p>
      <div className="h-1.5 bg-gray-100 rounded-full mt-1 overflow-hidden"><div className={`h-full ${percent >= 100 ? 'bg-red-500' : 'bg-gray-900'}`} style={{ width: `${percent}%` }} /></div>
      <p className="text-xs text-gray-500 mt-1">{formatKm(usage.remainingKm)} left · {usage.periodKey}{reservedKm > 0 ? ` · ${formatKm(reservedKm)} reserved` : ''}</p>
    </div>
  );
}

function AllowanceDrawer({ employee, role, onClose }) {
  const { data, loading, error } = useLoad(() => corporateApi.employeeAllowance(employee._id, 6), [employee._id]);
  const current = data?.current;
  const history = (data?.history || []).filter((row) => !current || row.periodKey !== current.periodKey);
  return (
    <Drawer open title={`${employee.name} · km allowance`} subtitle={`${employee.employeeCode || ''}${role ? ` · ${role.name} · ${allowanceLabel(role.allowance)}` : ''}`} onClose={onClose}>
      <ErrorNote message={error} />
      {loading ? <Loading /> : (
        <>
          {current ? (
            <Card className="p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">This {periodLabel(current.period)} · {current.periodKey}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2 text-sm">
                <div><p className="text-xs text-gray-500">Allowance</p><p className="font-semibold tabular-nums">{formatKm(current.allowanceKm)}</p></div>
                <div><p className="text-xs text-gray-500">Used</p><p className="font-semibold tabular-nums">{formatKm(current.usedKm)}</p></div>
                <div><p className="text-xs text-gray-500">Reserved</p><p className="font-semibold tabular-nums">{formatKm(current.reservedKm)}</p></div>
                <div><p className="text-xs text-gray-500">Remaining</p><p className="font-semibold tabular-nums">{formatKm(current.remainingKm ?? Math.max(0, (current.allowanceKm || 0) - (current.usedKm || 0) - (current.reservedKm || 0)))}</p></div>
              </div>
              <p className="text-xs text-gray-400 mt-2">{current.rides || 0} trips this period. Reserved km belong to trips booked but not finished yet.</p>
            </Card>
          ) : <Empty title="No company-billed trips this period yet." />}
          <h3 className="text-sm font-semibold text-gray-900">Earlier periods</h3>
          {!history.length ? <p className="text-sm text-gray-500">No earlier usage.</p> : (
            <Table
              rowKey={(row) => row.periodKey}
              columns={[
                { key: 'periodKey', label: 'Period', render: (row) => <div><p className="font-medium">{row.periodKey}</p><p className="text-xs text-gray-500">{row.period}</p></div> },
                { key: 'allowanceKm', label: 'Allowance', align: 'right', render: (row) => formatKm(row.allowanceKm) },
                { key: 'usedKm', label: 'Used', align: 'right', render: (row) => formatKm(row.usedKm) },
                { key: 'remaining', label: 'Unused', align: 'right', render: (row) => formatKm(Math.max(0, (row.allowanceKm || 0) - (row.usedKm || 0))) },
                { key: 'rides', label: 'Trips', align: 'right', render: (row) => row.rides || 0 },
                { key: 'updatedAt', label: 'Last trip', render: (row) => formatDate(row.updatedAt) },
              ]}
              rows={history}
            />
          )}
        </>
      )}
    </Drawer>
  );
}

const readFileAsBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export default function CorporateEmployees() {
  const { session } = useOutletContext() || {};
  const canManage = ['owner', 'admin'].includes(session?.admin?.role);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('true');
  const [roleId, setRoleId] = useState('');
  const [allowanceFor, setAllowanceFor] = useState(null);
  const [selected, setSelected] = useState([]);
  const [changingRole, setChangingRole] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, reload } = useLoad(
    () => corporateApi.employees({ page, search, active, roleId: roleId || undefined, limit: 25 }),
    [page, search, active, roleId],
  );
  const { data: departments } = useLoad(() => corporateApi.departments(), []);
  const { data: rolesData } = useLoad(() => corporateApi.roles(), []);
  const roles = [...(rolesData?.results || [])].sort((a, b) => (b.level || 0) - (a.level || 0));
  const defaultRole = roles.find((role) => role.isDefault);
  const roleFor = (employee) => roles.find((role) => idOf(role) === idOf(employee.role || employee.roleId)) || (employee.role ? null : defaultRole) || null;

  const openForm = (employee = null) => {
    setEditing(employee || {});
    setForm(employee
      ? {
          ...EMPTY_FORM,
          name: employee.name || '',
          phone: employee.phone || '',
          email: employee.email || '',
          employeeCode: employee.employeeCode || '',
          designation: employee.designation || '',
          departmentId: employee.departmentId?._id || employee.departmentId || '',
          roleId: idOf(employee.role || employee.roleId),
          monthlyLimit: employee.monthlyLimit || '',
          requiresApproval: Boolean(employee.requiresApproval),
          allowedServices: employee.allowedServices || [],
          sendInvite: false,
        }
      : EMPTY_FORM);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        ...form,
        employeeCode: form.employeeCode.trim(),
        monthlyLimit: Number(form.monthlyLimit) || 0,
        departmentId: form.departmentId || null,
        roleId: form.roleId || null,
      };
      if (editing?._id) delete body.sendInvite;
      if (editing?._id) await corporateApi.updateEmployee(editing._id, body);
      else await corporateApi.createEmployee(body);
      toast.success('Saved');
      setEditing(null);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn, message) => {
    try {
      await fn();
      toast.success(message);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const runImport = async () => {
    if (!importFile) return;
    setBusy(true);
    try {
      const fileBase64 = await readFileAsBase64(importFile);
      const result = await corporateApi.importEmployees({ fileBase64, fileName: importFile.name, createDepartments: true, sendInvites: false });
      setImportResult(result);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pageIds = (data?.items || []).map((row) => row._id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const toggleSelected = (id) => setSelected((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]));
  const togglePage = () => setSelected((previous) => (allOnPage ? previous.filter((id) => !pageIds.includes(id)) : [...new Set([...previous, ...pageIds])]));

  const assignRole = async (newRoleId) => {
    try {
      await corporateApi.assignRole(newRoleId, selected);
      const role = roles.find((item) => idOf(item) === newRoleId);
      toast.success(`${selected.length} employee${selected.length === 1 ? '' : 's'} moved to ${role?.name || 'the new role'}`);
      setSelected([]);
      setChangingRole(false);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const toggleService = (value) =>
    setForm((previous) => ({
      ...previous,
      allowedServices: previous.allowedServices.includes(value)
        ? previous.allowedServices.filter((item) => item !== value)
        : [...previous.allowedServices, value],
    }));

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle="People who can bill trips to the company. They sign in to the rider app with their registered mobile number."
        actions={canManage && (
          <>
            <Button variant="secondary" onClick={() => { setImportOpen(true); setImportResult(null); setImportFile(null); }}><Upload size={14} /> Import</Button>
            <Button onClick={() => openForm()}><Plus size={14} /> Add employee</Button>
          </>
        )}
      />
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="w-64"><Input placeholder="Search name, phone, code" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
        <div className="w-40">
          <Select value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
            <option value="true">Active</option>
            <option value="false">Deactivated</option>
            <option value="">All</option>
          </Select>
        </div>
        <div className="w-48">
          <Select value={roleId} onChange={(e) => { setRoleId(e.target.value); setPage(1); }}>
            <option value="">All roles</option>
            {roles.map((role) => <option key={idOf(role)} value={idOf(role)}>{role.name}</option>)}
          </Select>
        </div>
        {canManage && selected.length > 0 && (
          <div className="flex items-center gap-2 bg-gray-900 text-white text-sm rounded-lg pl-3 pr-1 py-1">
            <span>{selected.length} selected</span>
            <button type="button" className="bg-white text-gray-900 font-medium rounded-md px-2.5 py-1" onClick={() => setChangingRole(true)}>Change role</button>
            <button type="button" className="text-gray-300 hover:text-white px-2" onClick={() => setSelected([])}>Clear</button>
          </div>
        )}
      </div>
      <ErrorNote message={error} />
      {loading ? <Loading /> : !data?.items?.length ? (
        <Empty title="No employees yet." hint="Add them one by one or import a spreadsheet." />
      ) : (
        <>
          <Table
            columns={[
              ...(canManage ? [{
                key: 'select',
                label: <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={togglePage} />,
                render: (row) => <input type="checkbox" aria-label={`Select ${row.name}`} checked={selected.includes(row._id)} onChange={() => toggleSelected(row._id)} />,
              }] : []),
              { key: 'employeeCode', label: 'Employee ID', render: (row) => <span className="font-mono text-xs whitespace-nowrap">{row.employeeCode || '-'}</span> },
              { key: 'name', label: 'Name', render: (row) => <div><p className="font-medium text-gray-900">{row.name}</p>{row.designation && <p className="text-xs text-gray-500">{row.designation}</p>}</div> },
              { key: 'phone', label: 'Contact', render: (row) => <div><p>{row.phone}</p><p className="text-xs text-gray-500">{row.email}</p></div> },
              { key: 'role', label: 'Role', render: (row) => row.role?.name || roleFor(row)?.name || '-' },
              { key: 'department', label: 'Department', render: (row) => row.departmentId?.name || 'Unassigned' },
              {
                key: 'allowance',
                label: 'Km allowance',
                render: (row) => {
                  const role = roleFor(row);
                  return (
                    <button type="button" className="text-left hover:opacity-80" onClick={() => setAllowanceFor(row)} title="Allowance history">
                      <AllowanceCell usage={row.allowance} role={role} />
                      {role?.allowance?.enabled && <span className="text-[11px] text-gray-400 inline-flex items-center gap-1 mt-0.5"><Gauge size={11} /> per {periodLabel(role.allowance.period)} · history</span>}
                    </button>
                  );
                },
              },
              { key: 'monthlyLimit', label: 'Monthly limit', align: 'right', render: (row) => (row.monthlyLimit ? formatMoney(row.monthlyLimit) : 'None') },
              { key: 'status', label: 'Status', render: (row) => <Badge value={row.active ? 'active' : 'inactive'} /> },
              {
                key: 'actions',
                label: '',
                render: (row) => canManage && (
                  <div className="flex gap-2 justify-end">
                    <Button variant="secondary" onClick={() => openForm(row)}>Edit</Button>
                    {row.active && <Button variant="secondary" onClick={() => act(() => corporateApi.inviteEmployee(row._id), 'Invite sent')}>Invite</Button>}
                    {row.active
                      ? <Button variant="danger" onClick={() => window.confirm(`Deactivate ${row.name}?`) && act(() => corporateApi.deactivateEmployee(row._id), 'Deactivated')}>Deactivate</Button>
                      : <Button variant="success" onClick={() => act(() => corporateApi.updateEmployee(row._id, { active: true }), 'Reactivated')}>Reactivate</Button>}
                  </div>
                ),
              },
            ]}
            rows={data.items}
          />
          <Pager page={data.page} total={data.total} limit={data.limit} onPage={setPage} />
        </>
      )}

      <Modal
        open={Boolean(editing)}
        title={editing?._id ? 'Edit employee' : 'Add employee'}
        onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button busy={busy} onClick={save}>Save</Button></>}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Mobile"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Employee ID" hint={editing?._id ? 'Unique within the company' : 'Leave blank to auto-generate'}>
            <Input value={form.employeeCode} placeholder={editing?._id ? '' : 'Auto'} onChange={(e) => setForm({ ...form, employeeCode: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Designation"><Input value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></Field>
          <Field label="Role" hint={(() => { const role = roles.find((item) => idOf(item) === form.roleId) || (!form.roleId && defaultRole); return role ? allowanceLabel(role.allowance) : ''; })()}>
            <Select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
              <option value="">{defaultRole ? `Default (${defaultRole.name})` : 'Default role'}</option>
              {roles.filter((role) => role.active !== false || idOf(role) === form.roleId).map((role) => <option key={idOf(role)} value={idOf(role)}>{role.name}</option>)}
            </Select>
          </Field>
          <Field label="Department">
            <Select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
              <option value="">Unassigned</option>
              {(departments || []).map((department) => <option key={department._id} value={department._id}>{department.name}</option>)}
            </Select>
          </Field>
          <Field label="Monthly limit (₹)" hint="Blank = no limit"><Input type="number" min="0" value={form.monthlyLimit} onChange={(e) => setForm({ ...form, monthlyLimit: e.target.value })} /></Field>
        </div>
        <Field label="Allowed services" hint="None ticked = whatever the company policy allows">
          <div className="flex flex-wrap gap-3 text-sm">
            {SERVICE_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-1.5">
                <input type="checkbox" checked={form.allowedServices.includes(option.value)} onChange={() => toggleService(option.value)} /> {option.label}
              </label>
            ))}
          </div>
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requiresApproval} onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })} /> Every trip needs approval</label>
        {!editing?._id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.sendInvite} onChange={(e) => setForm({ ...form, sendInvite: e.target.checked })} /> Send an invite now</label>}
      </Modal>

      <Modal
        open={importOpen}
        title="Import employees"
        onClose={() => setImportOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setImportOpen(false)}>Close</Button><Button busy={busy} disabled={!importFile} onClick={runImport}>Import</Button></>}
      >
        <p className="text-sm text-gray-600">Upload a .csv or .xlsx with columns Name, Phone, Email, Employee Code, roleCode, Department, Designation, Monthly Limit, Requires Approval, Allowed Services. Existing employees (same phone) are updated; new departments are created.</p>
        <ul className="text-xs text-gray-500 list-disc pl-4 space-y-0.5">
          <li>Employee Code: leave blank to auto-generate an ID; a code already used by another employee fails that row.</li>
          <li>roleCode: one of your role codes{roles.length ? ` (${roles.map((role) => role.code).join(', ')})` : ''}; the role name is also accepted; blank = the default role.</li>
        </ul>
        <Button variant="secondary" onClick={() => downloadFile('/corporate/employees/import-template', 'employee-import-template.csv').catch((err) => toast.error(errorMessage(err)))}><Download size={14} /> Download template</Button>
        <input type="file" accept=".csv,.xlsx" onChange={(e) => setImportFile(e.target.files?.[0] || null)} className="block text-sm" />
        {importResult && (
          <div className="text-sm bg-gray-50 rounded-lg p-3 space-y-1">
            <p>{importResult.created} created, {importResult.updated} updated, {importResult.failed} failed of {importResult.total}.</p>
            {importResult.errors?.slice(0, 20).map((row) => <p key={row.row} className="text-red-700 text-xs">Row {row.row}: {row.errors.join(', ')}</p>)}
          </div>
        )}
      </Modal>

      <ChangeRoleModal open={changingRole} count={selected.length} roles={roles} onClose={() => setChangingRole(false)} onConfirm={assignRole} />

      {allowanceFor && <AllowanceDrawer employee={allowanceFor} role={roleFor(allowanceFor)} onClose={() => setAllowanceFor(null)} />}
    </>
  );
}
