import { useEffect, useState } from 'react';
import type { Reservation, SortField, SortDir } from './types';
import { FilterBar } from './components/FilterBar';
import { ReservationTable } from './components/ReservationTable';
import { BroadcastPanel } from './components/BroadcastPanel';

function App() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('event_timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    fetch('/api/reservations')
      .then((r) => r.json())
      .then(setReservations);

    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      const { reservation } = JSON.parse(e.data);
      setReservations((prev) => {
        const idx = prev.findIndex((r) => r.reservation_id === reservation.reservation_id);
        if (idx === -1) return [reservation, ...prev];
        const next = [...prev];
        next[idx] = reservation;
        return next;
      });
    };
    return () => es.close();
  }, []);

  const filtered = reservations
    .filter((r) => !statusFilter || r.status === statusFilter)
    .sort((a, b) => {
      const av = a[sortField] ?? '';
      const bv = b[sortField] ?? '';
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });

  function handleSort(field: SortField) {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  }

  async function handleBroadcast(message: string) {
    const guestIds = [...new Set(filtered.map((r) => r.guest_id))];
    const res = await fetch('/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestIds, message }),
    });
    if (!res.ok) throw new Error('Broadcast failed');
  }

  return (
    <>
      <h1>Reservation Dashboard</h1>
      <FilterBar
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        sortField={sortField}
        sortDir={sortDir}
        onSortFieldChange={setSortField}
        onSortDirChange={setSortDir}
      />
      <ReservationTable
        reservations={filtered}
        sortField={sortField}
        sortDir={sortDir}
        onSort={handleSort}
      />
      {statusFilter && filtered.length > 0 && (
        <BroadcastPanel
          recipientCount={new Set(filtered.map((r) => r.guest_id)).size}
          onSend={handleBroadcast}
        />
      )}
    </>
  );
}

export default App;
