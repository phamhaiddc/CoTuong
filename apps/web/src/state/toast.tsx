import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/icons';

export type ToastKind = 'info' | 'success' | 'error' | 'warn';

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

const ICON: Record<ToastKind, IconName> = { info: 'info', success: 'check', error: 'alert', warn: 'alert' };

const Ctx = createContext<((text: string, kind?: ToastKind, ms?: number) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, kind: ToastKind = 'info', ms = 4000) => {
    // Thông báo nổi nằm ngoài ErrorBoundary: giá trị không phải chữ (vd. tra bảng lời nhắn bằng khoá lạ như "__proto__")
    // mà vẽ ra sẽ làm trắng cả trang → bỏ qua
    if (typeof text !== 'string' || !text) return;
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            title="Bấm để đóng"
          >
            <Icon name={ICON[t.kind]} size={18} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast phải dùng trong ToastProvider');
  return ctx;
}
