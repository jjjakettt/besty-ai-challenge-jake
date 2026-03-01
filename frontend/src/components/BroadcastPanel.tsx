import { useState } from 'react';

interface BroadcastPanelProps {
  recipientCount: number;
  onSend: (message: string) => Promise<void>;
}

export function BroadcastPanel({ recipientCount, onSend }: BroadcastPanelProps) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState('');

  async function handleSubmit() {
    setSending(true);
    setFeedback('');
    try {
      await onSend(message);
      setMessage('');
      setFeedback('Sent!');
    } catch {
      setFeedback('Error — please retry');
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ marginTop: '16px' }}>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={4}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      <button
        onClick={handleSubmit}
        disabled={sending || message.trim() === ''}
      >
        Broadcast to {recipientCount} guest(s)
      </button>
      {feedback && <p>{feedback}</p>}
    </div>
  );
}
