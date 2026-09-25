import { createContext, useContext } from 'react';
import { useStore } from 'zustand';

import type { EditorState, EditorStore } from '../store.js';

export const EditorContext = createContext<EditorStore | null>(null);

/**
 * Subscribe to one slice of editor state.
 *
 * Selectors must return something that already exists in the state (or a
 * primitive): zustand compares by identity, so a selector that builds a new
 * object on every call re-renders forever. Components select narrowly — a box
 * reads its own node and its own run entry, never the whole document.
 */
export function useEditor<T>(selector: (state: EditorState) => T): T {
  return useStore(useEditorStore(), selector);
}

export function useEditorStore(): EditorStore {
  const store = useContext(EditorContext);
  if (!store) throw new Error('useEditor must be used inside <Editor>.');
  return store;
}
