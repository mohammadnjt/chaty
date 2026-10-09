import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorText } from '../lib/api';
import { fileNameFor, shrinkImage } from '../lib/media';
import { useConfig } from '../store/config';
import { loadStories } from '../store/stories';
import { toast } from '../store/toast';

/** Preview a picked photo or video, add a caption and share it as a story. */
export default function StoryComposer({ file, onClose }: { file: File; onClose: () => void }) {
  const maxMB = useConfig((s) => s.maxUploadMB);
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const video = file.type.startsWith('video/');
  const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState<number | null>(null);

  async function share() {
    setProgress(0);
    try {
      const { blob, name } = video ? { blob: file as Blob, name: fileNameFor(file) } : await shrinkImage(file);
      if (blob.size > maxMB * 1024 * 1024) throw new Error(`A story can be up to ${maxMB} MB`);
      await api.postStory(blob, name, caption.trim(), setProgress);
      await loadStories();
      toast('Story shared');
      onClose();
    } catch (e) {
      toast(errorText(e));
      setProgress(null);
    }
  }

  return createPortal(
    <div className="story-screen">
      {video ? (
        <video src={url} className="story-media" autoPlay loop playsInline muted />
      ) : (
        <img src={url} className="story-media" alt="" />
      )}
      <header className="story-top">
        <div className="story-head">
          <button className="icon-btn" onClick={onClose} aria-label="Cancel" disabled={progress !== null}>
            <X size={24} />
          </button>
          <span className="story-head-title">New story</span>
        </div>
      </header>
      <div className="story-bottom story-compose">
        <input
          className="field"
          placeholder="Add a caption…"
          value={caption}
          maxLength={300}
          dir="auto"
          onChange={(e) => setCaption(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && progress === null && void share()}
        />
        <button className="btn btn-primary" onClick={() => void share()} disabled={progress !== null}>
          {progress === null ? 'Share' : `${Math.round(progress * 100)}%`}
        </button>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}
