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

// DEV-BEGIN (stripped for promotion; engine build provenance. config/webpack.config.common.js
// DefinePlugins __BUILD_INFO__ and that config is path-listed, so neither survives
// promotion -- the assignment has to strip with it or it would reference an undefined global.)
// Build provenance for the audio engines, stamped in by webpack (see
// config/webpack.config.common.js). Deliberately not in the UI: it exists so a
// deployed build can be asked what it was built from -- run
// JSON.parse(window.ChipCoreBuildInfo) in the console.
window.ChipCoreBuildInfo = __BUILD_INFO__;
// DEV-END
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
