import type { ReactNode } from 'react';

// Small stroke icons for the voice controls; they inherit the current text color.
type Props = { size?: number; off?: boolean };

function Svg({ size = 18, off, children }: Props & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
      {off && <line x1="3" y1="3" x2="21" y2="21" stroke="var(--danger)" strokeWidth={2.4} />}
    </svg>
  );
}

export const MicIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);

export const HeadphonesIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
    <rect x="3" y="14" width="4" height="7" rx="1.5" />
    <rect x="17" y="14" width="4" height="7" rx="1.5" />
  </Svg>
);

export const SpeakerIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
  </Svg>
);

export const HangUpIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M3 14.5c5-5 13-5 18 0l-2.5 2.5-3-1.5v-2.5a10 10 0 0 0-7 0v2.5l-3 1.5z" />
  </Svg>
);

export const CameraIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="2" y="6" width="14" height="12" rx="2" />
    <path d="M16 10.5l6-3.5v10l-6-3.5z" />
  </Svg>
);

export const ScreenIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4M12 13V8M9.5 10.5L12 8l2.5 2.5" />
  </Svg>
);
