import { hasPerm, LIMITS, Perm, type Attachment, type Message, type User } from '@konusgac/shared';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { api } from '../api';
import { convertEmoticons, decodeMentions, encodeMentions, loadOlder, mentionCandidates, navigate, signalTyping } from '../actions';
import { useSettings } from '../settings';
import { openMenu } from '../menu';
import { messageMenu, userMenu } from '../menus';
import { registerComposer } from '../ui';
import { takePendingJump } from '../actions';
import { channelById, channelPerms, displayName, dmPartner, getState, pingsMe, roleColor, useStore } from '../state';
import { Avatar } from './Avatar';
import { EmojiPicker } from './EmojiPicker';
import { SearchPanel } from './SearchPanel';

const GROUP_WINDOW_MS = 7 * 60 * 1000;

const timeFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

export function Chat({ channelId }: { channelId: string }) {
  const channel = useStore((s) => channelById(s, channelId));
  const log = useStore((s) => s.messages[channelId]);
  const typing = useStore((s) => s.typing[channelId]);
  const users = useStore((s) => s.users);
  // subscribe to the guild so role colors, nicknames and permissions stay current
  useStore((s) => (channel?.guildId ? s.guilds[channel.guildId] : undefined));
  const me = useStore((s) => s.me);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [searching, setSearching] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const roleColors = useSettings((x) => x.roleColors);

  useEffect(() => {
    setReplyTo(null);
    setDropped([]);
  }, [channelId]);

  if (!channel || !me) return <div className="empty">Kanal bulunamadı.</div>;

  const s = getState();
  const perms = channelPerms(s, channel);
  const canSend = hasPerm(perms, Perm.SendMessages);
  const canAttach = canSend && hasPerm(perms, Perm.AttachFiles);
  const canManage = hasPerm(perms, Perm.ManageMessages);
  const canReact = hasPerm(perms, Perm.AddReactions);
  const guildId = channel.guildId ?? undefined;
  const partner = channel.type === 'dm' ? dmPartner(s, channel) : undefined;
  const title = partner ? (users[partner]?.displayName ?? 'Bilinmeyen') : channel.name;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    if (canAttach && e.dataTransfer.files.length) setDropped([...e.dataTransfer.files]);
  };

  return (
    <div className="chat-wrap">
      <div
        className={`chat ${dropping ? 'dropping' : ''}`}
        onDragOver={(e) => {
          if (!canAttach || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
        onDrop={onDrop}
      >
        <header className="chat-header">
          <span className="channel-icon">{partner ? '@' : '#'}</span>
          <strong>{title}</strong>
          {channel.topic && <span className="topic truncate">{channel.topic}</span>}
          <span className="spacer" />
          <button className={`icon-btn ${searching ? 'on' : ''}`} title="Mesajlarda ara" onClick={() => setSearching(!searching)}>
            🔍
          </button>
        </header>
        <MessageList
          key={channelId}
          channelId={channelId}
          messages={log?.items ?? []}
          hasMore={log?.hasMore ?? true}
          loading={log?.loading ?? true}
          intro={partner ? `${title} ile özel mesajlarının başlangıcı.` : `#${channel.name} kanalına hoş geldin!`}
          render={(m, grouped) => (
            <MessageRow
              key={m.id}
              message={m}
              grouped={grouped}
              author={users[m.authorId]}
              name={displayName(s, m.authorId, guildId)}
              color={guildId && roleColors ? roleColor(s, guildId, m.authorId) : undefined}
              guildId={guildId}
              meId={me.id}
              mine={m.authorId === me.id}
              canDelete={m.authorId === me.id || canManage}
              canReply={canSend}
              canReact={canReact}
              onReply={() => setReplyTo(m)}
            />
          )}
        />
        <TypingLine typing={typing} guildId={guildId} meId={me.id} />
        <Composer
          channelId={channelId}
          disabled={!canSend}
          canAttach={canAttach}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          dropped={dropped}
          onDroppedTaken={() => setDropped([])}
          placeholder={canSend ? (partner ? `@${title} kişisine mesaj gönder` : `#${title} kanalına mesaj gönder`) : 'Bu kanala mesaj gönderme iznin yok'}
        />
        {dropping && <div className="drop-hint">Dosyaları buraya bırak</div>}
      </div>
      {searching && (
        <SearchPanel
          scope={guildId ? { guildId } : { channelId }}
          onClose={() => setSearching(false)}
          onOpen={(m) => {
            setSearching(false);
            navigate(guildId ?? '@me', m.channelId);
            jumpTo(m.id);
          }}
        />
      )}
    </div>
  );
}

// Scrolls a loaded message into view and flashes it.
export function jumpTo(messageId: string) {
  requestAnimationFrame(() => {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  });
}

function MessageList(props: {
  channelId: string;
  messages: Message[];
  hasMore: boolean;
  loading: boolean;
  intro: string;
  render: (m: Message, grouped: boolean) => ReactNode;
}) {
  const { channelId, messages, hasMore, loading } = props;
  const ref = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const prevFirst = useRef<string | undefined>(undefined);

  // Keep the viewport anchored: at the bottom for new messages, in place when older ones are prepended.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = messages[0]?.id;
    if (prevFirst.current && first !== prevFirst.current && !stickToBottom.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [messages]);

  // Images load after layout; stay at the bottom while they do.
  const onMediaLoad = () => {
    const el = ref.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  };

  const onScroll = () => {
    const el = ref.current!;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    prevHeight.current = el.scrollHeight;
    if (el.scrollTop < 120 && hasMore && !loading) void loadOlder(channelId);
  };

  useEffect(() => {
    const id = takePendingJump(channelId, messages.map((m) => m.id));
    if (id) jumpTo(id);
  }, [channelId, messages]);

  const rows = useMemo(() => {
    const out: ReactNode[] = [];
    let prev: Message | undefined;
    for (const m of messages) {
      const day = dateFmt.format(m.createdAt);
      if (!prev || dateFmt.format(prev.createdAt) !== day) {
        out.push(
          <div key={`d${m.id}`} className="day-divider">
            <span>{day}</span>
          </div>,
        );
        prev = undefined;
      }
      const grouped = !!prev && !m.replyTo && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
      out.push(<Fragment key={m.id}>{props.render(m, grouped)}</Fragment>);
      prev = m;
    }
    return out;
  }, [messages, props.render]);

  return (
    <div className="messages" ref={ref} onScroll={onScroll} onLoadCapture={onMediaLoad}>
      {!hasMore && (
        <div className="channel-intro">
          <h2>{props.intro}</h2>
        </div>
      )}
      {loading && <div className="muted small pad center">Yükleniyor…</div>}
      {rows}
    </div>
  );
}

function MessageRow(props: {
  message: Message;
  grouped: boolean;
  author: User | undefined;
  name: string;
  color: string | undefined;
  guildId: string | undefined;
  meId: string;
  mine: boolean;
  canDelete: boolean;
  canReply: boolean;
  canReact: boolean;
  onReply: () => void;
}) {
  const { message: m, grouped } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [picker, setPicker] = useState(false);
  const pinged = pingsMe(getState(), m) && !getState().dms[m.channelId];
  const showReactions = useSettings((x) => x.showReactions);
  const developer = useSettings((x) => x.developerMode);

  const startEdit = () => {
    setDraft(decodeMentions(m.content));
    setEditing(true);
  };

  // Right-click: on a name, avatar or @mention the person's menu; anywhere else the message's.
  const onContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const person = target.closest<HTMLElement>('[data-user]');
    if (person) return openMenu(e, userMenu(person.dataset.user!, { guildId: props.guildId }));
    openMenu(
      e,
      messageMenu(
        m,
        {
          canReply: props.canReply,
          canReact: props.canReact,
          canDelete: props.canDelete,
          mine: props.mine,
          reply: props.onReply,
          edit: startEdit,
          remove: () => void remove(),
          pickReaction: () => setPicker(true),
          toggleReaction,
          reacted: (emoji) => !!m.reactions.find((r) => r.emoji === emoji)?.userIds.includes(props.meId),
        },
        target,
      ),
    );
  };

  async function save() {
    const content = encodeMentions(m.channelId, draft.trim());
    if (content === m.content || (!content && m.attachments.length === 0)) return setEditing(false);
    try {
      await api.editMessage(m.channelId, m.id, content);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (confirm('Bu mesajı silmek istediğine emin misin?')) await api.deleteMessage(m.channelId, m.id).catch(() => {});
  }

  const toggleReaction = (emoji: string) => {
    const on = !m.reactions.find((r) => r.emoji === emoji)?.userIds.includes(props.meId);
    void api.react(m.channelId, m.id, emoji, on).catch((err) => alert((err as Error).message));
  };

  return (
    <div id={`msg-${m.id}`} className={`message ${grouped ? 'grouped' : ''} ${pinged ? 'pinged' : ''}`} onContextMenu={onContextMenu}>
      {m.replyTo && <ReplyPreview reply={m.replyTo} guildId={props.guildId} />}
      <div className="message-main">
        <div className="message-gutter">
          {grouped ? (
            <span className="hover-time">{timeFmt.format(m.createdAt)}</span>
          ) : (
            <span data-user={m.authorId}>
              <Avatar user={props.author} size={40} />
            </span>
          )}
        </div>
        <div className="message-body">
          {!grouped && (
            <div className="message-meta">
              <span className="author" data-user={m.authorId} style={{ color: props.color }}>
                {props.name}
              </span>
              <span className="muted small">
                {dateFmt.format(m.createdAt)} {timeFmt.format(m.createdAt)}
              </span>
            </div>
          )}
          {editing ? (
            <div className="edit-box">
              <textarea
                value={draft}
                autoFocus
                maxLength={LIMITS.messageMax}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void save();
                  }
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <div className="muted small">
                Kaydetmek için Enter, iptal için Esc {error && <span className="error-text">· {error}</span>}
              </div>
            </div>
          ) : (
            m.content && (
              <div className="content">
                <RichText text={m.content} guildId={props.guildId} meId={props.meId} />
                {m.editedAt && <span className="muted small"> (düzenlendi)</span>}
              </div>
            )
          )}
          {m.attachments.length > 0 && (
            <div className="attachments">
              {m.attachments.map((a) => (
                <AttachmentView key={a.id} a={a} />
              ))}
            </div>
          )}
          {showReactions && m.reactions.length > 0 && (
            <div className="reactions">
              {m.reactions.map((r) => (
                <button
                  key={r.emoji}
                  className={`reaction ${r.userIds.includes(props.meId) ? 'mine' : ''}`}
                  title={r.userIds.map((id) => displayName(getState(), id, props.guildId)).join(', ')}
                  onClick={() => toggleReaction(r.emoji)}
                >
                  <span>{r.emoji}</span> {r.userIds.length}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {!editing && (
        <div className="message-actions">
          {props.canReact && (
            <button title="Tepki ekle" onClick={() => setPicker(!picker)}>
              😊
            </button>
          )}
          {props.canReply && (
            <button title="Yanıtla" onClick={props.onReply}>
              ↩
            </button>
          )}
          {props.mine && (
            <button title="Düzenle" onClick={startEdit}>
              ✎
            </button>
          )}
          {props.canDelete && (
            <button title="Sil" className="danger" onClick={remove}>
              🗑
            </button>
          )}
          {developer && (
            <button title="Mesaj ID'sini kopyala" onClick={() => void navigator.clipboard?.writeText(m.id)}>
              ID
            </button>
          )}
        </div>
      )}
      {picker && (
        <EmojiPicker
          onPick={(e) => {
            setPicker(false);
            toggleReaction(e);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

function ReplyPreview({ reply, guildId }: { reply: NonNullable<Message['replyTo']>; guildId: string | undefined }) {
  const s = getState();
  const text = reply.content === null ? 'Orijinal mesaj silindi' : reply.content.replace(/<@(\d{1,20})>/g, (_a, id: string) => `@${displayName(s, id, guildId)}`) || '📎 Ek';
  return (
    <button className="reply-preview" onClick={() => jumpTo(reply.id)} title="Mesaja git">
      <span className="reply-line" />
      {reply.authorId && <strong style={{ color: guildId ? roleColor(s, guildId, reply.authorId) : undefined }}>@{displayName(s, reply.authorId, guildId)}</strong>}
      <span className={`truncate ${reply.content === null ? 'muted' : ''}`}>{text}</span>
    </button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentView({ a }: { a: Attachment }) {
  const inline = useSettings((x) => x.inlineMedia);
  if (inline && a.contentType.startsWith('image/')) {
    return (
      <a href={a.url} target="_blank" rel="noreferrer noopener" className="attachment-image">
        <img src={a.url} alt={a.filename} loading="lazy" />
      </a>
    );
  }
  if (inline && a.contentType.startsWith('video/')) return <video className="attachment-video" src={a.url} controls preload="metadata" />;
  if (a.contentType.startsWith('audio/')) {
    return (
      <div className="attachment-file">
        <span className="truncate">{a.filename}</span>
        <audio src={a.url} controls preload="none" />
      </div>
    );
  }
  return (
    <a className="attachment-file" href={a.url} download={a.filename}>
      <span className="file-icon">📄</span>
      <span className="file-meta">
        <span className="truncate link-text">{a.filename}</span>
        <span className="muted small">{formatSize(a.size)}</span>
      </span>
    </a>
  );
}

// Minimal formatting: **kalın**, *italik*, `kod`, ```kod bloğu```, links and mentions.
// Rendered as React nodes, never as HTML.
const TOKEN = /(```[\s\S]+?```|`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|https?:\/\/[^\s<]+|<@\d{1,20}>|@everyone)/g;

export function RichText({ text, guildId, meId }: { text: string; guildId?: string; meId: string }) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p;
        if (p.startsWith('```')) return <pre key={i}>{p.slice(3, -3).replace(/^\n/, '')}</pre>;
        if (p.startsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.startsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith('*')) return <em key={i}>{p.slice(1, -1)}</em>;
        if (p.startsWith('<@')) {
          const id = p.slice(2, -1);
          return (
            <span key={i} className={`mention ${id === meId ? 'me' : ''}`} data-user={id}>
              @{displayName(getState(), id, guildId)}
            </span>
          );
        }
        if (p === '@everyone') {
          return (
            <span key={i} className="mention">
              @everyone
            </span>
          );
        }
        return (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener">
            {p}
          </a>
        );
      })}
    </>
  );
}

function TypingLine({ typing, guildId, meId }: { typing: Record<string, number> | undefined; guildId?: string; meId: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!typing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [typing]);

  const active = Object.entries(typing ?? {})
    .filter(([id, until]) => id !== meId && until > now)
    .map(([id]) => displayName(getState(), id, guildId));

  let text = '';
  if (active.length === 1) text = `${active[0]} yazıyor…`;
  else if (active.length === 2) text = `${active[0]} ve ${active[1]} yazıyor…`;
  else if (active.length > 2) text = 'Birkaç kişi yazıyor…';
  return <div className="typing">{text}</div>;
}

function Composer(props: {
  channelId: string;
  disabled: boolean;
  canAttach: boolean;
  placeholder: string;
  replyTo: Message | null;
  onCancelReply: () => void;
  dropped: File[];
  onDroppedTaken: () => void;
}) {
  const { channelId, disabled, replyTo } = props;
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [suggest, setSuggest] = useState<{ query: string; start: number; index: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const spellcheck = useSettings((x) => x.spellcheck);
  const sendOnEnter = useSettings((x) => x.sendOnEnter);

  useEffect(() => {
    setText('');
    setFiles([]);
    setError('');
    setSuggest(null);
  }, [channelId]);

  useEffect(() => {
    if (replyTo) area.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    if (disabled) return;
    registerComposer((insert) => {
      const el = area.current;
      const at = el?.selectionStart ?? text.length;
      setText((cur) => {
        const before = cur.slice(0, at);
        return `${before}${before && !/\s$/.test(before) ? ' ' : ''}${insert}${cur.slice(at)}`;
      });
      requestAnimationFrame(() => el?.focus());
    });
    return () => registerComposer(null);
  }, [disabled, text.length]);

  useEffect(() => {
    if (props.dropped.length) {
      addFiles(props.dropped);
      props.onDroppedTaken();
    }
  });

  function addFiles(list: File[]) {
    setFiles((cur) => [...cur, ...list].slice(0, LIMITS.attachmentsPerMessage));
    area.current?.focus();
  }

  const matches = useMemo(() => {
    if (!suggest) return [];
    const q = suggest.query.toLocaleLowerCase('tr');
    return mentionCandidates(channelId)
      .filter((u) => u.username.toLowerCase().startsWith(q) || u.displayName.toLocaleLowerCase('tr').startsWith(q))
      .slice(0, 8);
  }, [suggest, channelId]);

  function updateSuggest(value: string, caret: number) {
    const m = /(^|\s)@([\p{L}\p{N}_.]{0,32})$/u.exec(value.slice(0, caret));
    setSuggest(m ? { query: m[2]!, start: caret - m[2]!.length - 1, index: 0 } : null);
  }

  function pick(username: string) {
    if (!suggest) return;
    const caret = suggest.start + 1 + suggest.query.length;
    const next = `${text.slice(0, suggest.start)}@${username} ${text.slice(caret)}`;
    setText(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      const pos = suggest.start + username.length + 2;
      area.current?.setSelectionRange(pos, pos);
      area.current?.focus();
    });
  }

  async function send() {
    const content = encodeMentions(channelId, convertEmoticons(text.trim()));
    if ((!content && files.length === 0) || sending) return;
    setSending(true);
    try {
      await api.sendMessage(channelId, { content, replyToId: replyTo?.id ?? null, files });
      setText('');
      setFiles([]);
      setError('');
      props.onCancelReply();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggest && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setSuggest({ ...suggest, index: (suggest.index + step + matches.length) % matches.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[suggest.index]!.username);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (suggest) setSuggest(null);
      else if (replyTo) props.onCancelReply();
      return;
    }
    const sendKey = sendOnEnter ? e.key === 'Enter' && !e.shiftKey && !e.ctrlKey : e.key === 'Enter' && e.ctrlKey;
    if (sendKey) {
      e.preventDefault();
      void send();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!props.canAttach || e.clipboardData.files.length === 0) return;
    e.preventDefault();
    addFiles([...e.clipboardData.files]);
  }

  const s = getState();
  return (
    <div className="composer">
      {error && <div className="error-text small">{error}</div>}
      {suggest && matches.length > 0 && (
        <div className="mention-suggest">
          {matches.map((u, i) => (
            <button
              key={u.id}
              className={i === suggest.index ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u.username);
              }}
            >
              <Avatar user={s.users[u.id]} size={20} />
              <strong>{u.displayName}</strong>
              <span className="muted small">@{u.username}</span>
            </button>
          ))}
        </div>
      )}
      {replyTo && (
        <div className="composer-bar">
          <span className="truncate">
            <strong>@{displayName(s, replyTo.authorId, channelById(s, channelId)?.guildId ?? undefined)}</strong> kişisine yanıt veriyorsun
          </span>
          <button className="icon-btn" title="Yanıtı iptal et (Esc)" onClick={props.onCancelReply}>
            ✕
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="pending-files">
          {files.map((f, i) => (
            <div key={i} className="pending-file">
              <span className="truncate">{f.name}</span>
              <span className="muted small">{formatSize(f.size)}</span>
              <button className="icon-btn" title="Kaldır" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={`composer-box ${replyTo || files.length ? 'attached' : ''}`}>
        {props.canAttach && (
          <>
            <button className="icon-btn attach-btn" title="Dosya ekle" disabled={disabled} onClick={() => picker.current?.click()}>
              ＋
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={props.placeholder}
          maxLength={LIMITS.messageMax}
          spellCheck={spellcheck}
          onChange={(e) => {
            setText(e.target.value);
            updateSuggest(e.target.value, e.target.selectionStart);
            if (e.target.value) signalTyping(channelId);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => setSuggest(null)}
        />
      </div>
      {text.length > LIMITS.messageMax - 200 && <span className="counter small">{LIMITS.messageMax - text.length}</span>}
    </div>
  );
}
