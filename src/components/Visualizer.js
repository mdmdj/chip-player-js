import pianoKeys from '../images/piano-keys.png';
import Spectrogram from '../Spectrogram';
import PianoRollVisualizer from '../piano-roll/PianoRollVisualizer';
import { isMidiData } from '../piano-roll/midi-parser';
import { usesTrackLoops } from '../players/midi/midi-helpers';
import { UserContext } from './UserProvider';
import React, { Fragment, PureComponent, Suspense, lazy } from 'react';

// The renderer and its preset pack are optional; keep them out of the main
// bundle and fetch them the first time MilkDrop is selected.
const ButterchurnVisualizer = lazy(() =>
  import(/* webpackChunkName: "butterchurn" */ '../butterchurn/ButterchurnVisualizer')
);

const SPECTROGRAM_MODES = [
  'Linear FFT', 'Log FFT', 'Constant Q'
];
const WEIGHTING_MODES = [
  {label: 'None', description: 'No attenuation'},
  {label: 'A-Weighting', description: 'Darkens low and high frequencies to approximate sensitivity of human hearing.'}
];
const FFT_SIZES = [
  512, 1024, 2048, 4096, 8192
];
const FFT_LABELS = [
  '512', '1K', '2K', '4K', '8K', '16K'
];
const SPEEDS = [
  1, 2, 4
];
const SPEED_LABELS = [
  'Lo', 'Med', 'Hi'
];
const VIS_WIDTH = 448;
const PRESET_BUTTON_STYLE = {
  width: '30.75px', // 19px * phi, the inline-icon height
  height: '19px',
  padding: 0,
  alignSelf: 'center',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxSizing: 'border-box',
};

export default class Visualizer extends PureComponent {
  static contextType = UserContext;

  constructor(props) {
    super(props);

    this.state = {
      vizMode: 2,
      weightingMode: 1,
      fftSize: 2048,
      speed: 2,
      presetName: '',
      presetIndex: 0,
      presetCount: 0,
      autoCycle: true,
      blendSeconds: 2,
    };

    this.freqCanvasRef = React.createRef();
    this.specCanvasRef = React.createRef();
    this.pianoKeysRef = React.createRef();
    this.milkdropRef = React.createRef();
  }

  componentDidMount() {
    this.spectrogram = new Spectrogram(
      this.props.chipCore,
      this.props.audioCtx,
      this.props.sourceNode,
      this.freqCanvasRef.current,
      this.specCanvasRef.current,
      this.pianoKeysRef.current,
    );
    this.spectrogram.setMode(this.state.vizMode);
    this.spectrogram.setWeighting(this.state.weightingMode);
    this.spectrogram.setSpeed(this.state.speed);

    const isMidi = this.isCurrentSongMidi();
    const showMilkDrop = this.props.visible && !isMidi && this.getRenderer() === 'milkdrop';
    this.spectrogram.setPaused(
      isMidi || showMilkDrop || !this.props.visible || this.props.paused
    );
  }

  isCurrentSongMidi() {
    return !!(
      (this.props.songPath && /\.(mid|midi|smf)$/i.test(this.props.songPath)) ||
      (this.props.sequencer?.getPlayer()?.fileExtensions?.includes('mid')) ||
      isMidiData(this.props.midiData)
    );
  }

  getRenderer() {
    return this.context?.settings?.visualizerRenderer || 'spectrogram';
  }

  componentDidUpdate() {
    const isMidi = this.isCurrentSongMidi();
    const showMilkDrop = this.props.visible && !isMidi && this.getRenderer() === 'milkdrop';

    // The spectrogram owns a rAF loop, so pause it whenever another renderer
    // is on screen or the visualizer is hidden.
    this.spectrogram.setPaused(
      isMidi || showMilkDrop || !this.props.visible || this.props.paused
    );
  }

  handlePresetNext = () => {
    this.milkdropRef.current?.nextPreset();
  };

  handlePresetPrev = () => {
    this.milkdropRef.current?.prevPreset();
  };

  handlePresetRandom = () => {
    this.milkdropRef.current?.randomPreset();
  };

  handlePresetChange = (presetName, presetIndex, presetCount) => {
    this.setState({ presetName, presetIndex, presetCount });
  };

  handleAutoCycleChange = (e) => {
    this.setState({ autoCycle: e.target.checked });
  };

  handleBlendChange = (e) => {
    this.setState({ blendSeconds: parseFloat(e.target.value) });
  };

  handleModeClick = (e) => {
    const mode = parseInt(e.target.value, 10);
    this.setState({vizMode: mode});
    this.spectrogram.setMode(mode);
  };

  handleWeightingModeClick = (e) => {
    const mode = parseInt(e.target.value, 10);
    this.setState({weightingMode: mode});
    this.spectrogram.setWeighting(mode);
  };

