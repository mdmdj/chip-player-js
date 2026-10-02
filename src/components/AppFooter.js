import React, { memo, useCallback, useContext } from 'react';
import TimeSlider from './TimeSlider';
import VolumeSlider from './VolumeSlider';
import FavoriteButton from './FavoriteButton';
import { REPEAT_LABELS, SHUFFLE_LABELS } from '../Sequencer';
import { UserContext } from './UserProvider';
import DirectoryLink from './DirectoryLink';
import { getUrlFromFilepath, pathJoin } from '../util';

function directoryLinkFromFilepath(filepath, isSongFolder) {
  if (!filepath) return null;
  const sep = '/';

  // A multi-song file is itself a "song folder" in Browse, so show the whole
  // path (matching the Browse header) instead of just its parent directory.
  const browsePath = isSongFolder
    ? filepath
    : filepath.split(sep).slice(0, -1).join(sep);
  // Same escaping as Browse: %/# must be pre-escaped for react-router.
  const href = browsePath.replace(/%/g, '%25').replace(/#/g, '%23');
  return <DirectoryLink dim to={pathJoin('/browse', href)}>{browsePath}</DirectoryLink>;
}

export default memo(AppFooter);
function AppFooter(props) {
  const {
    // this.state.
    currentSongDurationMs,
    ejected,
    imageUrl,
    infoTexts,
    isSongFolder,
    md5,
    paused,
    repeat,
    shuffle,
    songId,
    songRef,
    songPath,
    subtitle,
    title,
    volume,

    // this.
    getCurrentSongLink,
    handleCopyLink,
    handleCycleRepeat,
    handleCycleShuffle,
    handleTimeSliderChange,
    handleVolumeChange,
    nextSong,
    prevSong,
    sequencer,
    toggleInfo,
    togglePause,
  } = props;

  const {
    faves,
    settings,
  } = useContext(UserContext);

  const directoryLink = directoryLinkFromFilepath(songPath, isSongFolder);
  const songUrl = getUrlFromFilepath(songPath);

  // The highlighted loop band is engine policy: the player reports it in ms
  // (see Player.getLoopBandMs) and the footer only maps it onto the slider.
  // Visual only: hiding the band never changes playback or the head fold.
  const showLoopArea = settings?.showLoopArea ?? true;
  const bandMs = showLoopArea ? sequencer?.getPlayer()?.getLoopBandMs?.() || null : null;
  // Blind loop: playing indefinitely with no known loop region AND past the
  // track length without ending (e.g. an NSF driver looping internally).
  // Any head position out there would be a lie, so the slider parks at the
  // end, the elapsed time keeps climbing, and the duration label reads
  // "Looping". The past-the-end condition is the scoping: engines that end
  // at their length (MIDI, XMP, SID, ...) never dwell there -- they loop via
  // stop + reload -- so they keep the normal slider. Live-read so toggling
  // repeat off restores the normal slider on the next render/tick. Note the
  // raw band (not the visual toggle): hiding the band must not trigger
  // blind UI.
  const isBlindLoopNow = () => {
    const p = sequencer?.getPlayer?.() || null;
    if (!p || typeof p.isPlayingIndefinitely !== 'function' || !p.isPlayingIndefinitely()) return false;
    if (typeof p.getLoopBandMs === 'function' && p.getLoopBandMs()) return false;
    const duration = typeof p.getDurationMs === 'function' ? p.getDurationMs() : 0;
    if (!(duration > 0)) return false;
    if (typeof p.isPlaying === 'function' && !p.isPlaying()) return false;
    return p.getPositionMs() >= duration;
  };
  const loopStart = bandMs && currentSongDurationMs > 0
    ? bandMs.startMs / currentSongDurationMs
    : null;
  const loopEnd = bandMs && currentSongDurationMs > 0
    ? Math.min(bandMs.endMs / currentSongDurationMs, 1)
    : null;

  const handleToggleInfo = useCallback((e) => {
    e.preventDefault();
    toggleInfo();
  }, [toggleInfo]);

  // The shareable link carries the sub-tune; the href and the clipboard
  // copy must agree so right-click/copy and middle-click keep the sub-song.
  const songLink = getCurrentSongLink(/*withSubtune=*/true);

  const handleCopySongLink = useCallback((e) => {
    e.preventDefault();
    handleCopyLink(songLink);
  }, [songLink, handleCopyLink]);

  const playPauseTitle = paused ? 'Play' : 'Pause';
  const playPauseClass = paused ? 'icon-play' : 'icon-pause';

  return (
    <div className="AppFooter">
      <div className="AppFooter-main">
        <div className="AppFooter-top-row">
          <button onClick={prevSong}
                  title="Previous"
                  className="box-button"
                  disabled={ejected}>
            <span className="inline-icon icon-prev"/>
          </button>
          <button onClick={togglePause}
                  title={playPauseTitle}
                  className="box-button"
                  disabled={ejected}>
            <span className={`inline-icon ${playPauseClass}`}/>
          </button>
          <button onClick={nextSong}
                  title="Next"
                  className="box-button"
                  disabled={ejected}>
            <span className="inline-icon icon-next"/>
          </button>
          <button title="Cycle Repeat (repeat off, repeat all songs in the context, or repeat one song)"
                  style={{ marginLeft: 'auto' }}
                  className="AppFooter-repeat box-button" onClick={handleCycleRepeat}>
            <span className="inline-icon icon-repeat"/>
            {REPEAT_LABELS[repeat]}
          </button>
          <button title="Toggle shuffle mode"
                  className="AppFooter-shuffle box-button" onClick={handleCycleShuffle}>
            <span className="inline-icon icon-shuffle"/>
            {SHUFFLE_LABELS[shuffle]}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 'var(--charW2)' }}>
          <TimeSlider
            paused={paused}
            currentSongDurationMs={currentSongDurationMs}
            loopStart={loopStart}
            loopEnd={loopEnd}
            getIsBlindLoop={isBlindLoopNow}
            getCurrentPositionMs={() => {
              const player = sequencer && sequencer.getPlayer();
              if (!player) return 0;
              // Blind loop shows absolute time played, climbing unbounded;
              // otherwise the player's playlist (folded) position.
              if (isBlindLoopNow()) return player.getPositionMs();
              return player.getDisplayPositionMs ? player.getDisplayPositionMs() : player.getPositionMs();
            }}
            onChange={handleTimeSliderChange}/>
          <VolumeSlider
            onChange={(e) => {
              handleVolumeChange(e.target.value);
            }}
            handleReset={(e) => {
              handleVolumeChange(100);
              e.preventDefault();
              e.stopPropagation();
            }}
            title="Double-click or right-click to reset to 100%."
            value={volume}/>
        </div>
        {!ejected &&
          <div className="SongDetails">
            {faves && songPath &&
              <FavoriteButton item={{
                path: songPath,
                subtune: songRef?.subtune ?? 0,
                songId: songId,
              }}/>}
            <div className="SongDetails-title">
              {songPath ?
                <>
                  <a href={songLink}
                     title="Copy song link to clipboard"
                     onClick={handleCopySongLink}>
                    {title}{' '}
                    <span className="inline-icon icon-copy"/>
                  </a>
                  <a href={songUrl}
                     title="Download song">
                    <span className="inline-icon icon-download"/>
                  </a>
                </>
                :
                title
              }
              {infoTexts.length > 0 &&
                <a onClick={handleToggleInfo} href="#" title="Display song information">
                  тхт
                </a>
              }
              {md5 &&
                <a href={`https://modsamplemaster.thegang.nu/module.php?md5=${md5}`}
                   title="Look up this song on Mod Sample Master" target="_blank">
                  msm
                </a>
              }
            </div>
            <div className="SongDetails-subtitle">{subtitle}</div>
            <div className="SongDetails-filepath">{directoryLink}</div>
          </div>}
      </div>
      {imageUrl && <img alt="Cover art" className="AppFooter-art" src={imageUrl}/>}
    </div>
  );
}
