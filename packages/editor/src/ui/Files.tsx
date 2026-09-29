import type { Envelope } from '@goblin/spec';

import { useEditor } from './context.js';
import { Icon } from './icons.js';

/** Images a box made are shown, not only linked: a chart is for looking at. */
const PREVIEWABLE = new Set(['image/svg+xml', 'image/png']);

/**
 * Files a box made — a report, an export, a chart — as download links, with
 * images shown inline. Items carry only a reference; the bytes stay on the
 * server until someone asks.
 */
export function FileLinks({ envelopes }: { envelopes: readonly Envelope[] }) {
  const blobUrl = useEditor((s) => s.blobUrl);
  const files = envelopes.flatMap((env) => env.items.flatMap((item) => Object.entries(item.binary ?? {}).map(([name, ref]) => ({ name, ref }))));
  if (!files.length) return null;
  return (
    <ul className="gk-files" aria-label="Files">
      {files.map(({ name, ref }) => (
        <li key={`${name}:${ref.key}`}>
          {PREVIEWABLE.has(ref.mimeType) ? (
            // An <img> never runs an SVG's scripts, so showing one is safe.
            <img className="gk-file-preview" src={blobUrl(ref)} alt={ref.fileName ?? name} />
          ) : null}
          <a className="gk-file-link" href={blobUrl(ref)} download={ref.fileName ?? name}>
            <Icon name="download" size={14} />
            <span>{ref.fileName ?? name}</span>
            <span className="gk-muted">{size(ref.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
