import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageCheck,
  PackagePlus,
  ScanLine,
  Truck,
  Warehouse,
} from 'lucide-react';
import { hubApi, hubSession } from '../services/hubApi';
import { disconnectHubSocket } from '../services/hubSocket';

const NAV = [
  { to: '/hub/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/hub/scan', label: 'Scan', icon: ScanLine },
  { to: '/hub/inbound', label: 'Inbound', icon: PackageCheck },
  { to: '/hub/manifests', label: 'Manifests', icon: Warehouse },
  { to: '/hub/delivery', label: 'Delivery', icon: Truck },
  { to: '/hub/failed', label: 'Failed & RTO', icon: AlertTriangle },
  { to: '/hub/book', label: 'Counter booking', icon: PackagePlus },
  { to: '/hub/reports', label: 'Reports', icon: BarChart3 },
];

/**
 * Shell for every signed-in hub screen: sidebar, hub switcher (for managers
 * of several hubs), and the session guard. Owns its own scrolling because the
 * app's outer layout fixes the admin-style root at the viewport height.
 */
const HubLayout = () => {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const token = hubSession.getToken();

  useEffect(() => {
    if (!token) return;
    hubApi.me().then(setMe).catch(() => {});
  }, [token]);

  if (!token) return <Navigate to="/hub/login" replace />;

  const logout = () => {
    hubSession.clear();
    disconnectHubSocket();
    navigate('/hub/login', { replace: true });
  };

  const switchHub = (hubId) => {
    hubSession.setActiveHubId(hubId);
    window.location.reload();
  };

  const sidebar = (
    <aside className="w-60 shrink-0 bg-slate-900 text-slate-200 flex flex-col h-full">
      <div className="px-5 py-4 border-b border-slate-800">
        <div className="text-[11px] uppercase tracking-wider text-slate-400">Hub panel</div>
        <div className="text-[15px] font-semibold text-white truncate">{me?.activeHub?.name || '…'}</div>
        <div className="text-[12px] text-slate-400 font-mono">{me?.activeHub?.code}</div>
        {me?.hubs?.length > 1 && (
          <select
            value={me.activeHub?.id}
            onChange={(event) => switchHub(event.target.value)}
            className="mt-2 w-full bg-slate-800 border border-slate-700 rounded-md text-[12px] px-2 py-1"
          >
            {me.hubs.map((hub) => (
              <option key={hub.id} value={hub.id}>{hub.code} · {hub.name}</option>
            ))}
          </select>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto py-3">
        {NAV.map(({ to, label, icon }) => {
          const NavIcon = icon;
          return (
          <NavLink
            key={to}
            to={to}
            onClick={() => setMenuOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 px-5 py-2 text-[13px] ${isActive ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'}`
            }
          >
            <NavIcon size={16} />
            {label}
          </NavLink>
          );
        })}
      </nav>
      <div className="px-5 py-3 border-t border-slate-800 text-[12px]">
        <div className="text-slate-300 truncate">{me?.staff?.name}</div>
        <div className="text-slate-500">{me?.staff?.role === 'hub_manager' ? 'Hub manager' : 'Hub operator'}</div>
        <button type="button" onClick={logout} className="mt-2 inline-flex items-center gap-2 text-slate-300 hover:text-white">
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </aside>
  );

  return (
    <div className="h-screen flex bg-slate-50 overflow-hidden">
      <div className="hidden lg:flex">{sidebar}</div>
      {menuOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex" onClick={() => setMenuOpen(false)}>
          <div onClick={(event) => event.stopPropagation()}>{sidebar}</div>
          <div className="flex-1 bg-black/30" />
        </div>
      )}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-slate-200">
          <button type="button" onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
          <span className="font-semibold text-slate-900">{me?.activeHub?.code || 'Hub'}</span>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet context={{ me }} />
        </main>
      </div>
    </div>
  );
};

export default HubLayout;
