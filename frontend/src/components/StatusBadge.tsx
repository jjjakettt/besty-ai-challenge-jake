const COLOURS: Record<string, string> = {
  confirmed: 'green',
  modified: 'goldenrod',
  cancelled: 'red',
};

export function StatusBadge({ status }: { status: string }) {
  const color = COLOURS[status] ?? 'grey';
  return (
    <span
      data-status={status}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '12px',
        background: color,
        color: 'white',
        fontWeight: 600,
        fontSize: '0.8em',
      }}
    >
      {status}
    </span>
  );
}
