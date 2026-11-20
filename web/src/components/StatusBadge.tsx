export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    online: 'badge-success',
    offline: 'badge-danger',
    pending: 'badge-warning'
  };
  return <span className={`badge ${map[status] || 'badge-neutral'}`}>{status}</span>;
}

export function ComplianceBadge({ compliance }: { compliance: string }) {
  const map: Record<string, string> = {
    compliant: 'badge-success',
    non_compliant: 'badge-danger',
    unknown: 'badge-neutral'
  };
  const label: Record<string, string> = {
    compliant: 'Compliant',
    non_compliant: 'Non-compliant',
    unknown: 'Unknown'
  };
  return <span className={`badge ${map[compliance] || 'badge-neutral'}`}>{label[compliance] || compliance}</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    info: 'badge-info',
    warning: 'badge-warning',
    critical: 'badge-danger'
  };
  return <span className={`badge ${map[severity] || 'badge-neutral'}`}>{severity}</span>;
}

export function PlatformBadge({ platform }: { platform: string }) {
  const label: Record<string, string> = { windows: 'Windows', macos: 'macOS', android: 'Android' };
  return <span className="badge badge-info">{label[platform] || platform}</span>;
}
