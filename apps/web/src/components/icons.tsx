/**
 * Bộ biểu tượng nét (24×24, stroke = currentColor). Tự vẽ, không phụ thuộc thư viện ngoài.
 * Dùng: <Icon name="trophy" size={18} />
 */
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5 9v11h14V9M10 20v-6h4v6',
  play: 'M7 4.5v15l12.5-7.5L7 4.5Z',
  pause: 'M8 5v14M16 5v14',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5v1.5A3.5 3.5 0 0 0 8.5 11M16 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 13v4M9 20.5h6M10 17h4l.5 3.5h-5L10 17Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5a7.5 7.5 0 0 1 15 0',
  users:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8',
  calendar: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12ZM4 10h16M8.5 3v4M15.5 3v4',
  shield: 'M12 3 4.5 6v5.5c0 4.4 3.1 7.9 7.5 9.5 4.4-1.6 7.5-5.1 7.5-9.5V6L12 3Z',
  logout: 'M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16.5 5.5 12 10 7.5M5.5 12H15',
  login: 'M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M14 16.5l4.5-4.5L14 7.5M18.5 12H9',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  moon: 'M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2Z',
  monitor: 'M3.5 5.5A1.5 1.5 0 0 1 5 4h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 16H5a1.5 1.5 0 0 1-1.5-1.5v-9ZM9 20h6M12 16v4',
  close: 'M6 6l12 12M18 6 6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
  flag: 'M5.5 21V4M5.5 4.5h11l-2.2 4 2.2 4h-11',
  draw: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 10h8M8 14h8',
  flip: 'M7 20V4M3.5 7.5 7 4l3.5 3.5M17 4v16M13.5 16.5 17 20l3.5-3.5',
  bulb: 'M9.5 18h5M10.5 21h3M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2v.5h5V16c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z',
  restart: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9M4.5 4.5V9H9',
  chat: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4V6Z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  copy: 'M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5v-9ZM15.5 8V5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5H9',
  check: 'M5 12.5 10 17.5 19 7',
  plus: 'M12 5v14M5 12h14',
  'chevron-left': 'M15 5.5 8.5 12l6.5 6.5',
  'chevron-right': 'M9 5.5l6.5 6.5L9 18.5',
  'chevron-down': 'M5.5 9 12 15.5 18.5 9',
  'chevron-first': 'M17 5.5 10.5 12l6.5 6.5M7 6v12',
  'chevron-last': 'M7 5.5l6.5 6.5L7 18.5M17 6v12',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
  bot: 'M7.5 8h9A2.5 2.5 0 0 1 19 10.5v6a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 16.5v-6A2.5 2.5 0 0 1 7.5 8ZM12 4.5V8M9.5 13h.01M14.5 13h.01M10 16h4M2.5 12.5v2.5M21.5 12.5v2.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.8h.01',
  alert: 'M12 4 2.8 19.5h18.4L12 4ZM12 10v4.5M12 17h.01',
  crown: 'M3.5 8.5 7.5 12 12 5.5l4.5 6.5 4-3.5-1.8 10H5.3L3.5 8.5Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  camera: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.6-2.2h5.8L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9ZM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  send: 'M4.5 12 20 4.5 15.5 20l-3.3-6.3L4.5 12ZM12.2 13.7 20 4.5',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  lock: 'M6.5 11h11A1.5 1.5 0 0 1 19 12.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11ZM8 11V7.5a4 4 0 0 1 8 0V11',
  unlock: 'M6.5 11h11A1.5 1.5 0 0 1 19 12.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11ZM8 11V7.5a4 4 0 0 1 7.7-1.5',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7M10 11v5.5M14 11v5.5',
  star: 'M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8L12 3.5Z',
  swords: 'M14.5 4H20v5.5L10 19.5 7.5 17l-2.5 2.5L3.5 18 6 15.5 3.5 13 13.5 3M9.5 4H4v5.5l3.5 3.5M16.5 17 20 20.5M14 14.5l3.5 3.5',
  bolt: 'M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 12h.01',
  wifi: 'M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0M12 19.5h.01',
  'wifi-off': 'M3 3l18 18M8.8 16a5 5 0 0 1 6.4 0M5.5 12.5a9.5 9.5 0 0 1 5-2.4M2.5 9a14 14 0 0 1 4.3-2.7M14.5 10.3a9.5 9.5 0 0 1 4 2.2M10.8 5.1A14 14 0 0 1 21.5 9M12 19.5h.01',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5M3.5 4v4.5H8M12 7.5V12l3 2',
  grid: 'M4 4h16v16H4V4ZM4 12h16M12 4v16',
  chart: 'M4 20h16M7 16.5V11M12 16.5V6M17 16.5v-3.5',
  mail: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11ZM4.5 6.5 12 12.5l7.5-6',
  key: 'M14.5 14a5 5 0 1 0-4.6-3.1L3.5 17.3V20.5h3.2v-2h2v-2h2l1.2-1.2a5 5 0 0 0 2.6.7ZM16.5 7.5h.01',
  'external': 'M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  /** Quân úp (cờ úp): quân cờ có dấu hỏi */
  hidden: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.6 9.6a2.4 2.4 0 1 1 3.4 2.2c-.6.3-1 .9-1 1.6v.5M12 16.8h.01',
  /** Cờ thế: mảnh ghép */
  puzzle: 'M5 5h4.5a2.5 2.5 0 0 1 5 0H19v4.5a2.5 2.5 0 0 1 0 5V19h-4.5a2.5 2.5 0 0 0-5 0H5v-4.5a2.5 2.5 0 0 0 0-5Z',
  /** Thu gọn / mở rộng thanh bên */
  'panel-left': 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM9.5 4v16',
  focus: 'M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 20,
  strokeWidth = 2,
  className,
  title,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Biểu tượng game: quân "帥" cho Cờ tướng, quân Mã cho Cờ vua */
export function GameIcon({ game, size = 20 }: { game: 'xiangqi' | 'chess'; size?: number }) {
  if (game === 'xiangqi') {
    return (
      <svg className="icon game-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10.5" fill="#f6dfb2" stroke="#b3261e" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="8" fill="none" stroke="#b3261e" strokeWidth="0.9" />
        <text x="12" y="16.2" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="#b3261e" fontFamily="KaiTi, STKaiti, SimSun, serif">
          帥
        </text>
      </svg>
    );
  }
  return (
    <svg className="icon game-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" fill="#f3ead9" stroke="#3b2f25" strokeWidth="1.6" />
      <path
        d="M8.3 17.6h7.6l-.6-1.6c.1-2.3-.4-4.2-1.3-5.7-.9-1.5-2.3-2.6-3.6-3.3l-.4-1.3-.9 1.6c-1 .5-1.8 1.4-2.3 2.5l-.8 1.6.9.8 1.3-.6.9.5 1.6-.8c-.4 1.3-1.4 2.4-2.2 3.4-.4.6-.4 1.3-.2 2.9Z"
        fill="#3b2f25"
      />
    </svg>
  );
}
