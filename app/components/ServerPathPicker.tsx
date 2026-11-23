import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, File as FileIcon, Folder, FolderPlus, HardDrive, Loader2, X } from 'lucide-react';
import { apiUrl } from '../services/apiBase';
import { isDesktop } from '../services/externalLinks';

/**
 * A folder or file on the studio's computer, picked in the page.
 *
 * The desktop window asks the studio for the system dialog. A browser cannot:
 * the dialog would open on the studio's computer, not in front of the person,
 * and the service run on its own has no window to show one in at all. So a
 * browser gets this picker, which lists the studio computer's folders through
 * `/v1/fs/list` and hands back the path the person chose.
 */

export interface PickOptions {
  title: string;
  /** `folder` chooses the folder being shown; `file` chooses a file in it. */
  kind?: 'folder' | 'file';
  /** Where to open; the last folder chosen, then the home folder, otherwise. */
  start?: string;
}

interface Entry { name: string; dir: boolean }
interface Place { name: string; path: string }
interface Listing { path: string; parent: string | null; separator: string; entries: Entry[]; places: Place[] }

const LAST = 'studio:server-picker:last';

/** True where the page draws its own picker: anywhere but the desktop window. */
export function pickerInPage(): boolean {
  return !isDesktop();
}

/** Opens the picker; the chosen full path, or null when the person cancels. */
export function pickServerPath(options: PickOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (path: string | null) => {
      // unmounting from inside the root's own event is deferred a tick
      window.setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
      resolve(path);
    };
    root.render(<ServerPathPicker {...options} onDone={done} />);
  });
}

function remembered(): string | undefined {
  try {
    return localStorage.getItem(LAST) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(folder: string): void {
  try {
    localStorage.setItem(LAST, folder);
  } catch {
    // a browser that keeps nothing starts at home next time
  }
}

function join(folder: string, name: string, separator: string): string {
  return folder.endsWith(separator) ? `${folder}${name}` : `${folder}${separator}${name}`;
}

async function answer<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body as T;
}

const BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:border-pink-400 hover:text-pink-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:text-zinc-200';
const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-lg bg-linear-to-r from-orange-500 to-pink-600 px-3 py-1.5 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50';
const INPUT =
  'w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-900 outline-none focus:border-pink-400 dark:border-white/15 dark:bg-black/30 dark:text-zinc-100';

export const ServerPathPicker: React.FC<PickOptions & { onDone: (path: string | null) => void }> = ({ title, kind = 'folder', start, onDone }) => {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);

  const open = useCallback(async (path?: string, showHidden = hidden) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (path) query.set('path', path);
      if (kind === 'file') query.set('files', 'true');
      if (showHidden) query.set('hidden', 'true');
      const next = await answer<Listing>(await fetch(apiUrl(`/v1/fs/list?${query}`)));
      setListing(next);
      setTyped(next.path);
      setSelected(null);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setLoading(false);
    }
  }, [hidden, kind]);

  useEffect(() => {
    // the place asked for, else the last one; a folder that is gone falls back to home
    void (async () => {
      const first = start || remembered();
      if (!(await open(first)) && first) await open();
    })();
    // opened once, where it was asked to
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && naming === null) onDone(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [naming, onDone]);

  const choose = (path: string | null) => {
    const chosen = path?.trim();
    if (!chosen) return;
    if (listing) remember(kind === 'file' ? listing.path : chosen);
    onDone(chosen);
  };

  const makeFolder = async () => {
    const name = naming?.trim();
    if (!listing || !name) return;
    try {
      const made = await answer<{ path: string }>(await fetch(apiUrl('/v1/fs/folder'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: listing.path, name }),
      }));
      setNaming(null);
      await open(made.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // a folder picker chooses what the field says; a file picker needs a file
  const answerPath = kind === 'file' ? selected : typed;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onDone(null); }}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-white/10 dark:bg-suno-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-zinc-900 dark:text-white">{title}</h2>
            <p className="text-xs text-zinc-500">On the computer the studio runs on.</p>
          </div>
          <button type="button" onClick={() => onDone(null)} className="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Close" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && void open(listing.parent)}
            title="Up one folder"
            aria-label="Up one folder"
          >
            <ArrowUp size={13} />
          </button>
          <input
            className={INPUT}
            value={typed}
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void open(typed.trim()); }}
            aria-label="Path"
          />
          {loading && <Loader2 size={14} className="shrink-0 animate-spin text-zinc-400" />}
        </div>

        {listing && listing.places.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {listing.places.map((place) => (
              <button
                key={place.path}
                type="button"
                onClick={() => void open(place.path)}
                className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 hover:border-pink-400 hover:text-pink-600 dark:border-white/10 dark:text-zinc-300"
                title={place.path}
              >
                <HardDrive size={11} />
                {place.name}
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 min-h-[240px] flex-1 overflow-y-auto rounded-lg border border-zinc-200 dark:border-white/10">
          {listing?.entries.length === 0 && !loading && (
            <p className="p-3 text-xs text-zinc-500">{kind === 'file' ? 'Nothing in this folder.' : 'No folders in this folder.'}</p>
          )}
          {listing?.entries.map((entry) => {
            const path = join(listing.path, entry.name, listing.separator);
            const isSelected = !entry.dir && selected === path;
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() => (entry.dir ? void open(path) : setSelected(path))}
                onDoubleClick={() => { if (!entry.dir) choose(path); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-white/5 ${isSelected ? 'bg-pink-50 text-pink-700 dark:bg-pink-500/10 dark:text-pink-300' : 'text-zinc-800 dark:text-zinc-200'}`}
              >
                {entry.dir ? <Folder size={14} className="shrink-0 text-amber-500" /> : <FileIcon size={14} className="shrink-0 text-zinc-400" />}
                <span className="truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>

        {error && <p className="mt-2 text-xs text-red-500" role="alert">{error}</p>}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(event) => { setHidden(event.target.checked); void open(listing?.path, event.target.checked); }}
            />
            Show hidden
          </label>
          {kind === 'folder' && (naming === null ? (
            <button type="button" className={BUTTON} disabled={!listing} onClick={() => setNaming('')}>
              <FolderPlus size={13} />New folder
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <input
                autoFocus
                className={`${INPUT} w-40`}
                placeholder="Folder name"
                value={naming}
                onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void makeFolder();
                  if (event.key === 'Escape') { event.stopPropagation(); setNaming(null); }
                }}
              />
              <button type="button" className={BUTTON} disabled={!naming?.trim()} onClick={() => void makeFolder()}>Make</button>
              <button type="button" className={BUTTON} onClick={() => setNaming(null)}>Cancel</button>
            </span>
          ))}
          <span className="flex-1" />
          <button type="button" className={BUTTON} onClick={() => onDone(null)}>Cancel</button>
          <button type="button" className={PRIMARY} disabled={!answerPath?.trim() || loading} onClick={() => choose(answerPath)}>
            {kind === 'file' ? 'Choose file' : 'Choose this folder'}
          </button>
        </div>
      </div>
    </div>
  );
};
