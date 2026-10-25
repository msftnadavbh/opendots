import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react';
import type { Dot } from '../shared/types';
import { DotPhotoCache } from './dot-photo-cache';
import { Mascot } from './Mascot';

export const DotPhotos = createContext<DotPhotoCache | null>(null);
const subscribeNone = () => () => {};

export function DotAvatar({
  dot,
  state = 'idle',
  small = false,
  decorative = false,
}: {
  dot?: Dot;
  state?: string;
  small?: boolean;
  decorative?: boolean;
}) {
  const cache = useContext(DotPhotos);
  const dataUrl = useSyncExternalStore(
    cache?.subscribe ?? subscribeNone,
    () => (dot ? cache?.get(dot.id, dot.photoVersion) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (dot?.photoVersion) void cache?.ensure(dot.id, dot.photoVersion);
  }, [cache, dot?.id, dot?.photoVersion]);
  return (
    <Mascot
      identity={dot?.id}
      name={dot?.name}
      state={state}
      small={small}
      decorative={decorative}
      photo={dataUrl}
    />
  );
}
