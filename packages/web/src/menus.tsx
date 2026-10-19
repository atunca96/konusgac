import { hasPerm, Perm, type Channel, type Message } from '@konusgac/shared';
import { api } from './api';
import { decodeMentions, markRead, navigate, openDmWith } from './actions';
import { closeMenu, copyText, type Entry } from './menu';
import { getSettings, updateSettings } from './settings';
import { channelById, channelPerms, displayName, getState, guildPerms, isUnread, myVoiceHere, type State } from './state';
import { canInsertIntoComposer, insertIntoComposer, openDialog } from './ui';
import { joinVoice, leaveVoice } from './voice';
import { isSiteAdmin } from './admin';

// The right-click menus: for each thing that can be right-clicked, what can be done with it.
// "… ID'sini kopyala" rows appear with developer mode on (Ayarlar → Gelişmiş).

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮'];
const fail = (e: unknown) => alert((e as Error).message);
const devId = (label: string, id: string): Entry => getSettings().developerMode && { label, onClick: () => copyText(id), hint: 'ID' };
const sep: Entry = { kind: 'sep' };

// Link that opens a channel (and a message in it) in Konuşgaç.
export function channelLink(c: Channel, messageId?: string): string {
  return `${location.origin}/#/${c.guildId ?? '@me'}/${c.id}${messageId ? `/${messageId}` : ''}`;
}

// ---------- messages ----------

export interface MessageActions {
  canReply: boolean;
  canReact: boolean;
  canDelete: boolean;
  mine: boolean;
  reply(): void;
  edit(): void;
  remove(): void;
  pickReaction(): void;
  toggleReaction(emoji: string): void;
  reacted(emoji: string): boolean;
}

