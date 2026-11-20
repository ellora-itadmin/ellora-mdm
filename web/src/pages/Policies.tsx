import { useEffect, useState } from 'react';
import { api } from '../api/client';

const emptyForm = { id: null as number | null, name: '', platform: 'windows', require_password: true, require_encryption: true, auto_lock_minutes: 5 };

export default function Policies() {
  const [policies, setPolicies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);

  function load() {
    setLoading(true);
    api.getPolicies().then((d) => setPolicies(d.policies)).finally(() => setLoading(false));
  }

  useEffect(load, []);

  function openNew() {
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(p: any) {
    setForm({
      id: p.id,
      name: p.name,
      platform: p.platform,
      require_password: !!p.require_password,
      require_encryption: !!p.require_encryption,
      auto_lock_minutes: p.auto_lock_minutes
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.id) {
      await api.updatePolicy(form.id, form);
    } else {
      await api.createPolicy(form);
    }
    setShowForm(false);
    load();
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this policy? Devices will be unassigned.')) return;
    await api.deletePolicy(id);
    load();
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Policies</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Security policies applied to enrolled devices</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ New Policy</button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {policies.map((p) => (
            <div key={p.id} className="card" style={{ padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <h3 style={{ fontSize: 16, fontWeight: 700 }}>{p.name}</h3>
                <span className="badge badge-info" style={{ textTransform: 'capitalize' }}>{p.platform}</span>
              </div>
              <div style={{ margin: '14px 0', fontSize: 13, color: 'var(--text-muted)' }}>
                <div>Password required: <strong style={{ color: 'var(--text)' }}>{p.require_password ? 'Yes' : 'No'}</strong></div>
                <div>Encryption required: <strong style={{ color: 'var(--text)' }}>{p.require_encryption ? 'Yes' : 'No'}</strong></div>
                <div>Auto-lock: <strong style={{ color: 'var(--text)' }}>{p.auto_lock_minutes} min</strong></div>
                <div>Assigned devices: <strong style={{ color: 'var(--text)' }}>{p.device_count}</strong></div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary btn-sm" style={{ flex: 1, justifyContent: 'center' }} onClick={() => openEdit(p)}>Edit</button>
                <button className="btn btn-danger btn-sm" style={{ flex: 1, justifyContent: 'center' }} onClick={() => handleDelete(p.id)}>Delete</button>
              </div>
            </div>
          ))}
          {policies.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No policies yet. Create one to get started.</p>}
        </div>
      )}

      {showForm && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(27,40,73,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
          onClick={() => setShowForm(false)}
        >
          <div className="card" style={{ padding: 26, width: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>{form.id ? 'Edit Policy' : 'New Policy'}</h3>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label>Policy name</label>
                <input required style={{ width: '100%', marginTop: 6 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <label>Platform</label>
                <select style={{ width: '100%', marginTop: 6 }} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
                  <option value="windows">Windows</option>
                  <option value="macos">macOS</option>
                  <option value="android">Android</option>
                </select>
              </div>
              <div>
                <label>Auto-lock timeout (minutes)</label>
                <input type="number" min={1} max={60} style={{ width: '100%', marginTop: 6 }} value={form.auto_lock_minutes} onChange={(e) => setForm({ ...form, auto_lock_minutes: Number(e.target.value) })} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={form.require_password} onChange={(e) => setForm({ ...form, require_password: e.target.checked })} />
                Require device password
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={form.require_encryption} onChange={(e) => setForm({ ...form, require_encryption: e.target.checked })} />
                Require disk encryption
              </label>
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
