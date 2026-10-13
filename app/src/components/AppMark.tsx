import { ArrowUp } from 'lucide-react';
import { useEffect } from 'react';
import { hideUpdateHint, useUpdate } from '../store/update';
import Logo from './Logo';

/** The lotus in the header, or a moving up arrow when a newer app is out (tap to download it). */
export default function AppMark() {
  const version = useUpdate((s) => s.version);
  const url = useUpdate((s) => s.url);
  const hint = useUpdate((s) => s.hint);

  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(hideUpdateHint, 6000);
    return () => clearTimeout(t);
  }, [hint]);

  if (!version) return <Logo size={34} />;
  return (
    <span className="update-mark">
      <a className="update-btn" href={url} target="_blank" rel="noreferrer" aria-label={`Update to ${version}`} onClick={hideUpdateHint}>
        <ArrowUp size={20} strokeWidth={2.8} />
      </a>
      {hint && (
        <a className="update-tip" href={url} target="_blank" rel="noreferrer" onClick={hideUpdateHint}>
          Update now
        </a>
      )}
    </span>
  );
}
