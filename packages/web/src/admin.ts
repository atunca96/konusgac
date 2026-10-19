import { useSyncExternalStore } from 'react';
import { api } from './api';

// Whether the signed-in account runs this server (KONUSGAC_YONETICILER): it then sees
// Ayarlar → Platform yönetimi and the operators' rows in the right-click menus. The server
// checks it again on every request; this only decides what is shown.

let siteAdmin = false;
const listeners = new Set<() => void>();

export function loadSiteAdmin() {
  api.account().then(
    (a) => {
      siteAdmin = a.siteAdmin;
      listeners.forEach((l) => l());
    },
    () => {},
  );
}

export const isSiteAdmin = () => siteAdmin;

export function useSiteAdmin(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => siteAdmin,
  );
}
