import { useState } from 'react';
import type { Dot } from '../shared/types';
import { api } from './api';
import { DotAvatar } from './DotAvatar';
import { prepareDotPhoto } from './prepare-dot-photo';

export function DotPhotoSettings({
  dot,
  onSaved,
}: {
  dot: Dot;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const save = async (file?: File) => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const dataUrl = file ? await prepareDotPhoto(file) : undefined;
      await api(
        `/dots/${dot.id}/photo`,
        file ? 'PUT' : 'DELETE',
        file ? { dataUrl } : undefined,
      );
      await onSaved();
      setStatus(file ? 'Photo saved.' : 'Photo removed.');
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not save photo.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="dot-photo-settings" disabled={busy}>
      <legend>Photo</legend>
      <DotAvatar dot={dot} small decorative />
      <label className="field-label" htmlFor="dot-photo">
        Replace photo
      </label>
      <input
        id="dot-photo"
        type="file"
        accept="image/jpeg,image/png"
        aria-describedby="dot-photo-help"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void save(file);
        }}
      />
      <p className="muted" id="dot-photo-help">
        JPEG or PNG, up to 10 MiB. Saved immediately, separately from name and
        instructions. Resized to fit 512 × 512 with a white background.
      </p>
      <button
        type="button"
        disabled={!dot.photoVersion}
        onClick={() => void save()}
      >
        Remove photo
      </button>
      <p role="status">{busy ? 'Saving photo…' : status}</p>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
