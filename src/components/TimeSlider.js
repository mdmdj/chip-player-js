import React from 'react';
import Slider from "./Slider";
import autoBindReact from 'auto-bind/react';

//  46 ms = 2048/44100 sec or 21.7 fps
// 400 ms = 2.5 fps
const UPDATE_INTERVAL_MS = 100;
const pad = (n) => n < 10 ? '0' + n : n;

export default class TimeSlider extends React.Component {
  constructor(props) {
    super(props);
    autoBindReact(this);

    this.state = {
      draggedSongPositionMs: -1,
      currentSongPositionMs: 0,
      isBlindLoop: false,
    };
    this.timer = null;
  }

  componentDidUpdate(prevProps) {
    if (prevProps.paused === true && this.props.paused === false) {
      this.timer = setInterval(() => {
        const {getCurrentPositionMs, getIsBlindLoop, currentSongDurationMs} = this.props;
        const blind = typeof getIsBlindLoop === 'function' ? getIsBlindLoop() : !!getIsBlindLoop;
        const pos = getCurrentPositionMs();
        this.setState({
          currentSongPositionMs: blind ? pos : Math.min(pos, currentSongDurationMs),
          isBlindLoop: blind,
        });
      }, UPDATE_INTERVAL_MS);
    } else if (prevProps.paused === false && this.props.paused === true) {
      clearInterval(this.timer);
    }
  }

  componentWillUnmount() {
    clearInterval(this.timer);
  }

  getSongPos() {
    // Blind loop rides the first pass, then parks at the end: with no known
    // loop point, wrapping to 0 would imply an intro/loop shape we can't
    // know, so the head just stops. The elapsed label keeps climbing.
    if (this.state.isBlindLoop) {
      return Math.min(this.state.currentSongPositionMs / this.props.currentSongDurationMs, 1);
    }
    return this.state.currentSongPositionMs / this.props.currentSongDurationMs;
  }

  getTimeLabel() {
    const val = this.state.draggedSongPositionMs >= 0 ?
      this.state.draggedSongPositionMs :
      this.state.currentSongPositionMs;
    return this.getTime(val);
  }

  getTime(ms) {
    const sign = ms < 0 ? '-' : '';
    ms = Math.abs(ms);
    const min = Math.floor(ms / 60000);
    const sec = (Math.floor((ms % 60000) / 100) / 10).toFixed(1);
    return `${sign}${min}:${pad(sec)}`;
  }

  handlePositionDrag(event) {
    const pos = event.target ? event.target.value : event;
    // Update current time position label
    this.setState({
      draggedSongPositionMs: pos * this.props.currentSongDurationMs,
    });
  }

  handlePositionDrop(event) {
    this.setState({
      draggedSongPositionMs: -1,
      currentSongPositionMs: this.state.draggedSongPositionMs,
    });
    this.props.onChange(event);
  }

  render() {
    return (
      <div className='TimeSlider'>
        <Slider
          pos={this.getSongPos()}
          loopStart={this.props.loopStart}
          loopEnd={this.props.loopEnd}
          onDrag={this.handlePositionDrag}
          onChange={this.handlePositionDrop}/>
        <div className='TimeSlider-labels'>
          <div>{this.getTimeLabel()}</div>
          <div>{this.state.isBlindLoop
            ? <><span className='inline-icon icon-repeat'/> Looping</>
            : this.getTime(this.props.currentSongDurationMs)}</div>
        </div>
      </div>
    );
  }
}
