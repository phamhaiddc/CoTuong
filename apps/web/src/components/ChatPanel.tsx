import { useEffect, useRef, useState } from 'react';
import { CHAT_LIMITS, type ChatMessageDto } from '@cotuong/shared';
import { emit } from '../api/socket';
import { useToast } from '../state/toast';
import { Icon } from './icons';

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
};

/**
 * Danh sách tin nhắn trong ván (có nút báo cáo tin của đối thủ).
 * Luôn giữ tin mới nhất trong tầm nhìn khi có tin mới hoặc khi khung đổi cỡ (đổi tab, xoay màn hình…).
 */
export function ChatMessages({ myId, messages }: { myId: string; messages: ChatMessageDto[] }) {
  const toast = useToast();
  const [reported, setReported] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  /** Người dùng đang ở cuối danh sách (để giữ tin mới nhất trong tầm nhìn khi khung đổi cỡ) */
  const atBottomRef = useRef(true);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    atBottomRef.current = true;
  }, [messages.length]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const onScroll = () => {
      // Khung đang ẩn (tab khác) có cao 0: không coi là người dùng đã cuộn lên
      if (el.clientHeight > 0) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  const report = async (m: ChatMessageDto) => {
    if (!window.confirm(`Báo cáo tin nhắn này của ${m.username} cho ban quản trị?\n\n"${m.content}"`)) return;
    const r = await emit('chat:report', { messageId: m.id });
    if (r.ok) {
      setReported((s) => new Set(s).add(m.id));
      toast('Đã gửi báo cáo. Ban quản trị sẽ xem xét tin nhắn này.', 'success');
    } else toast(r.error, 'error');
  };

  return (
    <div className="chat-list" ref={listRef} role="log" aria-label="Tin nhắn trong ván">
      {messages.length === 0 && (
        <div className="chat-empty">
          <Icon name="chat" size={26} strokeWidth={1.6} />
          <span>
            Chưa có tin nhắn.
            <br />
            Gửi lời chào tới đối thủ nhé!
          </span>
        </div>
      )}
      {messages.map((m, i) => {
        const mine = m.userId === myId;
        const first = i === 0 || messages[i - 1].userId !== m.userId;
        const isReported = reported.has(m.id);
        return (
          <div key={m.id} className={`chat-msg${mine ? ' mine' : ''}${first ? ' first' : ''}`}>
            {first && <span className="chat-author">{mine ? 'Bạn' : m.username}</span>}
            <div className="chat-line">
              <span className="chat-text" title={timeOf(m.createdAt)}>
                {m.content}
              </span>
              {!mine && (
                <button
                  type="button"
                  className={`chat-report${isReported ? ' done' : ''}`}
                  onClick={() => report(m)}
                  disabled={isReported}
                  title={isReported ? 'Đã báo cáo tin nhắn này' : 'Báo cáo tin nhắn xấu cho ban quản trị'}
                  aria-label={isReported ? 'Đã báo cáo tin nhắn' : 'Báo cáo tin nhắn cho ban quản trị'}
                >
                  <Icon name={isReported ? 'check' : 'flag'} size={14} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Ô nhập tin nhắn: 1 tin / 2 giây, tối đa 200 ký tự */
export function ChatForm({
  matchId,
  onFocus,
  showHint = true,
}: {
  matchId: string;
  /** Gọi khi người dùng bấm vào ô nhập (vd. chuyển sang tab Trò chuyện) */
  onFocus?: () => void;
  /** Hiện dòng "Tối đa 1 tin mỗi 2 giây" + bộ đếm ký tự */
  showHint?: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = window.setTimeout(() => tick((x) => x + 1), cooldownUntil - Date.now() + 20);
    return () => window.clearTimeout(id);
  }, [cooldownUntil]);

  const coolingDown = cooldownUntil > Date.now();

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content || coolingDown) return;
    onFocus?.();
    setCooldownUntil(Date.now() + CHAT_LIMITS.minIntervalMs);
    const r = await emit('chat:send', { matchId, content });
    if (!r.ok) toast(r.error, 'error');
    else setText('');
  };

  const nearLimit = text.length >= CHAT_LIMITS.maxLength - 20;

  return (
    <>
      <form className="chat-form" onSubmit={send}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, CHAT_LIMITS.maxLength))}
          onFocus={onFocus}
          maxLength={CHAT_LIMITS.maxLength}
          placeholder="Nhập tin nhắn…"
          aria-label="Tin nhắn"
          autoComplete="off"
          enterKeyHint="send"
        />
        <button className="btn btn-primary btn-icon chat-send" disabled={!text.trim() || coolingDown} aria-label="Gửi" title="Gửi">
          <Icon name="send" size={18} />
          <span className="sr-only">Gửi</span>
        </button>
      </form>
      {(showHint || coolingDown || nearLimit) && (
        <div className="chat-hint">
          <span>
            {coolingDown
              ? `Chờ ${CHAT_LIMITS.minIntervalMs / 1000} giây rồi gửi tin tiếp…`
              : `Mỗi ${CHAT_LIMITS.minIntervalMs / 1000} giây gửi được 1 tin`}
          </span>
          <span className={`num${nearLimit ? ' warn-text' : ''}`}>
            {text.length}/{CHAT_LIMITS.maxLength}
          </span>
        </div>
      )}
    </>
  );
}
