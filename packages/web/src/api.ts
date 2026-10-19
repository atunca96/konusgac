import type { Channel, GuildCreatePayload, GuildState, Invite, InvitePreview, Member, Message, PermissionOverwrite, PrivacySettings, Role, SearchResult, Session, User } from '@konusgac/shared';
import type { GuildBan, PlatformBan, Report, ReportReason } from '@konusgac/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = localStorage.getItem('konusgac.token');

export function getToken() {
  return token;
}

export function setToken(value: string | null) {
  token = value;
  if (value) localStorage.setItem('konusgac.token', value);
  else localStorage.removeItem('konusgac.token');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `İstek başarısız (${res.status})`);
  return data as T;
}

type Auth = { token: string; user: User };

// The account's private details (only ever sent to its owner).
export interface Account {
  email: string | null;
  emailVerified: boolean;
  hasPassword: boolean; // false: made with Google, no password chosen yet
  google: boolean;
  siteAdmin: boolean; // runs this server: Ayarlar → Platform yönetimi
}

export const api = {
  register: (username: string, password: string, displayName: string, email?: string) =>
    request<Auth>('POST', '/auth/register', { username, password, displayName, acceptTerms: true, ...(email ? { email } : {}) }),
  forgotPassword: (email: string) => request<void>('POST', '/auth/password/forgot', { email }),
  resetPassword: (token: string, password: string) => request<void>('POST', '/auth/password/reset', { token, password }),
  verifyEmail: (token: string) => request<{ email: string }>('POST', '/auth/email/verify', { token }),
  googleExchange: (code: string) => request<Auth>('POST', '/auth/google/exchange', { code }),
  account: () => request<Account>('GET', '/users/@me/account'),
  setEmail: (email: string, password?: string) => request<Account>('PUT', '/users/@me/email', { email, ...(password ? { password } : {}) }),
  resendVerification: () => request<void>('POST', '/users/@me/email/verify'),
  // moderation
  report: (messageId: string, reason: ReportReason, note: string) => request<void>('POST', '/reports', { messageId, reason, note }),
  guildBans: (guildId: string) => request<GuildBan[]>('GET', `/guilds/${guildId}/bans`),
  guildBan: (guildId: string, userId: string, reason: string) => request<void>('PUT', `/guilds/${guildId}/bans/${userId}`, { reason }),
  guildUnban: (guildId: string, userId: string) => request<void>('DELETE', `/guilds/${guildId}/bans/${userId}`),
  adminReports: (status: 'open' | 'resolved') => request<Report[]>('GET', `/admin/reports?status=${status}`),
  adminResolveReport: (id: string) => request<void>('POST', `/admin/reports/${id}/resolve`),
  adminDeleteMessage: (messageId: string) => request<void>('DELETE', `/admin/messages/${messageId}`),
  adminDeleteGuild: (guildId: string) => request<void>('DELETE', `/admin/guilds/${guildId}`),
  adminBans: () => request<PlatformBan[]>('GET', '/admin/bans'),
  adminBan: (userId: string, reason: string, deleteRecentMessages: boolean) =>
    request<void>('PUT', `/admin/users/${userId}/ban`, { reason, deleteRecentMessages }),
  adminUnban: (userId: string) => request<void>('DELETE', `/admin/users/${userId}/ban`),
  login: (username: string, password: string) => request<Auth>('POST', '/auth/login', { username, password }),
  logout: () => request<void>('POST', '/auth/logout'),

  config: () => request<{ registration: 'open' | 'closed'; desktopApp?: boolean; mail?: boolean; google?: boolean }>('GET', '/config'),
  updateMe: (patch: { displayName?: string; avatarColor?: string }) => request<User>('PATCH', '/users/@me', patch),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('PUT', '/users/@me/password', { currentPassword, newPassword }),
  deleteAccount: (password: string) => request<void>('DELETE', '/users/@me', { password }),
  privacy: () => request<PrivacySettings>('GET', '/users/@me/settings'),
  setPrivacy: (p: PrivacySettings) => request<PrivacySettings>('PATCH', '/users/@me/settings', p),
  sessions: () => request<Session[]>('GET', '/users/@me/sessions'),
  deleteSession: (id: string) => request<void>('DELETE', `/users/@me/sessions/${id}`),
  deleteOtherSessions: () => request<void>('DELETE', '/users/@me/sessions'),
  addFriend: (target: { username: string } | { userId: string }) => request<void>('POST', '/users/@me/relationships', target),
  removeRelationship: (userId: string) => request<void>('DELETE', `/users/@me/relationships/${userId}`),
  openDm: (recipientId: string) => request<Channel>('POST', '/users/@me/channels', { recipientId }),

  createGuild: (name: string) => request<GuildState>('POST', '/guilds', { name }),
  updateGuild: (guildId: string, patch: { name?: string; ownerId?: string }) => request('PATCH', `/guilds/${guildId}`, patch),
  deleteGuild: (guildId: string) => request<void>('DELETE', `/guilds/${guildId}`),
  leaveGuild: (guildId: string) => request<void>('DELETE', `/guilds/${guildId}/members/@me`),
  kick: (guildId: string, userId: string) => request<void>('DELETE', `/guilds/${guildId}/members/${userId}`),
  updateMember: (guildId: string, userId: string, patch: { nick?: string | null; roleIds?: string[] }) =>
    request<Member>('PATCH', `/guilds/${guildId}/members/${userId}`, patch),

  createRole: (guildId: string, role: { name: string; color: string; permissions: number }) =>
    request<Role>('POST', `/guilds/${guildId}/roles`, role),
  updateRole: (guildId: string, roleId: string, patch: { name?: string; color?: string; permissions?: number }) =>
    request<Role>('PATCH', `/guilds/${guildId}/roles/${roleId}`, patch),
  deleteRole: (guildId: string, roleId: string) => request<void>('DELETE', `/guilds/${guildId}/roles/${roleId}`),

  createChannel: (guildId: string, input: { name: string; type: 'text' | 'voice' | 'category'; parentId?: string | null; topic?: string }) =>
    request<Channel>('POST', `/guilds/${guildId}/channels`, input),
  updateChannel: (channelId: string, patch: { name?: string; topic?: string; parentId?: string | null; overwrites?: PermissionOverwrite[] }) =>
    request<Channel>('PATCH', `/channels/${channelId}`, patch),
  deleteChannel: (channelId: string) => request<void>('DELETE', `/channels/${channelId}`),

  messages: (channelId: string, before?: string) =>
    request<Message[]>('GET', `/channels/${channelId}/messages${before ? `?before=${before}` : ''}`),
  sendMessage: (channelId: string, input: { content: string; replyToId?: string | null; files?: File[] }) => {
    if (!input.files?.length) return request<Message>('POST', `/channels/${channelId}/messages`, { content: input.content, replyToId: input.replyToId ?? null });
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: input.content, replyToId: input.replyToId ?? null }));
    for (const f of input.files) form.append('files', f, f.name);
    return request<Message>('POST', `/channels/${channelId}/messages`, form);
  },
  react: (channelId: string, messageId: string, emoji: string, on: boolean) =>
    request<void>(on ? 'PUT' : 'DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`),
  // manual: "Okunmadı olarak işaretle" (may move the read mark back)
  ack: (channelId: string, messageId: string, manual = false) =>
    request<void>('POST', `/channels/${channelId}/ack`, manual ? { messageId, manual } : { messageId }),
  search: (query: string, scope: { guildId?: string; channelId?: string }, before?: string) => {
    const q = new URLSearchParams({ q: query, ...scope, ...(before ? { before } : {}) });
    return request<SearchResult>('GET', `/search?${q}`);
  },
  editMessage: (channelId: string, messageId: string, content: string) =>
    request<Message>('PATCH', `/channels/${channelId}/messages/${messageId}`, { content }),
  deleteMessage: (channelId: string, messageId: string) => request<void>('DELETE', `/channels/${channelId}/messages/${messageId}`),
  typing: (channelId: string) => request<void>('POST', `/channels/${channelId}/typing`),

  createInvite: (channelId: string) => request<Invite>('POST', `/channels/${channelId}/invites`, {}),
  previewInvite: (code: string) => request<InvitePreview>('GET', `/invites/${encodeURIComponent(code)}`),
  joinInvite: (code: string) => request<GuildCreatePayload>('POST', `/invites/${encodeURIComponent(code)}`),
};
