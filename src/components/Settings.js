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

// DEV-BEGIN (stripped for promotion; dev-only end-detector tuning panel. A
// player that uses EndDetector exposes it as `player.endDetector`; this
// component and its usage below strip together, leaving production untouched.)
function EndDetectorTuning({ sequencer }) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => setTick(n => n + 1), 500);
    return () => clearInterval(timer);
  }, []);
  const player = sequencer?.getPlayer?.();
  const detector = player?.endDetector;
  if (!detector || typeof detector.setTuning !== 'function') {
    console.debug('[dev] EndDetectorTuning: no end detector on %s.',
      player?.name || 'no player');
    return null;
  }
  const state = detector.getState({
    positionMs: player.getPositionMs(),
    durationMs: player.getDurationMs(),
  });
  const tune = (patch) => {
    detector.setTuning(patch);
    setTick(n => n + 1);
  };
  const slider = (key, label, min, max, step, decimals) => (
    <span key={key} className='PlayerParams-param'>
      <label htmlFor={`endTune-${key}`} className="PlayerParams-label">
        {label}:{' '}
      </label>
      <input
        id={`endTune-${key}`}
        type='range'
        min={min} max={max} step={step}
        value={state[key]}
        onInput={(e) => tune({ [key]: parseFloat(e.target.value) })}
        onChange={(e) => tune({ [key]: parseFloat(e.target.value) })}
      />
      {' '}
      {state[key].toFixed(decimals)}
    </span>
  );
  return (
    <div>
      <h3>End Detector (dev)</h3>
      {slider('quietMean', 'Quiet mean', 0, 0.05, 0.0005, 4)}
      {slider('staticRange', 'Static range', 0, 0.01, 0.0001, 4)}
      {slider('windowSec', 'Window (s)', 2, 12, 1, 0)}
      {slider('tapStep', 'Tap step', 1, 32, 1, 0)}
      <span className='PlayerParams-param'>
        <button className="box-button" onClick={() => tune(null)}>
          Reset tuning
        </button>
      </span>
      <div>
        pos {Math.round(state.positionMs)} ms / trip {Math.round(state.tripAtMs)} ms
      </div>
      <div>
        window [{state.windowMeans.map(m => m.toFixed(4)).join(', ')}]
      </div>
    </div>
  );
}
// DEV-END

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
      {/* DEV-BEGIN (stripped for promotion; dev-only end-detector tuning) */}
      <EndDetectorTuning sequencer={sequencer} />
      {/* DEV-END */}
    </div>
  );
}

export default memo(Settings);
