import { fetchGuest } from './guestApi';
import { updateGuestInfo } from './db';

const MAX_CONCURRENT = 2;

export function createHydrationQueue(emit: (guestId: string) => void): (guestId: string) => void {
  const queue: string[] = [];
  let activeCount = 0;

  function drain(): void {
    while (activeCount < MAX_CONCURRENT && queue.length > 0) {
      const guestId = queue.shift()!;
      activeCount++;
      runWorker(guestId).finally(() => {
        activeCount--;
        drain();
      });
    }
  }

  async function runWorker(guestId: string): Promise<void> {
    try {
      const info = await fetchGuest(guestId);
      if (info === null) {
        console.log(`[hydration] guest ${guestId} not found or retries exhausted — dropping`);
        return;
      }
      await updateGuestInfo(guestId, info);
      emit(guestId);
    } catch (err) {
      console.error(`[hydration] unexpected error for guest ${guestId}:`, err);
    }
  }

  return function enqueue(guestId: string): void {
    queue.push(guestId);
    drain();
  };
}
