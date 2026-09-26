import { JobStatus as JobStatusType } from '../types';

interface JobStatusProps {
  status: JobStatusType;
}

const STATUS_LABELS: Record<JobStatusType, string> = {
  Funded: 'Funded',
  Submitted: 'Submitted',
  Disputed: 'Disputed',
  Resolved: 'Resolved',
  Completed: 'Completed',
};

const STATUS_STYLES: Record<JobStatusType, string> = {
  Funded: 'bg-blue-100 text-blue-800',
  Submitted: 'bg-yellow-100 text-yellow-800',
  Disputed: 'bg-red-100 text-red-800',
  Resolved: 'bg-purple-100 text-purple-800',
  Completed: 'bg-green-100 text-green-800',
};

export function JobStatus({ status }: JobStatusProps) {
  const label = STATUS_LABELS[status] ?? status;
  const style = STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-800';

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}
      data-status={status}
    >
      {label}
    </span>
  );
}

export default JobStatus;