  handleFFTSizeClick = (e) => {
    const size = parseInt(e.target.value, 10);
    this.setState({fftSize: size});
    this.spectrogram.setFFTSize(size);
  };

  handleSpeedClick = (e) => {
    const speed = parseInt(e.target.value, 10);
    this.setState({ speed: speed });
    this.spectrogram.setSpeed(speed);
  };

  getAudioLatencyMs = () => {
    const { audioCtx, sourceNode } = this.props;
    if (!audioCtx) return 0;
    const bufferSize = sourceNode?.bufferSize || 2048;
    const sampleRate = audioCtx.sampleRate || 44100;
    const bufferLatency = bufferSize / sampleRate;
    const outputLatency = (typeof audioCtx.outputLatency === 'number' ? audioCtx.outputLatency : (audioCtx.baseLatency || 0));
    return (bufferLatency + outputLatency) * 1000;
  };

  render() {
    const isMidi = this.isCurrentSongMidi();
    const renderer = this.getRenderer();
    const settings = this.context?.settings || {};
    const showMilkDrop = this.props.visible && !isMidi && renderer === 'milkdrop';
    const [meshWidth, meshHeight] = (settings.milkdropMesh || '48x36').split('x').map(Number);

    const specStyle = {
      display: !isMidi && !showMilkDrop ? 'block' : 'none',
      width: VIS_WIDTH,
      boxSizing: 'border-box',
    };

    return (
      <div className='Visualizer' style={{ display: this.props.visible ? 'flex' : 'none' }}>
        {!isMidi && (
          <div className='Visualizer-options' style={{ width: VIS_WIDTH, boxSizing: 'border-box' }}>
            {renderer === 'milkdrop' && (
              <Fragment>
                <div className='PresetNav-row'>
                  <span className='Preset-glyph' title='Preset' aria-label='Preset'>
                    <svg viewBox='0 0 96 54' width='39.111' height='22' aria-hidden='true'>
                      <defs>
                        <clipPath id='preset-glyph-clip'>
                          <rect x='1.25' y='1.25' width='93.5' height='51.5'/>
                        </clipPath>
                      </defs>
                      <rect className='Preset-glyph-frame' x='0.75' y='0.75'
                            width='94.5' height='52.5'
                            fill='none' stroke='currentColor' strokeWidth='1'/>
                      <g clipPath='url(#preset-glyph-clip)'>
                        <g transform='translate(12 4)'>
                          <g transform='translate(-16 -4) translate(48 27) rotate(24) scale(1.4) translate(-48 -27)'
                             opacity='0.3'>
                            <polygon points='68,27 58,44.3 38,44.3 28,27 38,9.7 58,9.7'
                                     fill='none' stroke='currentColor' strokeWidth='1'/>
                            <polygon points='58,27 53,35.7 43,35.7 38,27 43,18.3 53,18.3'
                                     fill='none' stroke='currentColor' strokeWidth='1'/>
                          </g>
                          <g transform='rotate(8 48 27)'>
                            <polygon points='68,27 58,44.3 38,44.3 28,27 38,9.7 58,9.7'
                                     fill='none' stroke='currentColor' strokeWidth='1'/>
                            <polygon points='58,27 53,35.7 43,35.7 38,27 43,18.3 53,18.3'
                                     fill='none' stroke='currentColor' strokeWidth='1'/>
                          </g>
                        </g>
                      </g>
                    </svg>
                  </span>
                  <span className='PresetNav'>
                    <button className='box-button PresetNav-button' style={PRESET_BUTTON_STYLE} onClick={this.handlePresetPrev}
                            title='Previous preset'>
                      <span className='PresetNav-triangle PresetNav-triangle-prev'/>
                    </button>
                    <button className='box-button PresetNav-button' style={PRESET_BUTTON_STYLE} onClick={this.handlePresetNext}
                            title='Next preset'>
                      <span className='PresetNav-triangle PresetNav-triangle-next'/>
                    </button>
                    <button className='box-button PresetNav-button' style={PRESET_BUTTON_STYLE} onClick={this.handlePresetRandom}
                            title='Random preset'>
                      <span className='inline-icon icon-shuffle'/>
                    </button>
                  </span>
                </div>
                <div className='Visualizer-preset-name'>
                  {this.state.presetName || '\u2014'}
                  {this.state.presetCount > 0 &&
                    <span> ({this.state.presetIndex + 1}/{this.state.presetCount})</span>}
                </div>
              </Fragment>
            )}
            {renderer === 'spectrogram' && (
              <Fragment>
                <div>
                  <span className='VisualizerParams-label'>Mode:</span>
                  {
                    SPECTROGRAM_MODES.map((mode, i) =>
                      <label key={'m_'+i} className='inline'><input onClick={this.handleModeClick}
                                            type='radio'
                                            name='spectrogram-mode'
                                            defaultChecked={this.state.vizMode === i}
                                            value={i}/>{mode}</label>
                    )
                  }
                </div>
                {this.state.vizMode === 2 ?
                  <div>
                    <span className='VisualizerParams-label'>Weighting:</span>
                    {
                      WEIGHTING_MODES.map((mode, i) =>
                        <Fragment key={'w_'+i}>
                          <input onClick={this.handleWeightingModeClick}
                                 type='radio'
                                 id={'w_'+i}
                                 name='weighting-mode'
                                 defaultChecked={this.state.weightingMode === i}
                                 value={i}/>
                          <label htmlFor={'w_'+i} title={mode.description} className='inline'>
                          {mode.label}</label>
                        </Fragment>
                      )
                    }
                  </div>
                  :
                  <div>
                    <span className='VisualizerParams-label'>FFT Size:</span>
                    {
                      FFT_SIZES.map((size, i) =>
                        <Fragment key={'f_'+i}>
                          <input onClick={this.handleFFTSizeClick}
                                 type='radio'
                                 id={'f_'+i}
                                 name='fft-size'
                                 defaultChecked={this.state.fftSize === size}
                                 value={size}/>
                          <label htmlFor={'f_'+i} className='inline'>{FFT_LABELS[i]}</label>
                        </Fragment>
                      )
                    }
                  </div>
                }
                <div title="Vertical scrolling speed (pixels per frame)">
                  <span className='VisualizerParams-label'>Speed:</span>
                  {
                    SPEEDS.map((speed, i) =>
                      <Fragment key={'s_'+i}>
                        <input onClick={this.handleSpeedClick}
                               type='radio'
                               id={'s_'+i}
                               name='speed'
                               defaultChecked={this.state.speed === speed}
                               value={speed}/>
                        <label htmlFor={'s_'+i} className='inline'>{SPEED_LABELS[i]}</label>
                      </Fragment>
                    )
                  }
                </div>
              </Fragment>
            )}
          </div>
        )}

        {/* Piano Roll visualizer for MIDI files */}
        {isMidi && (
          <PianoRollVisualizer
            width={this.props.theaterMode ? '100%' : VIS_WIDTH}
            midiData={this.props.midiData}
            // Take the path from the sequencer, the same live source App reads
            // the buffer from, so the gate and the data it describes arrive in
            // the same render (App's songPath state lags one behind).
            useTrackLoops={usesTrackLoops(this.props.sequencer?.getCurrSongPath() ?? this.props.songPath)}
            getCurrentPositionMs={this.props.getCurrentPositionMs}
            getPlaybackRate={this.props.getPlaybackRate}
            getAudioLatencyMs={this.getAudioLatencyMs}
            getIsPlaying={this.props.getIsPlaying}
            paused={this.props.visible ? this.props.paused : true}
            voiceMask={this.props.voiceMask}
            theaterMode={this.props.theaterMode}
            onToggleTheaterMode={this.props.onToggleTheaterMode}
            onAuditionChord={this.props.onAuditionChord}
            style={{
              display: 'flex',
              width: this.props.theaterMode ? '100%' : VIS_WIDTH,
              boxSizing: 'border-box',
            }}
          />
        )}

        {/* MilkDrop visualizer (Butterchurn) */}
        {showMilkDrop && (
          <Suspense fallback={
            <div className='MilkDrop MilkDrop-placeholder' style={{ width: VIS_WIDTH }}>
              Loading MilkDrop…
            </div>
          }>
            <ButterchurnVisualizer
              ref={this.milkdropRef}
              audioCtx={this.props.audioCtx}
              sourceNode={this.props.sourceNode}
              width={VIS_WIDTH}
              height={800}
              paused={!this.props.visible || this.props.paused}
              autoCycle={this.state.autoCycle}
              blendSeconds={this.state.blendSeconds}
              meshWidth={meshWidth}
              meshHeight={meshHeight}
              resolutionScale={settings.milkdropResolution || 1}
              onPresetChange={this.handlePresetChange}
            />
          </Suspense>
        )}

        {/* Spectrogram visualizer */}
        <canvas style={specStyle} className='Visualizer-analyzer' width={VIS_WIDTH} height={60}
                ref={this.freqCanvasRef}/>
        <canvas style={specStyle} className='Visualizer-spectrogram' width={VIS_WIDTH} height={800}
                ref={this.specCanvasRef}/>
        <img src={pianoKeys}
             className='Visualizer-overlay'
             ref={this.pianoKeysRef}
             alt='Piano keys'
             style={{
               display: (!isMidi && !showMilkDrop && this.state.vizMode === 2) ? 'block' : 'none',
               width: VIS_WIDTH,
             }}/>
      </div>
    );
  }
}
