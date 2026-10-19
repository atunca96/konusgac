import { useEffect, useState } from 'react';
import { api } from './api';
import { desktop } from './notify';

// Whether to offer the Windows app: the server has it at /indir, and we are not already in it.
let offered: Promise<boolean> | null = null;

export function useDesktopDownload(): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (desktop) return;
    offered ??= api.config().then((c) => !!c.desktopApp, () => false);
    void offered.then(setShow);
  }, []);
  return show;
}

export const DOWNLOAD_URL = '/indir';
