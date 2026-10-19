import { useEffect, useState } from 'react';
import { getToken } from '../api';
import { markViewRead, navigate, navigateFromHash, startSession } from '../actions';
import { handleLinks, showNotice, useNotice, useResetToken } from '../links';
import { loadSiteAdmin } from '../admin';
import { desktop, requestNotificationPermission } from '../notify';
import { useSettings } from '../settings';
import { channelById, getState, isUnread, mentionCount, useStore } from '../state';
import { CallView } from './CallView';
import { MenuHost } from '../menu';
import { DialogHost } from '../ui';
import { NativeMenuBridge } from '../nativeMenu';
import { Auth } from './Auth';
import { Chat } from './Chat';
import { Friends } from './Friends';
import { JoinInviteModal } from './modals/JoinInviteModal';
import { MemberList } from './MemberList';
import { ServerRail } from './ServerRail';
import { Sidebar } from './Sidebar';

// Invite links look like /davet/<code>; remember the code until after login.
const pendingInvite = location.pathname.match(/^\/davet\/([\w-]+)/)?.[1] ?? null;

export function App() {
  const connection = useStore((s) => s.connection);
  const me = useStore((s) => s.me);
  const view = useStore((s) => s.view);
  const readStates = useStore((s) => s.readStates);
  const dms = useStore((s) => s.dms);
  const guilds = useStore((s) => s.guilds);
  const showBadge = useSettings((x) => x.unreadBadge);
  const flash = useSettings((x) => x.flashFrame);
  const [invite, setInvite] = useState<string | null>(pendingInvite);

  const resetToken = useResetToken();
  const meId = useStore((s) => s.me?.id);
  useEffect(() => {
    if (meId) loadSiteAdmin();
  }, [meId]);
  const notice = useNotice();

  // Links from e-mails and Google sign-in are handled first: one may bring a new session.
  useEffect(() => {
    navigateFromHash();
    void handleLinks().finally(() => {
      const token = getToken();
      if (token) startSession(token);
    });
  }, []);

  // After (re)connect, load the selected channel.
  useEffect(() => {
    if (connection === 'ready') {
      const v = getState().view;
      navigate(v.guildId, v.channelId);
      requestNotificationPermission();
    }
  }, [connection]);

  // Coming back to the window reads the open channel.
  useEffect(() => {
    window.addEventListener('focus', markViewRead);
    return () => window.removeEventListener('focus', markViewRead);
  }, []);

  // Taskbar badge and tab title: unread DMs plus mentions.
  useEffect(() => {
    const s = getState();
    let count = Object.values(dms).filter((c) => isUnread(s, c)).length;
    for (const g of Object.values(guilds)) for (const c of g.channels) count += mentionCount(s, c.id);
    if (!showBadge) count = 0;
    desktop?.setBadge(count, flash);
    document.title = count ? `(${count}) Konuşgaç` : 'Konuşgaç';
  }, [readStates, dms, guilds, showBadge, flash]);

  if (resetToken || !getToken() || (!me && connection === 'offline')) return <Auth />;
  if (!me)
    return (
      <div className="splash">
        <img src="/logo.svg" alt="" />
        <div className="splash-dots">
          <span />
          <span />
          <span />
        </div>
        <div>Bağlanıyor…</div>
      </div>
    );

  const inGuild = view.guildId !== '@me';
  const viewed = channelById(getState(), view.channelId);
  const call = viewed?.type === 'voice' ? viewed : null;
  const members = inGuild && view.channelId && !call;
  return (
    <div className={`layout ${members ? 'with-members' : ''}`}>
      {connection !== 'ready' && <div className="reconnect-bar">Bağlantı koptu, yeniden bağlanılıyor…</div>}
      {notice && (
        <div className={`notice-bar ${notice.kind}`} onClick={() => showNotice(null)} title="Kapat">
          {notice.text} ✕
        </div>
      )}
      <ServerRail />
      <Sidebar />
      <main className="main">
        {call ? <CallView channel={call} /> : view.channelId ? <Chat channelId={view.channelId} /> : inGuild ? <EmptyGuild /> : <Friends />}
      </main>
      {members && <MemberList guildId={view.guildId} />}
      <MenuHost />
      <DialogHost />
      <NativeMenuBridge />
      {invite && (
        <JoinInviteModal
          initialCode={invite}
          onClose={() => {
            setInvite(null);
            history.replaceState(null, '', '/' + location.hash);
          }}
        />
      )}
    </div>
  );
}

function EmptyGuild() {
  return (
    <div className="empty">
      <h2>Burada görebileceğin bir metin kanalı yok</h2>
      <p>Bir yöneticiden sana kanal erişimi vermesini isteyebilirsin.</p>
    </div>
  );
}
