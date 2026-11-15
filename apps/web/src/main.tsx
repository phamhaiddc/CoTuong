import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './state/auth';
import { GameSelectProvider } from './state/game-select';
import { RealtimeProvider } from './state/realtime';
import { ThemeProvider } from './state/theme';
import { ToastProvider } from './state/toast';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <GameSelectProvider>
              <RealtimeProvider>
                <App />
              </RealtimeProvider>
            </GameSelectProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
