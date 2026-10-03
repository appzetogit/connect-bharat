import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus } from 'lucide-react';
import { corporateApi, errorMessage } from '../services/corporateApi';
import { Badge, Button, Card, ErrorNote, Field, Input, Loading, Modal, PageHeader, Select, Table, formatDate, useLoad } from '../components/ui';

const ROLE_HELP = {
  owner: 'Everything, including adding owners',
  admin: 'Employees, departments, policies, approvals, invoices',
  approver: 'Approves trips (optionally only for some departments)',
  finance: 'Invoices, payments and reports',
};

export default function CorporateUsers() {
  const { session } = useOutletContext() || {};
  const { data, loading, error, reload } = useLoad(() => corporateApi.admins(), []);
  const { data: departments } = useLoad(() => corporateApi.departments(), []);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState({ currentPassword: '', newPassword: '' });

  const open = (user = null) => {
    setEditing(user || {});
    setForm(user ? { ...user, password: '' } : { name: '', email: '', phone: '', role: 'approver', departmentIds: [], password: '' });
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: form.name, phone: form.phone, role: form.role, departmentIds: form.departmentIds, ...(form.password ? { password: form.password } : {}) };
      if (editing?.id) await corporateApi.updateAdmin(editing.id, { ...body, active: form.active });
      else await corporateApi.createAdmin({ ...body, email: form.email });
      toast.success('Saved');
      setEditing(null);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    try {
      await corporateApi.changePassword(password);
      setPassword({ currentPassword: '', newPassword: '' });
      toast.success('Password changed');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader title="Panel users" subtitle="Who can sign in to this panel." actions={<Button onClick={() => open()}><Plus size={14} /> Add user</Button>} />
      <ErrorNote message={error} />
      {loading ? <Loading /> : (
        <Table
          rowKey={(row) => row.id}
          columns={[
            { key: 'name', label: 'Name', render: (row) => <div><p className="font-medium">{row.name}</p><p className="text-xs text-gray-500">{row.email}</p></div> },
            { key: 'phone', label: 'Phone' },
            { key: 'role', label: 'Role', render: (row) => <span className="capitalize">{row.role}</span> },
            { key: 'lastLoginAt', label: 'Last sign-in', render: (row) => formatDate(row.lastLoginAt, true) },
            { key: 'active', label: 'Status', render: (row) => <Badge value={row.active ? 'active' : 'inactive'} /> },
            { key: 'actions', label: '', render: (row) => <Button variant="secondary" onClick={() => open(row)}>Edit</Button> },
          ]}
          rows={data || []}
        />
      )}

      <Card className="p-5 mt-6 max-w-md space-y-3">
        <h2 className="font-semibold">Change your password</h2>
        <Field label="Current password" hint="Leave blank if you have only signed in with OTP"><Input type="password" value={password.currentPassword} onChange={(e) => setPassword({ ...password, currentPassword: e.target.value })} /></Field>
        <Field label="New password"><Input type="password" minLength={8} value={password.newPassword} onChange={(e) => setPassword({ ...password, newPassword: e.target.value })} /></Field>
        <Button onClick={changePassword} disabled={password.newPassword.length < 8}>Update password</Button>
      </Card>

      <Modal
        open={Boolean(editing)}
        title={editing?.id ? 'Edit user' : 'Add user'}
        onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button busy={busy} onClick={save}>Save</Button></>}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><Input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" disabled={Boolean(editing?.id)} value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Mobile" hint="Used for OTP sign-in"><Input value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Role" hint={ROLE_HELP[form.role]}>
            <Select value={form.role || 'approver'} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {['owner', 'admin', 'approver', 'finance'].filter((role) => role !== 'owner' || session?.admin?.role === 'owner').map((role) => <option key={role} value={role}>{role}</option>)}
            </Select>
          </Field>
          <Field label={editing?.id ? 'Reset password' : 'Password'} hint="Optional; at least 8 characters"><Input type="password" value={form.password || ''} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        </div>
        {form.role === 'approver' && (
          <Field label="Approves for" hint="None ticked = every department">
            <div className="flex flex-wrap gap-3 text-sm">
              {(departments || []).map((department) => (
                <label key={department._id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={(form.departmentIds || []).includes(department._id)}
                    onChange={() => setForm((previous) => ({
                      ...previous,
                      departmentIds: (previous.departmentIds || []).includes(department._id)
                        ? previous.departmentIds.filter((id) => id !== department._id)
                        : [...(previous.departmentIds || []), department._id],
                    }))}
                  />
                  {department.name}
                </label>
              ))}
            </div>
          </Field>
        )}
        {editing?.id && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active !== false} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
        )}
      </Modal>
    </>
  );
}
