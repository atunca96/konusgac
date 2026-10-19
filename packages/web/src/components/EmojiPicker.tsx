import { useEffect, useRef } from 'react';

// A small fixed set of reaction emojis; the server accepts any single emoji.
const EMOJIS = [
  '👍', '👎', '❤️', '😂', '😮', '😢', '😡', '🎉',
  '🔥', '👏', '🙏', '💯', '✅', '❌', '👀', '🤔',
  '😍', '🥳', '😎', '🤣', '😅', '🙄', '😴', '🤝',
  '💪', '⭐', '🚀', '🎮', '☕', '🍕', '🇹🇷', '⚽',
];

export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="emoji-picker" ref={ref} role="dialog" aria-label="Tepki seç">
      {EMOJIS.map((e) => (
        <button key={e} onClick={() => onPick(e)}>
          {e}
        </button>
      ))}
    </div>
  );
}
