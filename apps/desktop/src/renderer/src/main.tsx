import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyPreferences, loadPreferences } from './lib/preferences';
import './styles.css';

// Apply the saved theme before the first paint so the window never flashes the wrong colours.
applyPreferences(loadPreferences());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
