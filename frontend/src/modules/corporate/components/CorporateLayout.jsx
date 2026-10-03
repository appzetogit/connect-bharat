import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  BadgeCheck,
  BarChart3,
  Building2,
  CarFront,
  CheckSquare,
  FileText,
  LayoutDashboard,
  LogOut,
  MapPinned,
  Menu,
  Route as RouteIcon,
  ShieldCheck,
  UserCog,
  Users,
} from 'lucide-react';
import {
  CORPORATE_BASE_PATH,
  clearCorporateSession,
  corporateApi,
  hasCorporateToken,
  readCorporateSession,
  saveCorporateSession,
} from '../services/corporateApi';

/** Which panel roles see which sections. Mirrors the backend route guards. */
const NAV = [
  { to: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['owner', 'admin', 'approver', 'finance'] },
  { to: 'travel-desk', label: 'Travel Desk', icon: CarFront, roles: ['owner', 'admin', 'approver', 'finance'] },
  { to: 'approvals', label: 'Approvals', icon: CheckSquare, roles: ['owner', 'admin', 'approver'] },
  { to: 'trips', label: 'Trips', icon: RouteIcon, roles: ['owner', 'admin', 'approver', 'finance'] },
  { to: 'employees', label: 'Employees', icon: Users, roles: ['owner', 'admin', 'approver', 'finance'] },
  { to: 'roles', label: 'Roles', icon: BadgeCheck, roles: ['owner', 'admin', 'approver', 'finance'] },
  { to: 'departments', label: 'Departments', icon: Building2, roles: ['owner', 'admin', 'approver', 'finance'] },
  { to: 'policies', label: 'Travel Policies', icon: ShieldCheck, roles: ['owner', 'admin', 'approver', 'finance'] },
  { to: 'travel-zone', label: 'Travel Zone', icon: MapPinned, roles: ['owner', 'admin', 'approver', 'finance'] },
  { to: 'invoices', label: 'Invoices', icon: FileText, roles: ['owner', 'admin', 'finance'] },
  { to: 'reports', label: 'Reports', icon: BarChart3, roles: ['owner', 'admin', 'approver', 'finance'] },
  { to: 'users', label: 'Panel Users', icon: UserCog, roles: ['owner', 'admin'] },
];

export default function CorporateLayout() {
  const navigate = useNavigate();
  const [session, setSession] = useState(readCorporateSession());
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!hasCorporateToken()) return;
    corporateApi
      .me()
      .then((data) => {
        const next = { ...readCorporateSession(), admin: data.admin, corporate: data.corporate };
        saveCorporateSession({ token: localStorage.getItem('corporateToken'), ...next });
        setSession(next);
      })
      .catch(() => null);
  }, []);

  if (!hasCorporateToken()) return <Navigate to={`${CORPORATE_BASE_PATH}/login`} replace />;

  const role = session?.admin?.role || 'admin';
  const status = session?.corporate?.status || 'approved';
  const items = NAV.filter((item) => item.roles.includes(role));

  const logout = () => {
    clearCorporateSession();
    navigate(`${CORPORATE_BASE_PATH}/login`, { replace: true });
  };

  return (
    <div className="h-screen flex bg-gray-50 text-gray-900">
      <aside className={`${menuOpen ? 'flex' : 'hidden'} md:flex fixed md:static inset-y-0 left-0 z-40 w-60 flex-col bg-white border-r border-gray-200`}>
        <div className="px-5 py-5 border-b border-gray-100">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Corporate</p>
          <p className="font-bold text-gray-900 truncate mt-0.5">{session?.corporate?.name || 'Company'}</p>
          <p className="text-xs text-gray-500 truncate">{session?.admin?.name} · {role}</p>
        </div>
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={`${CORPORATE_BASE_PATH}/${to}`}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${isActive ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`
              }
            >
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
        <button type="button" onClick={logout} className="flex items-center gap-3 px-6 py-4 text-sm text-gray-600 hover:text-gray-900 border-t border-gray-100">
          <LogOut size={16} /> Sign out
        </button>
      </aside>
      {menuOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setMenuOpen(false)} />}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200">
          <button type="button" onClick={() => setMenuOpen(true)} aria-label="Menu"><Menu size={20} /></button>
          <span className="font-semibold truncate">{session?.corporate?.name || 'Corporate'}</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          {status !== 'approved' && (
            <div className="bg-yellow-50 border-b border-yellow-200 text-yellow-900 text-sm px-6 py-3">
              {status === 'pending' && 'Your company is awaiting approval. You can explore the panel; employees cannot bill trips yet.'}
              {status === 'suspended' && `Your company account is suspended${session?.corporate?.suspendedReason ? `: ${session.corporate.suspendedReason}` : ''}. Contact support.`}
              {status === 'rejected' && `Registration rejected${session?.corporate?.rejectionReason ? `: ${session.corporate.rejectionReason}` : ''}.`}
            </div>
          )}
          <div className="p-4 lg:p-6 max-w-7xl">
            <Outlet context={{ session }} />
          </div>
        </main>
      </div>
    </div>
  );
}
