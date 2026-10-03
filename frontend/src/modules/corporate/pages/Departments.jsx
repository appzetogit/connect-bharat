import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus } from 'lucide-react';
import { corporateApi, errorMessage } from '../services/corporateApi';
import { Badge, Button, Empty, ErrorNote, Field, Input, Loading, Modal, PageHeader, Table, formatMoney, useLoad } from '../components/ui';

const EMPTY = { name: '', code: '', costCenter: '', monthlyBudget: '', approverIds: [] };

export default function CorporateDepartments() {
  const { session } = useOutletContext() || {};
  const canManage = ['owner', 'admin'].includes(session?.admin?.role);
  const { data, loading, error, reload } = useLoad(() => corporateApi.departments(), []);
  const { data: admins } = useLoad(() => (canManage ? corporateApi.admins() : Promise.resolve([])), [canManage]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const open = (department = null) => {
    setEditing(department || {});
    setForm(department
      ? { name: department.name, code: department.code, costCenter: department.costCenter, monthlyBudget: department.monthlyBudget || '', approverIds: (department.approverIds || []).map((item) => item._id || item) }
      : EMPTY);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, monthlyBudget: Number(form.monthlyBudget) || 0 };
      if (editing?._id) await corporateApi.updateDepartment(editing._id, body);
      else await corporateApi.createDepartment(body);
      toast.success('Saved');
      setEditing(null);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (department) => {
    if (!window.confirm(`Remove ${department.name}?`)) return;
    try {
      const result = await corporateApi.deleteDepartment(department._id);
      toast.success(result.deactivated ? 'Department has employees, so it was deactivated' : 'Removed');
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const approvers = (admins || []).filter((admin) => admin.active);

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle="Cost centres, monthly budgets and who approves each department's trips."
        actions={canManage && <Button onClick={() => open()}><Plus size={14} /> Add department</Button>}
      />
      <ErrorNote message={error} />
      {loading ? <Loading /> : !data?.length ? <Empty title="No departments yet." /> : (
        <Table
          columns={[
            { key: 'name', label: 'Department', render: (row) => <div><p className="font-medium">{row.name}</p><p className="text-xs text-gray-500">{row.code}</p></div> },
            { key: 'costCenter', label: 'Cost centre' },
            { key: 'activeEmployees', label: 'Employees', align: 'right' },
            { key: 'monthlyBudget', label: 'Monthly budget', align: 'right', render: (row) => (row.monthlyBudget ? formatMoney(row.monthlyBudget) : 'None') },
            { key: 'approvers', label: 'Approvers', render: (row) => (row.approverIds || []).map((item) => item.name).join(', ') || 'Owners & admins' },
            { key: 'active', label: 'Status', render: (row) => <Badge value={row.active ? 'active' : 'inactive'} /> },
            {
              key: 'actions',
              label: '',
              render: (row) => canManage && (
                <div className="flex gap-2 justify-end">
                  <Button variant="secondary" onClick={() => open(row)}>Edit</Button>
                  <Button variant="danger" onClick={() => remove(row)}>Remove</Button>
                </div>
              ),
            },
          ]}
          rows={data}
        />
      )}
      <Modal
        open={Boolean(editing)}
        title={editing?._id ? 'Edit department' : 'Add department'}
        onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button busy={busy} onClick={save}>Save</Button></>}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
          <Field label="Cost centre"><Input value={form.costCenter} onChange={(e) => setForm({ ...form, costCenter: e.target.value })} /></Field>
          <Field label="Monthly budget (₹)" hint="Trips over budget need approval"><Input type="number" min="0" value={form.monthlyBudget} onChange={(e) => setForm({ ...form, monthlyBudget: e.target.value })} /></Field>
        </div>
        <Field label="Approvers" hint="Owners and admins can always approve">
          <div className="space-y-1 text-sm max-h-40 overflow-y-auto">
            {approvers.map((admin) => (
              <label key={admin.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.approverIds.includes(admin.id)}
                  onChange={() => setForm((previous) => ({
                    ...previous,
                    approverIds: previous.approverIds.includes(admin.id) ? previous.approverIds.filter((id) => id !== admin.id) : [...previous.approverIds, admin.id],
                  }))}
                />
                {admin.name} <span className="text-xs text-gray-400">{admin.role}</span>
              </label>
            ))}
          </div>
        </Field>
      </Modal>
    </>
  );
}
