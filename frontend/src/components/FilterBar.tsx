import type { SortField, SortDir } from '../types';

interface FilterBarProps {
  statusFilter: string;
  onStatusChange: (v: string) => void;
  sortField: SortField;
  sortDir: SortDir;
  onSortFieldChange: (f: SortField) => void;
  onSortDirChange: (d: SortDir) => void;
}

export function FilterBar({
  statusFilter,
  onStatusChange,
  sortField,
  sortDir,
  onSortFieldChange,
  onSortDirChange,
}: FilterBarProps) {
  return (
    <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', alignItems: 'center' }}>
      <label>
        Status:{' '}
        <select value={statusFilter} onChange={(e) => onStatusChange(e.target.value)}>
          <option value="">All</option>
          <option value="confirmed">confirmed</option>
          <option value="modified">modified</option>
          <option value="cancelled">cancelled</option>
        </select>
      </label>

      <label>
        Sort by:{' '}
        <select value={sortField} onChange={(e) => onSortFieldChange(e.target.value as SortField)}>
          <option value="event_timestamp">Event Time</option>
          <option value="check_in">Check-in</option>
          <option value="check_out">Check-out</option>
          <option value="total_amount">Total</option>
          <option value="status">Status</option>
        </select>
      </label>

      <button onClick={() => onSortDirChange(sortDir === 'asc' ? 'desc' : 'asc')}>
        {sortDir === 'asc' ? '↑' : '↓'}
      </button>
    </div>
  );
}
