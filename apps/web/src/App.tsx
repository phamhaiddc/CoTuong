import { useEffect } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { trackPageView } from './api/analytics';
import { Icon } from './components/icons';
import { AuthReady, BrandLogo, Layout, RequireAuth } from './components/Layout';
import { AdminPage } from './pages/AdminPage';
import { AiPage } from './pages/AiPage';
import { CoUpPage } from './pages/CoUpPage';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './pages/AuthPages';
import { HomePage } from './pages/HomePage';
import { PlayPage } from './pages/PlayPage';
import { ProfilePage } from './pages/ProfilePage';
import { PuzzlePage } from './pages/PuzzlePage';
import { PuzzlesPage } from './pages/PuzzlesPage';
import { ReplayPage } from './pages/ReplayPage';
import { RoomPage } from './pages/RoomPage';
import { SeasonsPage } from './pages/SeasonsPage';

function NotFound() {
  const navigate = useNavigate();
  const canGoBack = typeof window !== 'undefined' && window.history.length > 1;
  return (
    <div className="nf">
      <div className="nf-code" aria-hidden="true">
        <span>4</span>
        <BrandLogo size={112} className="nf-piece" />
        <span>4</span>
      </div>
      <h1 className="nf-title">Không tìm thấy trang này</h1>
      <p className="nf-text">
        Có thể đường dẫn bị gõ sai, bị thiếu một phần, hoặc trang không còn nữa. Bạn về trang chủ để chơi tiếp, hoặc quay lại trang
        trước nhé.
      </p>
      <div className="nf-actions">
        <Link to="/" className="btn btn-primary btn-lg">
          <Icon name="home" size={20} />
          Về trang chủ
        </Link>
        {canGoBack && (
          <button type="button" className="btn btn-ghost btn-lg" onClick={() => navigate(-1)}>
            <Icon name="arrow-left" size={20} />
            Quay lại trang trước
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Mỗi ván một trang riêng: đổi sang ván khác (vd. ván mới vừa ghép được) thì dựng lại PlayPage từ đầu, không giữ bàn cờ,
 * kết quả, hộp thoại của ván trước (nếu vào ván mới bị lỗi, màn hình lỗi phải hiện thay vì ván cũ).
 */
function PlayRoute() {
  const { matchId = '' } = useParams();
  return <PlayPage key={matchId} />;
}

export function App() {
  // Đếm lượt xem trang cho bảng theo dõi của admin (mỗi lần đường dẫn đổi)
  const { pathname } = useLocation();
  useEffect(() => trackPageView(pathname), [pathname]);

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="verify-email" element={<VerifyEmailPage />} />
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />
        <Route path="seasons" element={<SeasonsPage />} />
        <Route path="co-up" element={<CoUpPage />} />
        <Route path="co-the" element={<PuzzlesPage />} />
        <Route path="co-the/:puzzleId" element={<PuzzlePage />} />
        {/* Chơi không cần tài khoản (tự vào với tư cách khách); chỉ xếp hạng mới cần đăng nhập */}
        <Route path="play/:matchId" element={<RequireAuth guest><PlayRoute /></RequireAuth>} />
        <Route path="ai" element={<AuthReady><AiPage /></AuthReady>} />
        <Route path="room/:code" element={<RequireAuth guest><RoomPage /></RequireAuth>} />
        <Route path="profile/:userId" element={<RequireAuth><ProfilePage /></RequireAuth>} />
        <Route path="replay/:matchId" element={<RequireAuth><ReplayPage /></RequireAuth>} />
        <Route path="admin" element={<RequireAuth admin><AdminPage /></RequireAuth>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
