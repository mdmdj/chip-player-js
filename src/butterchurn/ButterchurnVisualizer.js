import React, { PureComponent } from 'react';
import butterchurn from 'butterchurn';
import butterchurnPresets from 'butterchurn-presets';
import { reportVisualizerFps } from './fps';

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

    this.state = { error: null, loading: true };
    this.canvasRef = React.createRef();
    this.visualizer = null;
    this.animFrameId = null;
    this.rotateTimer = null;
    this.initTimer = null;
    this.unmounted = false;
    this.resizeObserver = null;
    this.presetNames = [];
    this.presetIndex = 0;
    this.fpsFrames = 0;
    this.fpsStart = 0;
    // The canvas keeps its CSS size; only the render buffer scales.
    this.baseWidth = props.width || 448;
    this.baseHeight = props.height || 800;
  }

  componentDidMount() {
    this.unmounted = false;
    const canvas = this.canvasRef.current;
    if (canvas && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(canvas);
    }
    // Defer the synchronous WebGL/preset init by a task so the loading state
    // gets a paint before shader compilation blocks the main thread.
    this.initTimer = setTimeout(this.initialize, 0);
  }

  initialize = () => {
    this.initTimer = null;
    if (this.unmounted) return;

    const canvas = this.canvasRef.current;
    const { audioCtx, sourceNode, meshWidth, meshHeight } = this.props;
    if (!canvas || !audioCtx) {
      this.setState({ loading: false });
      return;
    }

    try {
      // The canvas is CSS-sized by its flex parent; use that size as the base
      // so the render fills the available visualizer area and is centred in it.
      const rect = canvas.getBoundingClientRect();
      this.baseWidth = Math.max(1, Math.round(rect.width)) || this.props.width || 448;
      this.baseHeight = Math.max(1, Math.round(rect.height)) || this.props.height || 800;

      // Butterchurn's target ("window") is the CSS size times the resolution
      // scale; the canvas backing store is the same size, and CSS upscales it.
      const target = this.getTargetSize();
      canvas.width = target.width;
      canvas.height = target.height;

      this.visualizer = butterchurn.createVisualizer(audioCtx, canvas, {
        width: target.width,
        height: target.height,
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
      this.syncAutoCycle();

      // DEV-BEGIN (stripped for promotion; deterministic recorder hook)
      // The offline recorder needs the live Butterchurn instance and its canvas;
      // it stops the rAF loop and drives render({ audioLevels, elapsedTime })
      // itself so the output is CFR rather than a screencast.
      window.__cpMilkdrop = this;
      // DEV-END
      if (this.props.paused) {
        this.visualizer.render();
      } else {
        this.start();
      }
      if (!this.unmounted) {
        this.setState({ loading: false });
      }
    } catch (e) {
      console.error('MilkDrop visualizer failed to initialize', e);
      if (!this.unmounted) {
        this.setState({ error: e.message, loading: false });
      }
    }
  };

  componentDidUpdate(prevProps) {
    if (!this.visualizer) return;

    if (prevProps.sourceNode !== this.props.sourceNode) {
      if (prevProps.sourceNode) {
        this.visualizer.disconnectAudio(prevProps.sourceNode);
      }
      if (this.props.sourceNode) {
        this.visualizer.connectAudio(this.props.sourceNode);
      }
    }
    if (prevProps.paused !== this.props.paused) {
      if (this.props.paused) {
        this.stop();
        this.visualizer.render();
      } else {
        this.start();
      }
    }
    if (prevProps.autoCycle !== this.props.autoCycle ||
        prevProps.paused !== this.props.paused) {
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
    this.unmounted = true;
    clearTimeout(this.initTimer);
    this.initTimer = null;
    this.stop();
    clearInterval(this.rotateTimer);
    this.rotateTimer = null;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.visualizer && this.props.sourceNode) {
      this.visualizer.disconnectAudio(this.props.sourceNode);
    }
    // DEV-BEGIN (stripped for promotion; deterministic recorder hook)
    if (window.__cpMilkdrop === this) window.__cpMilkdrop = null;
    // DEV-END
    this.visualizer = null;
  }

  handleResize = () => {
    const canvas = this.canvasRef.current;
    if (!canvas || !this.visualizer) return;

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.baseWidth && height === this.baseHeight) return;

    this.baseWidth = width;
    this.baseHeight = height;
    this.applyResolution();
  };

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
      // A paused transport action cannot animate a multi-second blend because
      // the rAF loop is stopped. Load the destination immediately instead of
      // leaving a single half-blended frame on screen; Blend still applies to
      // changes made while playing.
      const blend = this.props.paused ? 0 : blendSeconds;
      this.visualizer.loadPreset(butterchurnPresets.getPresets()[name], blend);
      this.presetIndex = wrapped;
      if (this.props.onPresetChange) {
        this.props.onPresetChange(name, wrapped, count);
      }
      // The rAF loop is stopped while paused, so loadPreset alone leaves the
      // previous preset's image on screen. Draw once after a manual transport
      // action as well.
      if (this.props.paused) this.visualizer.render();
    } catch (e) {
      console.error('MilkDrop preset failed to load', name, e);
    }
  }

  syncAutoCycle() {
    clearInterval(this.rotateTimer);
    this.rotateTimer = null;
    if (this.visualizer && this.props.autoCycle && !this.props.paused) {
      this.rotateTimer = setInterval(() => this.nextPreset(), PRESET_ROTATE_MS);
    }
  }

  getTargetSize() {
    const scale = this.props.resolutionScale || 1;
    return {
      width: Math.max(1, Math.round(this.baseWidth * scale)),
      height: Math.max(1, Math.round(this.baseHeight * scale)),
    };
  }

  applyResolution() {
    if (!this.visualizer) return;
    const { width, height } = this.getTargetSize();
    this.visualizer.setRendererSize(width, height);
    // setRendererSize changes Butterchurn's render target/viewport but not the
    // canvas backing store. Without this, a scale below 1 renders into the
    // bottom-left corner of the still-base-sized canvas. The CSS size stays
    // baseWidth x baseHeight, so the browser upscales the smaller buffer.
    const canvas = this.canvasRef.current;
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
    }
    // Resizing the backing store clears the canvas. The rAF loop is stopped
    // while paused, so draw one frame immediately or the renderer stays blank
    // until playback resumes.
    if (this.props.paused) this.visualizer.render();
  }

  start = () => {
    if (this.visualizer && this.animFrameId === null) {
      this.fpsFrames = 0;
      this.fpsStart = 0;
      reportVisualizerFps(0, true);
      this.animFrameId = requestAnimationFrame(this.renderFrame);
    }
  };

  stop = () => {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.fpsFrames = 0;
    this.fpsStart = 0;
    reportVisualizerFps(0, false);
  };

  renderFrame = (timestamp) => {
    this.animFrameId = null;
    if (!this.visualizer) return;
    if (!this.fpsStart) this.fpsStart = timestamp;
    this.fpsFrames++;
    const elapsed = timestamp - this.fpsStart;
    if (elapsed >= 500) {
      reportVisualizerFps(this.fpsFrames * 1000 / elapsed, true);
      this.fpsFrames = 0;
      this.fpsStart = timestamp;
    }
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
        {this.state.loading &&
          <div className='MilkDrop-loading-overlay'>Loading MilkDrop…</div>}
        {this.state.error &&
          <div className='MilkDrop-error'>MilkDrop unavailable: {this.state.error}</div>}
      </div>
    );
  }
}
