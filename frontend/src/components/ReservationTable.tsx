import type { Reservation, SortField, SortDir } from '../types';
import { StatusBadge } from './StatusBadge';

interface ReservationTableProps {
  reservations: Reservation[];
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}

const COLUMNS: { label: string; field: SortField }[] = [
  { label: 'Reservation ID', field: 'reservation_id' },
  { label: 'Guest', field: 'guest_first_name' },
  { label: 'Email', field: 'guest_email' },
  { label: 'Status', field: 'status' },
  { label: 'Check-in', field: 'check_in' },
  { label: 'Check-out', field: 'check_out' },
  { label: 'Guests', field: 'num_guests' },
  { label: 'Total', field: 'total_amount' },
];

export function ReservationTable({ reservations, sortField, sortDir, onSort }: ReservationTableProps) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {COLUMNS.map(({ label, field }) => (
            <th key={field} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #ccc' }}>
              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: '1em' }}
                onClick={() => onSort(field)}
              >
                {label}
                {sortField === field ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {reservations.length === 0 ? (
          <tr>
            <td colSpan={8} style={{ textAlign: 'center', padding: '20px', color: '#888' }}>
              No reservations
            </td>
          </tr>
        ) : (
          reservations.map((r) => (
            <tr key={r.reservation_id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '6px 8px' }}>{r.reservation_id}</td>
              <td style={{ padding: '6px 8px' }}>
                {r.guest_first_name
                  ? `${r.guest_first_name} ${r.guest_last_name ?? ''}`.trim()
                  : <em>{r.guest_id}</em>}
              </td>
              <td style={{ padding: '6px 8px' }}>{r.guest_email ?? ''}</td>
              <td style={{ padding: '6px 8px' }}><StatusBadge status={r.status} /></td>
              <td style={{ padding: '6px 8px' }}>{r.check_in}</td>
              <td style={{ padding: '6px 8px' }}>{r.check_out}</td>
              <td style={{ padding: '6px 8px' }}>{r.num_guests}</td>
              <td style={{ padding: '6px 8px' }}>${r.total_amount} {r.currency}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
