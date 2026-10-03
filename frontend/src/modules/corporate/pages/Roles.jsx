import { useOutletContext } from 'react-router-dom';
import { corporateApi } from '../services/corporateApi';
import { PageHeader } from '../components/ui';
import RolesManager from '../components/RolesManager';

/// Defined once at module level so RolesManager's loaders stay stable.
const ROLES_API = {
  list: () => corporateApi.roles(),
  create: (body) => corporateApi.createRole(body),
  update: (id, body) => corporateApi.updateRole(id, body),
  remove: (id, reassignToRoleId) => corporateApi.deleteRole(id, reassignToRoleId),
  makeDefault: (id) => corporateApi.makeDefaultRole(id),
  vehicleTypes: () => corporateApi.vehicleTypes(),
};

export default function CorporateRoles() {
  const { session } = useOutletContext() || {};
  const canManage = ['owner', 'admin'].includes(session?.admin?.role);
  return (
    <>
      <PageHeader
        title="Roles"
        subtitle="Group employees by seniority. Each role can have a free km allowance and its own travel rules; rules merge company → department → role → employee."
      />
      <RolesManager api={ROLES_API} canManage={canManage} />
    </>
  );
}
