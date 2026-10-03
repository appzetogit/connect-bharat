import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Download, Plus, Upload } from 'lucide-react';
import { corporateApi, downloadFile, errorMessage } from '../services/corporateApi';
import {
  Badge, Button, Empty, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pager, SERVICE_OPTIONS, Select, Table, formatMoney, useLoad,
} from '../components/ui';

const EMPTY_FORM = { name: '', phone: '', email: '', employeeCode: '', designation: '', departmentId: '', monthlyLimit: '', requiresApproval: false, allowedServices: [], sendInvite: true };

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
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, reload } = useLoad(() => corporateApi.employees({ page, search, active, limit: 25 }), [page, search, active]);
  const { data: departments } = useLoad(() => corporateApi.departments(), []);

  const openForm = (employee = null) => {
    setEditing(employee || {});
    setForm(employee
      ? {
          ...EMPTY_FORM,
          ...employee,
          departmentId: employee.departmentId?._id || employee.departmentId || '',
          monthlyLimit: employee.monthlyLimit || '',
          sendInvite: false,
        }
      : EMPTY_FORM);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, monthlyLimit: Number(form.monthlyLimit) || 0, departmentId: form.departmentId || null };
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
      </div>
      <ErrorNote message={error} />
      {loading ? <Loading /> : !data?.items?.length ? (
        <Empty title="No employees yet." hint="Add them one by one or import a spreadsheet." />
      ) : (
        <>
          <Table
            columns={[
              { key: 'name', label: 'Name', render: (row) => <div><p className="font-medium text-gray-900">{row.name}</p><p className="text-xs text-gray-500">{row.employeeCode || ''} {row.designation ? `· ${row.designation}` : ''}</p></div> },
              { key: 'phone', label: 'Contact', render: (row) => <div><p>{row.phone}</p><p className="text-xs text-gray-500">{row.email}</p></div> },
              { key: 'department', label: 'Department', render: (row) => row.departmentId?.name || 'Unassigned' },
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
          <Field label="Employee code"><Input value={form.employeeCode} onChange={(e) => setForm({ ...form, employeeCode: e.target.value })} /></Field>
          <Field label="Designation"><Input value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></Field>
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
        <p className="text-sm text-gray-600">Upload a .csv or .xlsx with columns Name, Phone, Email, Employee Code, Department, Designation, Monthly Limit, Requires Approval, Allowed Services. Existing employees (same phone) are updated; new departments are created.</p>
        <Button variant="secondary" onClick={() => downloadFile('/corporate/employees/import-template', 'employee-import-template.csv').catch((err) => toast.error(errorMessage(err)))}><Download size={14} /> Download template</Button>
        <input type="file" accept=".csv,.xlsx" onChange={(e) => setImportFile(e.target.files?.[0] || null)} className="block text-sm" />
        {importResult && (
          <div className="text-sm bg-gray-50 rounded-lg p-3 space-y-1">
            <p>{importResult.created} created, {importResult.updated} updated, {importResult.failed} failed of {importResult.total}.</p>
            {importResult.errors?.slice(0, 20).map((row) => <p key={row.row} className="text-red-700 text-xs">Row {row.row}: {row.errors.join(', ')}</p>)}
          </div>
        )}
      </Modal>
    </>
  );
}
