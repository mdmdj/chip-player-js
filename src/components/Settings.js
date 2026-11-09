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
  { value: 'auto', label: 'Auto (by context)' },
  { value: 'song', label: 'Per song' },
  { value: 'album', label: 'Per folder (album)' },
];

const normalizationTargetOptions = [
  { value: -23, label: 'Quiet (-23 LUFS)' },
  { value: -18, label: 'Balanced (-18 LUFS)' },
  { value: -14, label: 'Loud (-14 LUFS)' },
];


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
  const volumeNormalization = settings?.volumeNormalization ?? 'auto';
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
    const prefix = volumeNormalization === 'auto' ? 'Auto · ' : '';
    if (replayGainSource === 'album') {
      const progress = replayGainAlbumProgress;
      const suffix = progress ? ` (${progress.analyzed}/${progress.total} tracks)` : '';
      return `${prefix}Album ${formatGain(replayGainDb)}${suffix}`;
    }
    if (replayGainSource === 'song') return `${prefix}Song ${formatGain(replayGainDb)}`;
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
          <span title='Static gain is capped so the track does not clip at 100% volume; very dynamic songs may still end up below the target.'>
            (peak-capped)
          </span>
        </div>}
    </div>
  );
}

export default memo(Settings);
