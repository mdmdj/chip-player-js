import React, { PureComponent } from 'react';
import butterchurn from 'butterchurn';
import butterchurnPresets from 'butterchurn-presets';

// MilkDrop-style visuals via Butterchurn, a WebGL implementation of Milkdrop.
// It owns a WebGL2 canvas and taps the same audio node the spectrogram does.
const PRESET_ROTATE_MS = 20000;

export default class ButterchurnVisualizer extends PureComponent {
  static defaultProps = {
    autoCycle: true,
    blendSeconds: 2,
    resolutionScale: 1,
    meshWidth: 48,
    meshHeight: 36,
  };

  constructor(props) {
    super(props);

    this.state = { error: null };
    this.canvasRef = React.createRef();
    this.visualizer = null;
    this.animFrameId = null;
    this.rotateTimer = null;
    this.presetNames = [];
    this.presetIndex = 0;
    // The canvas keeps its CSS size; only the render buffer scales.
    this.baseWidth = props.width || 448;
    this.baseHeight = props.height || 800;
  }

  componentDidMount() {
    const canvas = this.canvasRef.current;
    const { audioCtx, sourceNode, meshWidth, meshHeight } = this.props;
    if (!canvas || !audioCtx) return;

    try {
      this.visualizer = butterchurn.createVisualizer(audioCtx, canvas, {
        width: this.baseWidth,
        height: this.baseHeight,
        meshWidth,
        meshHeight,
      });
      if (sourceNode) {
        this.visualizer.connectAudio(sourceNode);
      }
      // createVisualizer accepts the mesh, but set it explicitly too so a core
      // change in Butterchurn cannot silently ignore the setting.
      this.visualizer.setInternalMeshSize(meshWidth, meshHeight);

      this.presetNames = Object.keys(butterchurnPresets.getPresets());
      this.loadPresetAt(0, 0);
      this.applyResolution();
      this.syncAutoCycle();

      if (this.props.paused) {
        this.visualizer.render();
      } else {
        this.start();
      }
    } catch (e) {
      console.error('MilkDrop visualizer failed to initialize', e);
      this.setState({ error: e.message });
    }
  }

  componentDidUpdate(prevProps) {
    if (!this.visualizer) return;

    if (prevProps.sourceNode !== this.props.sourceNode && this.props.sourceNode) {
      this.visualizer.connectAudio(this.props.sourceNode);
    }
    if (prevProps.paused !== this.props.paused) {
      if (this.props.paused) {
        this.stop();
        this.visualizer.render();
      } else {
        this.start();
      }
    }
    if (prevProps.autoCycle !== this.props.autoCycle) {
      this.syncAutoCycle();
    }
    if (prevProps.meshWidth !== this.props.meshWidth ||
        prevProps.meshHeight !== this.props.meshHeight) {
      this.visualizer.setInternalMeshSize(this.props.meshWidth, this.props.meshHeight);
    }
    if (prevProps.resolutionScale !== this.props.resolutionScale) {
      this.applyResolution();
    }
  }

  componentWillUnmount() {
    this.stop();
    clearInterval(this.rotateTimer);
    this.rotateTimer = null;
    this.visualizer = null;
  }

  // Preset transport, also used by the controls in Visualizer.
  nextPreset = () => this.loadPresetAt(this.presetIndex + 1);

  prevPreset = () => this.loadPresetAt(this.presetIndex - 1);

  randomPreset = () => {
    if (this.presetNames.length < 2) return;
    let index = this.presetIndex;
    while (index === this.presetIndex) {
      index = Math.floor(Math.random() * this.presetNames.length);
    }
    this.loadPresetAt(index);
  };

  loadPresetAt(index, blendSeconds = this.props.blendSeconds) {
    if (!this.visualizer || this.presetNames.length === 0) return;

    const count = this.presetNames.length;
    const wrapped = ((index % count) + count) % count;
    const name = this.presetNames[wrapped];

    try {
      this.visualizer.loadPreset(butterchurnPresets.getPresets()[name], blendSeconds);
      this.presetIndex = wrapped;
      if (this.props.onPresetChange) {
        this.props.onPresetChange(name, wrapped, count);
      }
    } catch (e) {
      console.error('MilkDrop preset failed to load', name, e);
    }
  }

  syncAutoCycle() {
    clearInterval(this.rotateTimer);
    this.rotateTimer = null;
    if (this.visualizer && this.props.autoCycle) {
      this.rotateTimer = setInterval(() => this.nextPreset(), PRESET_ROTATE_MS);
    }
  }

  applyResolution() {
    if (!this.visualizer) return;
    const scale = this.props.resolutionScale || 1;
    this.visualizer.setRendererSize(
      Math.round(this.baseWidth * scale),
      Math.round(this.baseHeight * scale)
    );
  }

  start = () => {
    if (this.visualizer && this.animFrameId === null) {
      this.animFrameId = requestAnimationFrame(this.renderFrame);
    }
  };

  stop = () => {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  };

  renderFrame = () => {
    this.animFrameId = null;
    if (!this.visualizer) return;
    this.visualizer.render();
    this.animFrameId = requestAnimationFrame(this.renderFrame);
  };

  render() {
    const width = this.props.width || 448;
    const height = this.props.height || 800;

    return (
      <div className='MilkDrop' style={{ display: 'flex', width }}>
        <canvas ref={this.canvasRef}
                className='MilkDrop-canvas'
                width={width}
                height={height}/>
        {this.state.error &&
          <div className='MilkDrop-error'>MilkDrop unavailable: {this.state.error}</div>}
      </div>
    );
  }
}
