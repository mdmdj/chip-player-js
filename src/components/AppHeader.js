import React, { useContext } from 'react';
import { Link } from 'react-router-dom';
import { UserContext } from './UserProvider';

const AppHeader = ({ isMidi }) => {
  const { user, handleLogout, handleLogin, settings, updateSettings } = useContext(UserContext);
  const showVisualizer = settings?.showVisualizer;
  const renderer = settings?.visualizerRenderer || 'spectrogram';

  const handleToggleVisualizer = (e) => {
    const enabled = e.target.value === 'true';
    updateSettings({ showVisualizer: enabled });
  };

  const handleRendererChange = (e) => {
    updateSettings({ visualizerRenderer: e.target.value });
  };

  return (
    <header className="AppHeader">
      <Link className="AppHeader-title" to={{ pathname: "/" }}>Chip Player JS</Link>
      {user ?
        <>
          {' • '}
          Logged in as {user.displayName}.
          {' '}
          <a href="#" onClick={handleLogout}>Logout</a>
        </>
        :
        <>
          {' • '}
          <a href="#" onClick={handleLogin}>Login/Sign Up</a> to Save Favorites
        </>
      }
      {' • '}
      <a href="https://twitter.com/messages/compose?recipient_id=587634572" target="_blank" rel="noopener noreferrer">
        Feedback
      </a>
      <div className="Visualizer-controls">
        <h3 className="Visualizer-toggle">
          Visualizer{' '}
          <input onChange={handleToggleVisualizer}
                 id="vis-on"
                 type="radio"
                 value="true"
                 checked={showVisualizer === true}
                 name="visualizer-enabled"/>
          <label htmlFor="vis-on" className="inline">On</label>
          <input onChange={handleToggleVisualizer}
                 id="vis-off"
                 type="radio"
                 value="false"
                 checked={showVisualizer === false}
                 name="visualizer-enabled"/>
          <label htmlFor="vis-off" className="inline">Off</label>
        </h3>
        <div className="Visualizer-renderer-toggle">
          <span>Renderer:</span>{' '}
          <label className="inline">
            <input onChange={handleRendererChange}
                   type="radio"
                   value="spectrogram"
                   checked={renderer === 'spectrogram'}
                   name="visualizer-renderer"/> Spectrogram
          </label>
          <label className="inline">
            <input onChange={handleRendererChange}
                   type="radio"
                   value="milkdrop"
                   checked={renderer === 'milkdrop'}
                   name="visualizer-renderer"/> MilkDrop
          </label>
        </div>
      </div>
    </header>
  );
};

export default AppHeader;
