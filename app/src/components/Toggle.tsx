export default function Toggle({
  on,
  onChange,
  label,
  hint,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button className="setting-toggle" onClick={() => onChange(!on)} type="button" disabled={disabled}>
      <span className="setting-toggle-text">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </span>
      <span className={`switch ${on ? 'on' : ''}`}>
        <span />
      </span>
    </button>
  );
}
