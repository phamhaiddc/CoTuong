import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Đổi giá trị này (vd đường dẫn trang) để thoát trạng thái lỗi khi người dùng chuyển trang */
  resetKey: string;
  children: ReactNode;
}
interface State {
  error: Error | null;
  key: string;
}

/** Bắt lỗi khi vẽ một trang để cả ứng dụng không bị trắng; hiện thông báo + nút tải lại */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Lỗi hiển thị trang:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="play-error" role="alert">
        <div className="panel">
          <h1 className="panel-title">Xin lỗi, trang này đang bị lỗi</h1>
          <p className="muted">
            Bạn bấm “Tải lại trang” để thử lại. Nếu vẫn lỗi, hãy về trang chủ. Nếu đang chơi với người, ván cờ vẫn được giữ — tải lại
            trang là vào lại được.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Tải lại trang
            </button>
            <a className="btn btn-ghost" href="/">
              Về trang chủ
            </a>
          </div>
        </div>
      </div>
    );
  }
}
