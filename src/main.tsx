import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initNet } from './lib/net';
import './styles.css';

initNet().finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
