import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Suggerimenti from './Suggerimento.jsx';
import './tokens.css';
import './styles.css';
import './microanimazioni.css'; // ultimo: vince su transizioni e animazioni dei file precedenti
import './schede.css'; // linguette dei pannelli (Panels.jsx): dopo tutti, vince sulla barra dei pannelli

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <Suggerimenti />
  </StrictMode>,
);
