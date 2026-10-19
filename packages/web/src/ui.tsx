import type { Channel, Message } from '@konusgac/shared';
import { useSyncExternalStore } from 'react';
import { ChannelSettingsModal } from './components/modals/ChannelSettingsModal';
import { CreateChannelModal } from './components/modals/CreateChannelModal';
import { GuildSettingsModal } from './components/modals/GuildSettingsModal';
import { InviteModal } from './components/modals/InviteModal';
import { BanModal, ReportModal } from './components/modals/ModerationModals';
import { SettingsView } from './components/settings/SettingsView';

// Windows that can be opened from anywhere (a right-click on a server icon opens its settings,
// one on a channel its invite window), and a way to put text into the message box.

export type Dialog =
  | { kind: 'guildSettings'; guildId: string }
  | { kind: 'createChannel'; guildId: string; parentId: string | null; type?: 'text' | 'voice' | 'category' }
  | { kind: 'invite'; channelId: string }
  | { kind: 'channelSettings'; channel: Channel }
  | { kind: 'userSettings'; page?: 'admin' }
  | { kind: 'report'; message: Message }
  | { kind: 'ban'; userId: string; guildId?: string }; // without guildId: from the whole platform

// Open windows, newest last; a window can open over another (a ban window over the settings).
let dialogs: Dialog[] = [];
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// Opens a window over the others; null closes them all.
export function openDialog(d: Dialog | null) {
  dialogs = d ? [...dialogs, d] : [];
  listeners.forEach((l) => l());
}

function closeTop() {
  dialogs = dialogs.slice(0, -1);
  listeners.forEach((l) => l());
}

export function DialogHost() {
  const list = useSyncExternalStore(subscribe, () => dialogs);
  return (
    <>
      {list.map((d, i) => (
        // Each window above the one opened before it (the settings screen is itself a window).
        <div key={i} style={{ position: 'relative', zIndex: 250 + i }}>
          <One d={d} />
        </div>
      ))}
    </>
  );
}

function One({ d }: { d: Dialog }) {
  const close = closeTop;
  switch (d.kind) {
    case 'guildSettings':
      return <GuildSettingsModal guildId={d.guildId} onClose={close} />;
    case 'createChannel':
      return <CreateChannelModal guildId={d.guildId} parentId={d.parentId} initialType={d.type} onClose={close} />;
    case 'invite':
      return <InviteModal channelId={d.channelId} onClose={close} />;
    case 'channelSettings':
      return <ChannelSettingsModal channel={d.channel} onClose={close} />;
    case 'userSettings':
      return <SettingsView onClose={close} initial={d.page} />;
    case 'report':
      return <ReportModal message={d.message} onClose={close} />;
    case 'ban':
      return <BanModal userId={d.userId} guildId={d.guildId} onClose={close} />;
  }
}

// "Bahset": the open message box adds "@name " where the cursor is.
type Inserter = (text: string) => void;
let inserter: Inserter | null = null;

export function registerComposer(fn: Inserter | null) {
  inserter = fn;
}

export function canInsertIntoComposer(): boolean {
  return inserter !== null;
}

export function insertIntoComposer(text: string) {
  inserter?.(text);
}