export function messageMenu(m: Message, a: MessageActions, target: HTMLElement | null): Entry[] {
  const channel = channelById(getState(), m.channelId);
  const selection = window.getSelection()?.toString() ?? '';
  const link = target?.closest('a[href]') as HTMLAnchorElement | null;
  const image = target?.closest('.attachment-image img') as HTMLImageElement | null;
  return [
    // What was right-clicked comes first: selected text, a link, an image.
    selection && { label: 'Kopyala', onClick: () => copyText(selection), hint: 'Ctrl+C' },
    image && { label: 'Resmi kopyala', onClick: () => void copyImage(image.src) },
    image && { label: 'Resmi kaydet', onClick: () => download(image.src, image.alt || 'resim') },
    link && { label: 'Bağlantıyı kopyala', onClick: () => copyText(link.href) },
    link && { label: 'Bağlantıyı aç', onClick: () => openLink(link.href) },
    (selection || link || image) && sep,
    a.canReact && {
      kind: 'custom',
      render: () => (
        <div className="ctx-reactions">
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              className={a.reacted(e) ? 'on' : ''}
              onClick={() => {
                closeMenu();
                a.toggleReaction(e);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      ),
    },
    a.canReact && { label: 'Tepki ekle', onClick: a.pickReaction },
    a.mine && { label: 'Mesajı düzenle', onClick: a.edit },
    a.canReply && { label: 'Yanıtla', onClick: a.reply },
    sep,
    m.content && { label: 'Metni kopyala', onClick: () => copyText(decodeMentions(m.content)) },
    channel && { label: 'Okunmadı olarak işaretle', onClick: () => void markUnreadFrom(m).catch(fail) },
    channel && { label: 'Mesaj bağlantısını kopyala', onClick: () => copyText(channelLink(channel, m.id)) },
    sep,
    !a.mine && { label: 'Mesajı şikâyet et', onClick: () => openDialog({ kind: 'report', message: m }), danger: true },
    a.canDelete && { label: 'Mesajı sil', onClick: a.remove, danger: true },
    !a.canDelete &&
      isSiteAdmin() && {
        label: 'Mesajı sil (yönetici)',
        danger: true,
        onClick: () => confirm('Bu mesaj platform yöneticisi olarak silinsin mi?') && void api.adminDeleteMessage(m.id).catch(fail),
      },
    sep,
    devId("Mesaj ID'sini kopyala", m.id),
  ];
}

// Puts the read mark just before this message, so it and everything after it count as unread.
async function markUnreadFrom(m: Message) {
  const log = getState().messages[m.channelId]?.items ?? [];
  const i = log.findIndex((x) => x.id === m.id);
  const before = i > 0 ? log[i - 1]!.id : (BigInt(m.id) - 1n).toString();
  await api.ack(m.channelId, before, true);
}

async function copyImage(src: string) {
  try {
    const blob = await (await fetch(src)).blob();
    // The clipboard takes PNG only; other formats are redrawn as PNG.
    const png = blob.type === 'image/png' ? blob : await toPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch {
    alert('Resim kopyalanamadı');
  }
}

async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
}

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

function openLink(href: string) {
  // Links to Konuşgaç itself open in place; everything else in the browser.
  const url = new URL(href, location.href);
  if (url.origin === location.origin && url.hash.startsWith('#/')) location.hash = url.hash;
  else window.open(url.href, '_blank', 'noopener');
}

// ---------- people ----------

export interface UserMenuContext {
  guildId?: string; // a server's member: roles and kicking
  voice?: boolean; // in our voice channel: volume and local mute
}

export function userMenu(userId: string, ctx: UserMenuContext = {}): Entry[] {
  const s = getState();
  const me = s.me;
  if (!me) return [];
  const self = userId === me.id;
  const user = s.users[userId];
  const name = displayName(s, userId, ctx.guildId);
  const rel = s.relationships[userId];
  const inMyVoice = ctx.voice ?? (!!myVoiceHere(s) && s.voice[userId]?.channelId === myVoiceHere(s)?.channelId);
  const settings = getSettings();

  return [
    canInsertIntoComposer() && user && { label: 'Bahset', onClick: () => insertIntoComposer(`@${user.username} `) },
    !self && { label: 'Mesaj gönder', onClick: () => void openDmWith(userId).catch(fail) },
    self && { label: 'Profili düzenle', onClick: () => openDialog({ kind: 'userSettings' }) },
    sep,
    !self && inMyVoice && { kind: 'custom', render: () => <VolumeSlider userId={userId} /> },
    !self &&
      inMyVoice && {
        kind: 'check',
        label: 'Sustur (yalnızca senin için)',
        checked: !!settings.userMutes[userId],
        onChange: (on) => updateSettings({ userMutes: { ...getSettings().userMutes, [userId]: on } }),
      },
    sep,
    !self && !rel && { label: 'Arkadaş ekle', onClick: () => void api.addFriend({ userId }).catch(fail) },
    !self && rel === 'incoming' && { label: 'Arkadaşlık isteğini kabul et', onClick: () => void api.addFriend({ userId }).catch(fail) },
    !self && rel === 'incoming' && { label: 'Arkadaşlık isteğini reddet', onClick: () => void api.removeRelationship(userId).catch(fail) },
    !self && rel === 'outgoing' && { label: 'Arkadaşlık isteğini geri çek', onClick: () => void api.removeRelationship(userId).catch(fail) },
    !self &&
      rel === 'friend' && {
        label: 'Arkadaşlıktan çıkar',
        danger: true,
        onClick: () => confirm(`${name} arkadaşlarından çıkarılsın mı?`) && void api.removeRelationship(userId).catch(fail),
      },
    ...(ctx.guildId ? memberEntries(s, ctx.guildId, userId, name) : []),
    sep,
    !self && isSiteAdmin() && { label: 'Platformdan yasakla (yönetici)', danger: true, onClick: () => openDialog({ kind: 'ban', userId }) },
    sep,
    devId("Kullanıcı ID'sini kopyala", userId),
  ];
}

// Roles and kicking, for people who may (and only below their own highest role, as the server enforces).
function memberEntries(s: State, guildId: string, userId: string, name: string): Entry[] {
  const g = s.guilds[guildId];
  const me = s.me!;
  const member = g?.members.find((m) => m.userId === userId);
  if (!g || !member) return [];
  const perms = guildPerms(s, guildId);
  const owner = g.guild.ownerId === me.id;
  const top = (uid: string) =>
    g.guild.ownerId === uid
      ? Infinity
      : Math.max(0, ...(g.members.find((m) => m.userId === uid)?.roleIds ?? []).map((id) => g.roles.find((r) => r.id === id)?.position ?? 0));
  const myTop = top(me.id);
  const above = owner || myTop > top(userId);
  const roles = g.roles.filter((r) => r.id !== guildId).sort((a, b) => b.position - a.position);
  return [
    sep,
    hasPerm(perms, Perm.ManageRoles) &&
      roles.length > 0 && {
        kind: 'sub',
        label: 'Roller',
        items: roles.map((r) => ({
          kind: 'check' as const,
          label: r.name,
          checked: member.roleIds.includes(r.id),
          disabled: !owner && r.position >= myTop,
          onChange: (on: boolean) => {
            const current = getState().guilds[guildId]?.members.find((m) => m.userId === userId)?.roleIds ?? [];
            const roleIds = on ? [...new Set([...current, r.id])] : current.filter((id) => id !== r.id);
            void api.updateMember(guildId, userId, { roleIds }).catch(fail);
          },
        })),
      },
    hasPerm(perms, Perm.KickMembers) &&
      userId !== me.id &&
      userId !== g.guild.ownerId &&
      above && {
        label: `${name} adlı kişiyi at`,
        danger: true,
        onClick: () => confirm(`${name} sunucudan atılsın mı?`) && void api.kick(guildId, userId).catch(fail),
      },
    hasPerm(perms, Perm.BanMembers) &&
      userId !== me.id &&
      userId !== g.guild.ownerId &&
      above && { label: `${name} adlı kişiyi yasakla`, danger: true, onClick: () => openDialog({ kind: 'ban', userId, guildId }) },
  ];
}

function VolumeSlider({ userId }: { userId: string }) {
  const value = getSettings().userVolumes[userId] ?? 100;
  return (
    <label className="ctx-slider">
      <span>Kullanıcı ses seviyesi</span>
      <span className="row">
        <input
          type="range"
          min={0}
          max={200}
          defaultValue={value}
          onChange={(e) => {
            updateSettings({ userVolumes: { ...getSettings().userVolumes, [userId]: Number(e.target.value) } });
            (e.target.nextElementSibling as HTMLElement).textContent = `${e.target.value}%`;
          }}
        />
        <span className="small">{value}%</span>
      </span>
    </label>
  );
}

// ---------- channels and categories ----------

export interface CategoryState {
  collapsed: boolean;
  toggle(): void;
  collapseAll(): void;
}

export function channelMenu(c: Channel, category?: CategoryState): Entry[] {
  const s = getState();
  const perms = channelPerms(s, c);
  const manage = hasPerm(perms, Perm.ManageChannels);
  const g = c.guildId ? s.guilds[c.guildId] : undefined;
  const children = c.type === 'category' && g ? g.channels.filter((x) => x.parentId === c.id) : [];
  const unread = c.type === 'category' ? children.some((x) => isUnread(s, x)) : isUnread(s, c);
  const inVoice = s.voiceSelf.channelId === c.id;
  const kindName = c.type === 'category' ? 'Kategoriyi' : 'Kanalı';

  return [
    c.type !== 'voice' && { label: 'Okundu olarak işaretle', disabled: !unread, onClick: () => (c.type === 'category' ? children : [c]).forEach((x) => markRead(x.id)) },
    c.type === 'voice' && !inVoice && hasPerm(perms, Perm.Connect) && { label: 'Kanala katıl', onClick: () => void joinVoice(c.id) },
    c.type === 'voice' && inVoice && { label: 'Bağlantıyı kes', onClick: leaveVoice },
    c.type === 'voice' && c.guildId && { label: 'Görüşmeyi aç', onClick: () => navigate(c.guildId!, c.id) },
    c.type !== 'category' && { label: 'Bağlantıyı kopyala', onClick: () => copyText(channelLink(c)) },
    category && sep,
    category && { kind: 'check', label: 'Kategoriyi daralt', checked: category.collapsed, onChange: () => category.toggle() },
    category && { label: 'Tüm kategorileri daralt', onClick: category.collapseAll },
    sep,
    c.type !== 'category' && hasPerm(perms, Perm.CreateInvite) && { label: 'İnsanları davet et', onClick: () => openDialog({ kind: 'invite', channelId: c.id }) },
    c.type === 'category' && manage && c.guildId && { label: 'Kanal oluştur', onClick: () => openDialog({ kind: 'createChannel', guildId: c.guildId!, parentId: c.id }) },
    manage && { label: `${kindName} düzenle`, onClick: () => openDialog({ kind: 'channelSettings', channel: c }) },
    manage && {
      label: `${kindName} sil`,
      danger: true,
      onClick: () => confirm(`"${c.name}" silinsin mi? Bu geri alınamaz.`) && void api.deleteChannel(c.id).catch(fail),
    },
    sep,
    devId(c.type === 'category' ? "Kategori ID'sini kopyala" : "Kanal ID'sini kopyala", c.id),
  ];
}

// Right-click on the empty part of the channel list.
export function channelListMenu(guildId: string): Entry[] {
  const manage = hasPerm(guildPerms(getState(), guildId), Perm.ManageChannels);
  return [
    manage && { label: 'Kanal oluştur', onClick: () => openDialog({ kind: 'createChannel', guildId, parentId: null }) },
    manage && { label: 'Kategori oluştur', onClick: () => openDialog({ kind: 'createChannel', guildId, parentId: null, type: 'category' }) },
  ];
}

// ---------- servers ----------

export function guildMenu(guildId: string): Entry[] {
  const s = getState();
  const g = s.guilds[guildId];
  if (!g || !s.me) return [];
  const perms = guildPerms(s, guildId);
  const owner = g.guild.ownerId === s.me.id;
  const unread = g.channels.filter((c) => isUnread(s, c));
  const inviteChannel = g.channels.find((c) => c.type === 'text' && hasPerm(channelPerms(s, c), Perm.CreateInvite));
  const manage = hasPerm(perms, Perm.ManageChannels);
  return [
    { label: 'Okundu olarak işaretle', disabled: unread.length === 0, onClick: () => unread.forEach((c) => markRead(c.id)) },
    sep,
    inviteChannel && { label: 'İnsanları davet et', onClick: () => openDialog({ kind: 'invite', channelId: inviteChannel.id }) },
    sep,
    (hasPerm(perms, Perm.ManageGuild) || hasPerm(perms, Perm.ManageRoles) || hasPerm(perms, Perm.KickMembers)) && {
      label: 'Sunucu ayarları',
      onClick: () => openDialog({ kind: 'guildSettings', guildId }),
    },
    manage && { label: 'Kanal oluştur', onClick: () => openDialog({ kind: 'createChannel', guildId, parentId: null }) },
    manage && { label: 'Kategori oluştur', onClick: () => openDialog({ kind: 'createChannel', guildId, parentId: null, type: 'category' }) },
    sep,
    isSiteAdmin() && {
      label: 'Sunucuyu kaldır (yönetici)',
      danger: true,
      onClick: () =>
        confirm(`"${g.guild.name}" ve içindeki her şey platform yöneticisi olarak silinsin mi? Bu geri alınamaz.`) &&
        void api.adminDeleteGuild(guildId).catch(fail),
    },
    !owner && {
      label: 'Sunucudan ayrıl',
      danger: true,
      onClick: () => confirm(`"${g.guild.name}" sunucusundan ayrılmak istiyor musun?`) && void api.leaveGuild(guildId).catch(fail),
    },
    sep,
    devId("Sunucu ID'sini kopyala", guildId),
  ];
}

// ---------- direct messages ----------

export function dmMenu(c: Channel, partner: string | undefined): Entry[] {
  const s = getState();
  return [
    { label: 'Okundu olarak işaretle', disabled: !isUnread(s, c), onClick: () => markRead(c.id) },
    sep,
    ...(partner ? userMenu(partner).filter((e) => !(e && e.kind !== 'sep' && 'label' in e && e.label === 'Mesaj gönder')) : []),
    sep,
    devId("Kanal ID'sini kopyala", c.id),
  ];
}
