export interface Reservation {
  reservation_id: string;
  property_id: string;
  guest_id: string;
  status: string;
  check_in: string;
  check_out: string;
  num_guests: number;
  total_amount: string;
  currency: string;
  webhook_id: string;
  event_timestamp: string;
  guest_first_name?: string;
  guest_last_name?: string;
  guest_email?: string;
  guest_phone?: string;
}

export type SortDir = 'asc' | 'desc';
export type SortField = keyof Reservation;
