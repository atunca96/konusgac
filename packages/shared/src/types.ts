// Snowflake: 64-bit, time-ordered ID serialized as a decimal string.
export type Snowflake = string;

export type PresenceStatus = 'online' | 'offline';

export interface User {
  id: Snowflake;
  username: string;
  displayName: string;
  avatarColor: string;
}

export interface Guild {
  id: Snowflake;
  name: string;
  ownerId: Snowflake;
  iconColor: string;
}

export type ChannelType = 'text' | 'voice' | 'category' | 'dm';

// Role-scoped permission overwrite on a guild channel.
export interface PermissionOverwrite {
  roleId: Snowflake;
  allow: number;
  deny: number;
}

export interface Channel {
  id: Snowflake;
  guildId: Snowflake | null;
  type: ChannelType;
  name: string;
  parentId: Snowflake | null;
  position: number;
  topic: string;
  overwrites: PermissionOverwrite[];
  recipientIds: Snowflake[]; // only for DM channels
  lastMessageId: Snowflake | null;
}

export interface Role {
  id: Snowflake; // the @everyone role shares its guild's ID
  guildId: Snowflake;
  name: string;
  color: string;
  permissions: number;
  position: number;
}

export interface Member {
  guildId: Snowflake;
  userId: Snowflake;
  nick: string | null;
  roleIds: Snowflake[];
  joinedAt: number;
}

export interface Attachment {
  id: Snowflake;
  filename: string;
  size: number; // bytes
  contentType: string; // sniffed by the server from the file's bytes, never taken from the client
  url: string; // unguessable path under /attachments/
}

// Emoji reactions on a message, one entry per emoji in first-use order.
export interface Reaction {
  emoji: string;
  userIds: Snowflake[];
}

// Snapshot of the message being replied to; null fields mean it was deleted.
export interface MessageReference {
  id: Snowflake;
  authorId: Snowflake | null;
  content: string | null;
}

export interface Message {
  id: Snowflake;
  channelId: Snowflake;
  authorId: Snowflake;
  content: string; // user mentions are stored as <@userId>
  createdAt: number;
  editedAt: number | null;
  replyTo: MessageReference | null;
  mentionIds: Snowflake[]; // users mentioned with <@id> who can see the channel
  mentionEveryone: boolean; // @everyone, only honored with the MentionEveryone permission
  attachments: Attachment[];
  reactions: Reaction[];
}

// Where a user stopped reading a channel; unread = channel.lastMessageId > lastReadId.
export interface ReadState {
  channelId: Snowflake;
  lastReadId: Snowflake | null;
  mentionCount: number;
}


export type RelationshipType = 'friend' | 'incoming' | 'outgoing';

export interface Relationship {
  userId: Snowflake; // the other user
  type: RelationshipType;
}

export interface Invite {
  code: string;
  guildId: Snowflake;
  channelId: Snowflake;
  creatorId: Snowflake;
  uses: number;
  maxUses: number;
  expiresAt: number | null;
}

export interface InvitePreview {
  code: string;
  guild: Guild;
  memberCount: number;
}

export interface GuildState {
  guild: Guild;
  channels: Channel[];
  roles: Role[];
  members: Member[];
}

// Who sits in which voice channel. A user holds at most one voice session, owned by
// one gateway connection (sessionId); channelId null means the user just left.
export interface VoiceState {
  userId: Snowflake;
  guildId: Snowflake;
  channelId: Snowflake | null;
  sessionId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  selfVideo: boolean; // camera on
  selfStream: boolean; // sharing the screen (going live)
  suppress: boolean; // lacks the Speak permission in this channel
}

// What a voice participant sends to the voice server: one stream per source.
export type MediaSource = 'mic' | 'camera' | 'screen' | 'screenAudio';
export const MEDIA_SOURCES: readonly MediaSource[] = ['mic', 'camera', 'screen', 'screenAudio'];

// A stream someone in our voice channel is sending, which we can receive.
export interface RtcProducer {
  producerId: string;
  userId: Snowflake;
  source: MediaSource;
}

export interface ReadyPayload {
  sessionId: string; // this connection's gateway session
  user: User;
  guilds: GuildState[];
  voiceStates: VoiceState[];
  dmChannels: Channel[];
  relationships: Relationship[];
  users: User[];
  presences: Record<Snowflake, PresenceStatus>;
  readStates: ReadState[];
}

// Account-wide privacy, enforced by the server.
export interface PrivacySettings {
  dmFromServerMembers: boolean; // people who share a server (and are not friends) may DM you
  friendRequests: { everyone: boolean; friendsOfFriends: boolean; serverMembers: boolean };
}

// A signed-in device (one session token).
export interface Session {
  id: string;
  userAgent: string;
  createdAt: number;
  lastUsed: number;
  current: boolean;
}

export interface SearchResult {
  messages: Message[];
  hasMore: boolean;
}

export const LIMITS = {
  usernameMin: 2,
  usernameMax: 32,
  displayNameMax: 32,
  passwordMin: 8,
  passwordMax: 128,
  guildNameMax: 100,
  channelNameMax: 100,
  topicMax: 1024,
  roleNameMax: 100,
  messageMax: 2000,
  historyPage: 50,
  attachmentsPerMessage: 10,
  reactionsPerMessage: 20, // distinct emojis
  emojiMax: 32, // bytes of one emoji string
  searchPage: 25,
  searchQueryMax: 200,
} as const;

// Why a message is reported (the report form's choices).
export type ReportReason = 'illegal' | 'child' | 'harassment' | 'spam' | 'privacy' | 'copyright' | 'other';
export const REPORT_REASONS: Record<ReportReason, string> = {
  illegal: 'Yasa dışı içerik',
  child: 'Çocukların istismarı',
  harassment: 'Taciz, tehdit ya da nefret söylemi',
  spam: 'Spam ya da dolandırıcılık',
  privacy: 'Kişisel bilgilerin ya da görüntülerin izinsiz paylaşımı',
  copyright: 'Telif ya da marka ihlali',
  other: 'Diğer',
};

// A report, as the platform's operators see it. The message's text and files are copied when
// it is reported, so the evidence stays even if the message is deleted.
export interface Report {
  id: Snowflake;
  reason: ReportReason;
  note: string;
  status: 'open' | 'resolved';
  createdAt: number;
  reporter: User | null;
  author: User | null;
  messageId: Snowflake | null;
  messageExists: boolean;
  channelId: Snowflake;
  guildId: Snowflake | null;
  guildName: string | null;
  channelName: string | null;
  content: string;
  attachments: string[]; // file names
}

export interface GuildBan {
  user: User;
  reason: string;
  createdAt: number;
}

export interface PlatformBan {
  user: User;
  reason: string;
  bannedAt: number;
}
