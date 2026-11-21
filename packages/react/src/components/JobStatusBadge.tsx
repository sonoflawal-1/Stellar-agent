'use client';

import React from 'react';
import type { JobStatus } from 'marc-stellar-sdk';

export interface JobStatusBadgeProps {
  status: JobStatus;
  className?: string;
  style?: React.CSSProperties;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  Open: { bg: '#f3f4f6', text: '#374151', border: '#e5e7eb' },
  Funded: { bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe' },
  Submitted: { bg: '#fef3c7', text: '#92400e', border: '#fde68a' },
  Completed: { bg: '#ecfdf5', text: '#065f46', border: '#a7f3d0' },
  Rejected: { bg: '#fef2f2', text: '#991b1b', border: '#fecaca' },
  Cancelled: { bg: '#f3f4f6', text: '#4b5563', border: '#d1d5db' },
  Disputed: { bg: '#fff7ed', text: '#9a3412', border: '#fed7aa' },
};

export function JobStatusBadge({ status, className, style }: JobStatusBadgeProps): React.ReactElement {
  const colors = STATUS_COLORS[status] ?? { bg: '#f3f4f6', text: '#374151', border: '#e5e7eb' };

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0.25rem 0.625rem',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        lineHeight: 1,
        background: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.border}`,
        ...style,
      }}
    >
      {status}
    </span>
  );
}

export default JobStatusBadge;
