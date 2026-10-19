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

const normalizationOptions = [
  { value: 'off', label: 'Off' },
  { value: 'song', label: 'Per song' },
  { value: 'album', label: 'Per folder (album)' },
];

const normalizationTargetOptions = [
  { value: -23, label: 'Quiet (-23 LUFS)' },
  { value: -18, label: 'Balanced (-18 LUFS)' },
  { value: -14, label: 'Loud (-14 LUFS)' },
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
    voiceGroups,
    onVoiceMaskChange,
    onTempoChange,
    paramDefs,
    paramValues,
    onParamChange,
    onPinParam,
    persistedSettings,
    replayGainDb,
    replayGainSource,
    replayGainAlbumProgress,
    sequencer,
  } = props;

  const { settings, updateSettings } = useContext(UserContext);
  const theme = settings?.theme;
  const silenceDuration = settings?.silenceDuration ?? -1;
  const showLoopArea = settings?.showLoopArea ?? true;
  const volumeNormalization = settings?.volumeNormalization ?? 'song';
  const normalizationTarget = Number(settings?.normalizationTarget ?? -18);

  const handleThemeChange = useCallback((e) => {
    updateSettings({ theme: e.target.value });
  }, [updateSettings]);

  const handleSilenceDurationChange = useCallback((e) => {
    updateSettings({ silenceDuration: Number(e.target.value) });
  }, [updateSettings]);

  const handleShowLoopAreaChange = useCallback((e) => {
    updateSettings({ showLoopArea: e.target.checked });
  }, [updateSettings]);

  const handleNormalizationChange = useCallback((e) => {
    updateSettings({ volumeNormalization: e.target.value });
  }, [updateSettings]);

  const handleNormalizationTargetChange = useCallback((e) => {
    updateSettings({ normalizationTarget: Number(e.target.value) });
  }, [updateSettings]);

  const formatGain = (db) => {
    const value = Number(db) || 0;
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
  };
  const normalizationStatus = (() => {
    if (volumeNormalization === 'off') return null;
    if (replayGainSource === 'pending') return 'Analyzing...';
    if (replayGainSource === 'album') {
      const progress = replayGainAlbumProgress;
      const suffix = progress ? ` (${progress.analyzed}/${progress.total} tracks)` : '';
      return `Album ${formatGain(replayGainDb)}${suffix}`;
    }
    if (replayGainSource === 'song') return `Song ${formatGain(replayGainDb)}`;
    return null;
  })();

  return (
    <div className='Settings'>
      <h3>{sequencer?.getPlayer()?.name || 'Player'} Settings</h3>
      {sequencer?.getPlayer() ?
        <PlayerParams
          ejected={ejected}
          tempo={tempo}
          voiceMask={voiceMask}
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
      <span className='PlayerParams-param'>
        <label
          htmlFor='volumeNormalization'
          title='ReplayGain-style level matching. "Per folder" keeps an album at one gain.'
          className="PlayerParams-label-wide">
          Volume Normalization:{' '}
        </label>
        <select
          id='volumeNormalization'
          onChange={handleNormalizationChange}
          value={volumeNormalization}>
          {normalizationOptions.map(option =>
            <option key={option.value} value={option.value}>{option.label}</option>
          )}
        </select>
      </span>
      {volumeNormalization !== 'off' &&
        <span className='PlayerParams-param'>
          <label
            htmlFor='normalizationTarget'
            title='Integrated loudness target. Quiet leaves more headroom; Loud matches streaming players but may limit peaks.'
            className="PlayerParams-label-wide">
            Loudness Target:{' '}
          </label>
          <select
            id='normalizationTarget'
            onChange={handleNormalizationTargetChange}
            value={normalizationTarget}>
            {normalizationTargetOptions.map(option =>
              <option key={option.value} value={option.value}>{option.label}</option>
            )}
          </select>
        </span>}
      {normalizationStatus &&
        <div className='PlayerParams-hint'>
          {normalizationStatus}
          {' '}
          <span title='Static gain is capped so the track does not clip; very dynamic songs may still end up below the target.'>
            (peak-capped)
          </span>
        </div>}
      {/* DEV-BEGIN (stripped for promotion; dev-only end-detector tuning) */}
      <EndDetectorTuning sequencer={sequencer} />
      {/* DEV-END */}
    </div>
  );
}

export default memo(Settings);
