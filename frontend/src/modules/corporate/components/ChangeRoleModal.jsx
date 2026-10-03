import { useState } from 'react';
import { Button, Field, Modal, Select } from './ui';
import { allowanceLabel } from './helpers';

/**
 * "Change role" for a selection of employees. Roles come from GET /roles;
 * onConfirm(roleId) does the POST /roles/:roleId/assign call.
 */
export default function ChangeRoleModal({ open, count, roles, onClose, onConfirm }) {
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const role = roles.find((item) => String(item._id || item.id) === roleId);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(roleId);
      setRoleId('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`Change role for ${count} employee${count === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={!roleId} onClick={confirm}>Change role</Button></>}
    >
      <Field label="New role" hint={role ? allowanceLabel(role.allowance) : 'Their allowance for the current period follows the new role.'}>
        <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">Choose a role</option>
          {roles.filter((item) => item.active !== false).map((item) => (
            <option key={String(item._id || item.id)} value={String(item._id || item.id)}>{item.name} ({item.code})</option>
          ))}
        </Select>
      </Field>
    </Modal>
  );
}
