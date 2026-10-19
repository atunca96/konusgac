import { useEffect } from 'react';
import { openMenuAt, type Entry } from './menu';
import { desktop } from './notify';

// In the desktop app, right-clicks that no Konuşgaç menu handles (text boxes, selected text, plain
// links) get the same-looking menu instead of nothing: spelling suggestions, cut, copy, paste.
// The app's main process reports what was clicked and does the editing (it owns the spell checker).
// In a browser the browser's own menu does this.

export interface NativeMenuParams {
  x: number;
  y: number;
  isEditable: boolean;
  selectionText: string;
  misspelledWord: string;
  dictionarySuggestions: string[];
  linkURL: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean; canUndo: boolean; canRedo: boolean };
}

export type NativeAction = 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo' | 'replace' | 'learn' | 'copyLink';

function entries(p: NativeMenuParams): Entry[] {
  const act = (action: NativeAction, arg?: string) => () => desktop?.nativeMenuAction?.(action, arg);
  const f = p.editFlags;
  return [
    ...p.dictionarySuggestions.slice(0, 5).map((word) => ({ label: word, onClick: act('replace', word) })),
    p.misspelledWord && p.dictionarySuggestions.length === 0 && { label: 'Öneri yok', onClick: () => {}, disabled: true },
    p.misspelledWord && { label: 'Sözlüğe ekle', onClick: act('learn', p.misspelledWord) },
    p.misspelledWord && { kind: 'sep' },
    p.linkURL && !p.isEditable && { label: 'Bağlantıyı kopyala', onClick: act('copyLink', p.linkURL) },
    p.linkURL && !p.isEditable && { label: 'Bağlantıyı aç', onClick: () => window.open(p.linkURL, '_blank', 'noopener') },
    p.linkURL && !p.isEditable && { kind: 'sep' },
    p.isEditable && { label: 'Geri al', onClick: act('undo'), disabled: !f.canUndo, hint: 'Ctrl+Z' },
    p.isEditable && { label: 'Yinele', onClick: act('redo'), disabled: !f.canRedo, hint: 'Ctrl+Y' },
    p.isEditable && { kind: 'sep' },
    p.isEditable && { label: 'Kes', onClick: act('cut'), disabled: !f.canCut, hint: 'Ctrl+X' },
    (p.isEditable || p.selectionText) && { label: 'Kopyala', onClick: act('copy'), disabled: !f.canCopy, hint: 'Ctrl+C' },
    p.isEditable && { label: 'Yapıştır', onClick: act('paste'), disabled: !f.canPaste, hint: 'Ctrl+V' },
    p.isEditable && { kind: 'sep' },
    p.isEditable && { label: 'Tümünü seç', onClick: act('selectAll'), disabled: !f.canSelectAll, hint: 'Ctrl+A' },
  ];
}

export function NativeMenuBridge() {
  useEffect(() => {
    desktop?.onNativeMenu?.((p) => openMenuAt(p.x, p.y, entries(p)));
  }, []);
  return null;
}
