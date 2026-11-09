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
        {showVisualizer && !isMidi &&
        <div className="Visualizer-renderer-toggle">
          <label htmlFor="visualizer-renderer">Renderer:</label>{' '}
          <select id="visualizer-renderer"
                  value={renderer}
                  onChange={handleRendererChange}>
            <option value="spectrogram">Spectrogram</option>
            <option value="milkdrop">MilkDrop</option>
          </select>
        </div>
        }
      </div>
    </header>
  );
};

export default AppHeader;
