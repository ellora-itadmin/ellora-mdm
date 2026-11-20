import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import Logo from './Logo';
import { useAuth } from '../AuthContext';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/devices', label: 'Devices' },
  { to: '/policies', label: 'Policies' },
  { to: '/alerts', label: 'Alerts' }
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 230,
          background: 'var(--navy)',
          color: '#fff',
          display: 'flex',
          flexDirection: 'column',
          padding: '22px 16px'
        }}
      >
        <div style={{ padding: '0 8px 26px' }}>
          <div style={{ background: '#fff', borderRadius: 8, padding: '10px 12px', display: 'inline-block' }}>
            <Logo size={26} />
          </div>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => ({
                padding: '10px 14px',
                borderRadius: 8,
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                background: isActive ? 'var(--accent)' : 'transparent',
                opacity: isActive ? 1 : 0.8
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginTop: 'auto', fontSize: 12, opacity: 0.6, padding: '0 8px' }}>
          Ellora EPC Pvt. Ltd.
          <br />
          MDM v1.0
        </div>
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            height: 62,
            borderBottom: '1px solid var(--border)',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '0 24px',
            gap: 16
          }}
        >
          <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>{user?.email}</span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              logout();
              navigate('/login');
            }}
          >
            Sign out
          </button>
        </header>
        <main style={{ flex: 1, padding: 28, maxWidth: 1200, width: '100%', margin: '0 auto' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
