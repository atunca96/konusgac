// Gateway wire protocol: JSON frames over a single WebSocket.
// The client authenticates with IDENTIFY, keeps the link alive with HEARTBEAT,
// and receives every state change as a DISPATCH event.

import type {
  Channel,
  Guild,
  GuildState,
  Member,
  Message,
  PresenceStatus,
  ReadState,
  ReadyPayload,
  Relationship,
  Role,
  Snowflake,
  User,
  RtcProducer,
  VoiceState,
} from './types';

export const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  VoiceStateUpdate: 4, // client: join / move / leave a voice channel, set mute & deaf
  Rtc: 6, // client: a request to the voice server for this connection's voice session (answered by RTC_RESPONSE)
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

export const GATEWAY_PATH = '/gateway';
export const HEARTBEAT_INTERVAL_MS = 30_000;

export const CloseCode = {
  AuthFailed: 4004,
  NotAuthenticated: 4003,
  RateLimited: 4008,
  HeartbeatTimeout: 4009,
  Superseded: 4010,
} as const;

// Full (per-recipient, visibility-filtered) guild snapshot. Also used to resync a guild
// after a permission change, so clients replace their copy wholesale.
export interface GuildCreatePayload extends GuildState {
  users: User[];
  presences: Record<Snowflake, PresenceStatus>;
  voiceStates: VoiceState[];
}

export interface VoiceStateUpdateFrame {
  channelId: Snowflake | null;
  selfMute: boolean;
  selfDeaf: boolean;
  selfVideo?: boolean;
  selfStream?: boolean;
}

// Voice and video go through the server (an SFU): each participant sends its streams once and
// receives everyone else's. The client drives it with numbered requests; see server/src/sfu.ts.
export interface RtcRequestFrame {
  id: number; // echoed in the RTC_RESPONSE
  method: string;
  data?: unknown;
}

export type RtcEvent =
  | ({ type: 'producerAdded' } & RtcProducer) // someone in our channel started sending
  | { type: 'producerRemoved'; producerId: string };

export interface DispatchEvents {
  READY: ReadyPayload;
  GUILD_CREATE: GuildCreatePayload;
  GUILD_UPDATE: Guild;
  GUILD_DELETE: { id: Snowflake };
  CHANNEL_CREATE: Channel;
  CHANNEL_UPDATE: Channel;
  CHANNEL_DELETE: { id: Snowflake; guildId: Snowflake | null };
  GUILD_ROLE_CREATE: Role;
  GUILD_ROLE_UPDATE: Role;
  GUILD_ROLE_DELETE: { id: Snowflake; guildId: Snowflake };
  GUILD_MEMBER_ADD: { member: Member; user: User };
  GUILD_MEMBER_UPDATE: Member;
  GUILD_MEMBER_REMOVE: { guildId: Snowflake; userId: Snowflake };
  MESSAGE_CREATE: Message;
  MESSAGE_UPDATE: Message;
  MESSAGE_DELETE: { id: Snowflake; channelId: Snowflake };
  MESSAGE_REACTION_ADD: { channelId: Snowflake; messageId: Snowflake; userId: Snowflake; emoji: string };
  MESSAGE_REACTION_REMOVE: { channelId: Snowflake; messageId: Snowflake; userId: Snowflake; emoji: string };
  MESSAGE_ACK: ReadState; // sent to the reader's own connections, so every tab agrees on what is read
  TYPING_START: { channelId: Snowflake; userId: Snowflake };
  PRESENCE_UPDATE: { userId: Snowflake; status: PresenceStatus };
  USER_UPDATE: User;
  RELATIONSHIP_ADD: { relationship: Relationship; user: User };
  RELATIONSHIP_REMOVE: { userId: Snowflake };
  VOICE_STATE_UPDATE: VoiceState;
  RTC_RESPONSE: { id: number; data?: unknown; error?: string }; // to the connection that asked
  RTC_EVENT: RtcEvent; // to the connection holding the voice session
  VOICE_ERROR: { channelId: Snowflake | null; message: string }; // join refused; sent only to the asking connection
}

export type DispatchName = keyof DispatchEvents;

export type ServerFrame =
  | { op: typeof Op.Hello; d: { heartbeatInterval: number } }
  | { op: typeof Op.HeartbeatAck }
  | { op: typeof Op.InvalidSession }
  | { [K in DispatchName]: { op: typeof Op.Dispatch; t: K; d: DispatchEvents[K] } }[DispatchName];

export type ClientFrame =
  | { op: typeof Op.Identify; d: { token: string } }
  | { op: typeof Op.Heartbeat }
  | { op: typeof Op.VoiceStateUpdate; d: VoiceStateUpdateFrame }
  | { op: typeof Op.Rtc; d: RtcRequestFrame };
