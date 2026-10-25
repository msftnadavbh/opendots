import { useState } from 'react';

const characters = ['blue', 'mint', 'orange', 'purple'] as const;

/** Stable identity keeps each specialist recognizable across views and reloads. */
function characterFor(identity?: string) {
  if (!identity) return characters[0];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return characters[hash % characters.length];
}

export function Mascot({
  state = 'idle',
  small = false,
  identity,
  name = 'Dot',
  decorative = false,
  photo,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  name?: string;
  decorative?: boolean;
  photo?: string;
}) {
  const [failedPhoto, setFailedPhoto] = useState<string>();
  const [loadedPhoto, setLoadedPhoto] = useState<string>();
  const showPhoto = photo && photo !== failedPhoto;
  const ready = showPhoto && photo === loadedPhoto;
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
      {!ready && (
        <img
          className="dot-body"
          src={`/dots/${characterFor(identity)}.png`}
          alt={decorative ? '' : `${name} is ${state}`}
          width={512}
          height={512}
          draggable={false}
        />
      )}
      {showPhoto && (
        <img
          key={photo}
          className="dot-body dot-photo"
          src={photo}
          alt={decorative ? '' : `${name} is ${state}`}
          style={ready ? undefined : { display: 'none' }}
          width={512}
          height={512}
          draggable={false}
          onLoad={() => setLoadedPhoto(photo)}
          onError={() => setFailedPhoto(photo)}
        />
      )}
    </span>
  );
}
