import React, { memo, useCallback, useContext } from 'react';
import PlayerParams from './PlayerParams';
import { UserContext } from "./UserProvider";

const themes = [
  {
    value: 'msdos',
    label: 'MS-DOS',
  },
  {
    value: 'winamp',
    label: 'Winamp',
  }
];

const silenceOptions = [
  { value: -1, label: 'None' },
  { value: 0, label: '0 seconds (Gapless)' },
  { value: 1, label: '1 second' },
  { value: 2, label: '2 seconds' },
  { value: 3, label: '3 seconds' },
  { value: 5, label: '5 seconds' },
];

const milkdropMeshOptions = [
  { value: '32x24', label: 'Low (32 x 24)' },
  { value: '48x36', label: 'Balanced (48 x 36)' },
  { value: '64x48', label: 'High (64 x 48)' },
  { value: '96x72', label: 'Ultra (96 x 72)' },
];

const milkdropResolutionOptions = [
  { value: 0.5, label: '50%' },
  { value: 1, label: '100%' },
  { value: 1.5, label: '150%' },
  { value: 2, label: '200%' },
];


function Settings(props) {
  const {
    ejected,
    tempo,
    voiceMask,
    voiceNames,
    voiceGroups,
    onVoiceMaskChange,
    onTempoChange,
    paramDefs,
    paramValues,
    onParamChange,
    onPinParam,
    persistedSettings,
    sequencer,
  } = props;

  const { settings, updateSettings } = useContext(UserContext);
  const theme = settings?.theme;
  const silenceDuration = settings?.silenceDuration ?? -1;
  const showLoopArea = settings?.showLoopArea ?? true;
  const visualizerRenderer = settings?.visualizerRenderer || 'spectrogram';
  const showVisualizer = settings?.showVisualizer;
  const milkdropMesh = settings?.milkdropMesh || '48x36';
  const milkdropResolution = settings?.milkdropResolution ?? 1;
  const player = sequencer?.getPlayer?.();
  const isMidi = /\.(mid|midi|smf)$/i.test(sequencer?.getCurrSongPath?.() || '') ||
    Boolean(player?.fileExtensions?.includes('mid'));
  const milkdropActive = Boolean(showVisualizer && visualizerRenderer === 'milkdrop' && !isMidi);

  const handleMilkdropMeshChange = useCallback((e) => {
    updateSettings({ milkdropMesh: e.target.value });
  }, [updateSettings]);

  const handleMilkdropResolutionChange = useCallback((e) => {
    updateSettings({ milkdropResolution: Number(e.target.value) });
  }, [updateSettings]);

  const handleThemeChange = useCallback((e) => {
    updateSettings({ theme: e.target.value });
  }, [updateSettings]);

  const handleSilenceDurationChange = useCallback((e) => {
    updateSettings({ silenceDuration: Number(e.target.value) });
  }, [updateSettings]);

  const handleShowLoopAreaChange = useCallback((e) => {
    updateSettings({ showLoopArea: e.target.checked });
  }, [updateSettings]);

  return (
    <div className='Settings'>
      <h3>{sequencer?.getPlayer()?.name || 'Player'} Settings</h3>
      {sequencer?.getPlayer() ?
        <PlayerParams
          ejected={ejected}
          tempo={tempo}
          voiceMask={voiceMask}
          voiceNames={voiceNames}
          voiceGroups={voiceGroups}
          onTempoChange={onTempoChange}
          onVoiceMaskChange={onVoiceMaskChange}
          paramDefs={paramDefs}
          paramValues={paramValues}
          onParamChange={onParamChange}
          onPinParam={onPinParam}
          persistedSettings={persistedSettings}
          playerKey={sequencer?.getPlayer()?.playerKey}
        />
        :
        <div>(No active player)</div>}
      <h3>Global Settings</h3>
      <span className='PlayerParams-param'>
        <label htmlFor='theme' className="PlayerParams-label-wide">
          Theme:{' '}
        </label>
        <select
          id='theme'
          onChange={handleThemeChange}
          value={theme}>
          {themes.map(option =>
            <option key={option.value} value={option.value}>{option.label}</option>
          )}
        </select>
      </span>
      <span className='PlayerParams-param'>
        <label htmlFor='silenceDuration' title='Silence between songs' className="PlayerParams-label-wide">
          Insert Silence:{' '}
        </label>
        <select
          id='silenceDuration'
          onChange={handleSilenceDurationChange}
          value={silenceDuration}>
          {silenceOptions.map(option =>
            <option key={option.value} value={option.value}>{option.label}</option>
          )}
        </select>
      </span>
      <span className='PlayerParams-param'>
        <input type='checkbox'
               id='showLoopArea'
               onChange={handleShowLoopAreaChange}
               checked={!!showLoopArea}/>
        <label htmlFor='showLoopArea' title='For songs with a defined Loop Area, highlight it in the Player bar. The Loop Area will be looped in Repeat One mode.'>
          Show Loop Area
        </label>
      </span>
      {milkdropActive &&
        <React.Fragment>
          <h3>MilkDrop</h3>
          <span className='PlayerParams-param'>
            <label htmlFor='milkdropMesh' title='Simulation mesh resolution. Lower is faster.' className="PlayerParams-label-wide">
              Mesh:{' '}
            </label>
            <select
              id='milkdropMesh'
              onChange={handleMilkdropMeshChange}
              value={milkdropMesh}>
              {milkdropMeshOptions.map(option =>
                <option key={option.value} value={option.value}>{option.label}</option>
              )}
            </select>
          </span>
          <span className='PlayerParams-param'>
            <label htmlFor='milkdropResolution' title='Render resolution. Lower is faster.' className="PlayerParams-label-wide">
              Resolution:{' '}
            </label>
            <select
              id='milkdropResolution'
              onChange={handleMilkdropResolutionChange}
              value={milkdropResolution}>
              {milkdropResolutionOptions.map(option =>
                <option key={option.value} value={option.value}>{option.label}</option>
              )}
            </select>
          </span>
        </React.Fragment>
      }
    </div>
  );
}

export default memo(Settings);
