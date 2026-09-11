import '@expo/metro-runtime';
import { createRoot } from 'react-dom/client';

import './style.css';

createRoot(document.getElementById('root')).render(
  <>
    <h1>H.264 encoding test</h1>
    <section />
    <div className="shape" />
    <p>Hardware / software comparison</p>
  </>
);
