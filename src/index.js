import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './components/App';
import { BrowserRouter as Router } from 'react-router-dom';
import { UserProvider } from './components/UserProvider';
import { ToastProvider } from './components/ToastProvider';
import ThemeHandler from './components/ThemeHandler';
import { initGA } from './analytics';

initGA();

// Build provenance for the audio engines, stamped in by webpack (see
// config/webpack.config.common.js). Deliberately not in the UI: it exists so a
// deployed build can be asked what it was built from -- run
// JSON.parse(window.ChipCoreBuildInfo) in the console.
window.ChipCoreBuildInfo = __BUILD_INFO__;

ReactDOM.render((
  <Router basename={process.env.PUBLIC_URL}>
    <ToastProvider>
      <UserProvider>
        <ThemeHandler/>
        <App/>
      </UserProvider>
    </ToastProvider>
  </Router>
), document.getElementById('root'));
