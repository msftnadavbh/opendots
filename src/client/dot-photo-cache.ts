export interface DotPhoto {
  photoVersion: string;
  dataUrl: string;
}

export class DotPhotoCache {
  private entries = new Map<
    string,
    { version: string; dataUrl?: string; request?: Promise<void> }
  >();
  private listeners = new Set<() => void>();

  constructor(private load: (id: string) => Promise<DotPhoto>) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(id: string, version?: string | null) {
    const entry = this.entries.get(id);
    return entry && entry.version === version ? entry.dataUrl : undefined;
  }

  async ensure(id: string, version: string) {
    const current = this.entries.get(id);
    if (current?.version === version) return current.request;
    const entry: {
      version: string;
      dataUrl?: string;
      request?: Promise<void>;
    } = { version };
    this.entries.set(id, entry);
    entry.request = this.load(id)
      .then((photo) => {
        if (this.entries.get(id) !== entry || photo.photoVersion !== version)
          return;
        entry.dataUrl = photo.dataUrl;
        this.emit();
      })
      .catch(() => {
        // Permit a later mount to retry without making unchanged avatars poll.
        if (this.entries.get(id) === entry) this.entries.delete(id);
      });
    return entry.request;
  }

  clear() {
    this.entries.clear();
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
