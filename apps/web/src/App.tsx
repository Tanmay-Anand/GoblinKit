import { useCallback, useEffect, useState } from 'react';

import { Editor } from '@goblin/editor';
import type { NodeManifest, WorkflowDocument } from '@goblin/spec';

import logoUrl from '../../../assets/logo/goblinkit-mark.png';
import { api, backend } from './api.js';
import { WorkflowList } from './WorkflowList.js';

// The tab icon is the same transparent mark the rail uses.
const icon = document.createElement('link');
icon.rel = 'icon';
icon.href = logoUrl;
document.head.append(icon);

/** `#/` is the workflow list; `#/w/<id>` opens one on the canvas. */
function readRoute(): { workflowId?: string } {
  const match = location.hash.match(/^#\/w\/([A-Za-z0-9_-]+)/);
  return match?.[1] ? { workflowId: match[1] } : {};
}

export function App() {
  const [route, setRoute] = useState(readRoute);
  const [manifests, setManifests] = useState<NodeManifest[] | null>(null);
  const [doc, setDoc] = useState<WorkflowDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api.nodes().then(setManifests, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    setDoc(null);
    if (!route.workflowId) {
      document.title = 'GoblinKit';
      return;
    }
    api.getWorkflow(route.workflowId).then(
      (d) => {
        setDoc(d);
        document.title = `${d.name} · GoblinKit`;
      },
      (e: Error) => setError(e.message),
    );
  }, [route.workflowId]);

  const open = useCallback((id: string) => {
    location.hash = `#/w/${id}`;
  }, []);
  const back = useCallback(() => {
    location.hash = '#/';
  }, []);

  if (error) {
    return (
      <div className="gk-app-message">
        <img src={logoUrl} alt="" width={96} />
        <h1>GoblinKit can't load</h1>
        <p>{error}</p>
        <button type="button" className="gk-app-primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  }

  if (!manifests) return <div className="gk-app-message">Loading…</div>;

  if (route.workflowId) {
    if (!doc) return <div className="gk-app-message">Opening workflow…</div>;
    return <Editor key={doc.id} doc={doc} manifests={manifests} backend={backend} logoUrl={logoUrl} onBack={back} />;
  }

  return <WorkflowList logoUrl={logoUrl} onOpen={open} />;
}
