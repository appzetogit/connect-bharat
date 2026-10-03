import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import AdminPageHeader from '../../components/ui/AdminPageHeader';
import { logisticsAdminService as service, plain } from '../../services/logisticsAdminService';
import { Button, Card, Empty, Field, Modal, StatusBadge } from '../../../hub/components/ui';
import { inputClass } from '../../../hub/components/format';
import { useServiceLocations } from './useServiceLocations';

/** Admin: parcel hubs and the staff who work them. */
const emptyHub = { code: '', name: '', type: 'any', cityCode: '', address: '', contactPhone: '', lat: '', lng: '', capacity: '', serviceLocationId: '', status: 'active' };
const emptyStaff = { name: '', phone: '', email: '', role: 'hub_operator', password: '', active: true };

const HubForm = ({ initial, locations, onClose, onSaved }) => {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        code: form.code,
        name: form.name,
        type: form.type,
        cityCode: form.cityCode,
        address: form.address,
        contactPhone: form.contactPhone,
        capacity: Number(form.capacity) || 0,
        status: form.status,
        serviceLocationId: form.serviceLocationId || null,
        location: [Number(form.lng), Number(form.lat)],
      };
      if (form.id) await service.updateHub(form.id, payload);
      else await service.createHub(payload);
      toast.success('Hub saved');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error?.response?.data?.message || error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title={form.id ? `Edit ${form.code}` : 'New hub'} onClose={onClose} footer={<Button onClick={save} loading={saving}>Save</Button>}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Code"><input className={inputClass} value={form.code} onChange={set('code')} placeholder="BLR01" /></Field>
        <Field label="Name"><input className={inputClass} value={form.name} onChange={set('name')} /></Field>
        <Field label="Type">
          <select className={inputClass} value={form.type} onChange={set('type')}>
            {['any', 'origin', 'transit', 'destination'].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </Field>
        <Field label="AWB city code" hint="3 letters, e.g. BLR"><input className={inputClass} value={form.cityCode} onChange={set('cityCode')} maxLength={3} /></Field>
        <div className="col-span-2"><Field label="Address"><input className={inputClass} value={form.address} onChange={set('address')} /></Field></div>
        <Field label="Latitude"><input className={inputClass} value={form.lat} onChange={set('lat')} /></Field>
        <Field label="Longitude"><input className={inputClass} value={form.lng} onChange={set('lng')} /></Field>
        <Field label="Contact phone"><input className={inputClass} value={form.contactPhone} onChange={set('contactPhone')} /></Field>
        <Field label="Capacity (parcels)"><input className={inputClass} value={form.capacity} onChange={set('capacity')} /></Field>
        <Field label="Service location">
          <select className={inputClass} value={form.serviceLocationId || ''} onChange={set('serviceLocationId')}>
            <option value="">—</option>
            {locations.map((location) => <option key={location._id || location.id} value={location._id || location.id}>{location.name || location.service_location_name}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className={inputClass} value={form.status} onChange={set('status')}>
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
};

const StaffPanel = ({ hub }) => {
  const [staff, setStaff] = useState([]);
  const [form, setForm] = useState(null);
  const load = useCallback(() => {
    service.staff({ hubId: hub.id }).then((data) => setStaff(plain(data?.results || []))).catch(() => {});
  }, [hub.id]);
  useEffect(load, [load]);

  const save = async () => {
    try {
      const payload = { ...form, hubId: hub.id };
      if (!payload.password) delete payload.password;
      if (form.id) await service.updateStaff(form.id, payload);
      else await service.createStaff(payload);
      toast.success('Staff saved');
      setForm(null);
      load();
    } catch (error) {
      toast.error(error?.response?.data?.message || error.message);
    }
  };

  const remove = async (member) => {
    if (!window.confirm(`Remove ${member.name}?`)) return;
    await service.deleteStaff(member.id).catch((error) => toast.error(error.message));
    load();
  };

  return (
    <Card title={`Staff · ${hub.code}`} right={<Button variant="secondary" onClick={() => setForm({ ...emptyStaff })}>Add staff</Button>}>
      {staff.length ? (
        <ul className="divide-y divide-slate-100 text-[13px]">
          {staff.map((member) => (
            <li key={member.id} className="py-2 flex items-center justify-between gap-2">
              <div>
                <div className="font-medium">{member.name} <span className="text-slate-400 font-normal">{member.phone}</span></div>
                <div className="text-[11px] text-slate-500">{member.role === 'hub_manager' ? 'Manager' : 'Operator'} · {member.active ? 'active' : 'inactive'}</div>
              </div>
              <div className="flex gap-1">
                <Button variant="secondary" onClick={() => setForm({ ...emptyStaff, ...member, password: '' })}>Edit</Button>
                <Button variant="danger" onClick={() => remove(member)}>Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No staff yet. Staff sign in at /hub/login.</Empty>
      )}
      {form && (
        <Modal open title={form.id ? 'Edit staff' : 'Add staff'} onClose={() => setForm(null)} footer={<Button onClick={save}>Save</Button>}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name"><input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
            <Field label="Phone"><input className={inputClass} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></Field>
            <Field label="Email"><input className={inputClass} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
            <Field label="Role">
              <select className={inputClass} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
                <option value="hub_operator">Operator</option>
                <option value="hub_manager">Manager</option>
              </select>
            </Field>
            <Field label={form.id ? 'New password (optional)' : 'Password (optional)'} hint="Blank = OTP login only">
              <input type="password" className={inputClass} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-[13px] mt-5"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /> Active</label>
          </div>
        </Modal>
      )}
    </Card>
  );
};

const LogisticsHubs = () => {
  const [hubs, setHubs] = useState([]);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);
  const locations = useServiceLocations();

  const load = useCallback(() => {
    service.hubs().then((data) => setHubs(plain(data?.results || []))).catch((error) => toast.error(error.message));
  }, []);
  useEffect(load, [load]);

  const remove = async (hub) => {
    if (!window.confirm(`Delete hub ${hub.code}? Hubs with parcels are deactivated instead.`)) return;
    try {
      const result = await service.deleteHub(hub.id);
      toast.success(result?.deactivated ? 'Hub has parcels; deactivated instead' : 'Hub deleted');
      load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="p-6 lg:p-8 space-y-5">
      <AdminPageHeader module="Parcel network" page="Hubs" title="Hubs" right={<Button onClick={() => setEditing({ ...emptyHub })}>New hub</Button>} />
      <Card>
        {hubs.length ? (
          <div className="overflow-x-auto -mx-4">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-400 border-b border-slate-100">
                  {['Code', 'Name', 'Type', 'Address', 'Capacity', 'Staff', 'Status', ''].map((label) => <th key={label} className="px-4 py-2 font-medium">{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {hubs.map((hub) => (
                  <tr key={hub.id} className={`border-b border-slate-50 ${selected?.id === hub.id ? 'bg-slate-50' : ''}`}>
                    <td className="px-4 py-2 font-mono">{hub.code}</td>
                    <td className="px-4 py-2">{hub.name}</td>
                    <td className="px-4 py-2">{hub.type}</td>
                    <td className="px-4 py-2 text-slate-500">{hub.address}</td>
                    <td className="px-4 py-2 tabular-nums">{hub.capacity || '—'}</td>
                    <td className="px-4 py-2 tabular-nums">{hub.staffCount}</td>
                    <td className="px-4 py-2"><StatusBadge status={hub.status === 'active' ? 'delivered' : 'cancelled'} label={hub.status} /></td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <div className="flex justify-end gap-1">
                        <Button variant="secondary" onClick={() => setSelected(hub)}>Staff</Button>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setEditing({
                              ...emptyHub,
                              ...hub,
                              lat: hub.coordinates?.[1] ?? '',
                              lng: hub.coordinates?.[0] ?? '',
                              serviceLocationId: hub.serviceLocationId || '',
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button variant="danger" onClick={() => remove(hub)}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No hubs yet.</Empty>
        )}
      </Card>
      {selected && <StaffPanel key={selected.id} hub={selected} />}
      {editing && <HubForm initial={editing} locations={locations} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
};

export default LogisticsHubs;
