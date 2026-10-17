import MIDIEvents from './MIDIEvents';

const {
  EVENT_MIDI, EVENT_SYSEX, EVENT_DIVSYSEX,
  EVENT_MIDI_NOTE_ON, EVENT_MIDI_NOTE_OFF,
  EVENT_MIDI_CONTROLLER, EVENT_MIDI_PROGRAM_CHANGE, EVENT_MIDI_PITCH_BEND,
  EVENT_MIDI_CHANNEL_AFTERTOUCH, EVENT_MIDI_NOTE_AFTERTOUCH,
} = MIDIEvents;

const CC_SUSTAIN = 64;
const CC_ALL_SOUNDS_OFF = 120;
const CC_ALL_NOTES_OFF = 123;

/**
 * The end of a MIDI song, derived from its events in independent layers.
 *
 * A MIDI file declares no length. The only "end" it carries is its last event,
 * and that is exactly what a converter pads -- `END_OF_TRACK` a whole loop past
 * the music (Gyrocopter), or a tail of note-offs for notes that are not sounding
 * (`Voyage`). So the end has to be derived from what can be AUDIBLE, and that
 * derivation is a set of independent conditions, one per event class, so a caller
 * can enable exactly the ones it wants and measure the difference:
 *
 *   state layers      change WHAT IS SOUNDING (a state walk over the list)
 *     note            a note-on starts sound, a note-off ends it
 *     sustain         CC64 holds a released note (its hold ends at CC64 < 64)
 *     panic           CC120/CC123 (all sounds/notes off) ends it immediately
 *
 *   trailing layers   cannot hold a note at all; enabling one only extends the
 *                     end to its last event. They exist to measure what
 *                     over-including costs -- and `meta` alone reproduces the
 *                     "last event wins" behaviour the unpatched merge had.
 *     controller, program, bend, aftertouch, sysex, meta
 *
 * The default is the standard we trust: notes, the pedal, and all-sounds-off.
 * Nothing here knows a file path, an engine, or a setting -- see `endLayersFor`
 * for the policy, which is the one place that decides who gets which layers.
 */
export const END_LAYERS = {
  note: true,
  sustain: true,
  panic: true,
  controller: false,
  program: false,
  bend: false,
  aftertouch: false,
  sysex: false,
  meta: false,
};

/**
 * The policy: which layers apply here. Returning `null` means "leave the event
 * list exactly as the merge built it" (master's behaviour).
 *
 * This is deliberately the only place a caller's conditions are read, so the
 * settings can key off whatever the caller has. `input.useTrackLoops` is the
 * SoundFont-MIDI gate `MIDIFilePlayer` already passes; a path, a user setting or
 * another data-flow flag would go here the same way. Today: the standard layers,
 * everywhere, to measure the effect on every file before narrowing it.
 */
export function endLayersFor(input = {}) {
  void input.useTrackLoops;
  return { ...END_LAYERS };
}

/**
 * The last moment anything can be audible in `events`, in ms. 0 when the enabled
 * layers never find one (the caller then leaves the list alone).
 */
export function songEndMs(events, layers = END_LAYERS) {
  let endMs = 0;
  if (!layers || (!layers.note && !layers.sustain && !layers.panic &&
      !layers.controller && !layers.program && !layers.bend &&
      !layers.aftertouch && !layers.sysex && !layers.meta)) {
    return 0;
  }

  // Sounding state, for the state layers. `pedalHeld` is a note whose note-off
  // already ran while the pedal was down: it sounds until the pedal lifts.
  const sounding = new Set();
  const pedalHeld = new Set();
  const pedal = new Map();
  const held = () => layers.note && (sounding.size + pedalHeld.size) > 0;
  const channelOf = (key) => Number(key.split('-')[0]);

  for (const e of events) {
    if (e.type !== EVENT_MIDI) {
      if (layers.sysex && (e.type === EVENT_SYSEX || e.type === EVENT_DIVSYSEX)) {
        endMs = Math.max(endMs, e.playTime);
      } else if (layers.meta && e.type !== EVENT_SYSEX && e.type !== EVENT_DIVSYSEX) {
        endMs = Math.max(endMs, e.playTime);
      }
      continue;
    }

    const key = `${e.channel}-${e.param1}`;
    // An event is part of the audible stretch if something was sounding when it
    // arrived OR is sounding after it. The first half is what credits a release:
    // a note-off (or the pedal lift that ends a held chord) IS the end.
    const wasHeld = held();
    switch (e.subtype) {
      case EVENT_MIDI_NOTE_ON:
        if (e.param2 > 0) {
          sounding.add(key);
          pedalHeld.delete(key);
        } else {
          endNote(e, key);
        }
        break;
      case EVENT_MIDI_NOTE_OFF:
        endNote(e, key);
        break;
      case EVENT_MIDI_CONTROLLER:
        if (e.param1 === CC_SUSTAIN && layers.sustain) {
          if (e.param2 < 64) clearHeld(e.channel);
          pedal.set(e.channel, e.param2);
        } else if ((e.param1 === CC_ALL_SOUNDS_OFF || e.param1 === CC_ALL_NOTES_OFF) && layers.panic) {
          clearHeld(e.channel);
          for (const k of [...sounding]) if (channelOf(k) === e.channel) sounding.delete(k);
          pedal.set(e.channel, 0);
        } else if (layers.controller) {
          endMs = Math.max(endMs, e.playTime);
        }
        break;
      case EVENT_MIDI_PROGRAM_CHANGE:
        if (layers.program) endMs = Math.max(endMs, e.playTime);
        break;
      case EVENT_MIDI_PITCH_BEND:
        if (layers.bend) endMs = Math.max(endMs, e.playTime);
        break;
      case EVENT_MIDI_CHANNEL_AFTERTOUCH:
      case EVENT_MIDI_NOTE_AFTERTOUCH:
        if (layers.aftertouch) endMs = Math.max(endMs, e.playTime);
        break;
      default:
    }

    if (wasHeld || held()) endMs = Math.max(endMs, e.playTime);
  }

  // A note-off that finds the pedal down hands the note to `pedalHeld`: it stops
  // being held down but keeps sounding, and only the pedal lift (or a panic)
  // ends it. Leaving it in `sounding` too would keep it "sounding" after the
  // lift, so the note must move, not be copied.
  function endNote(e, key) {
    sounding.delete(key);
    if (layers.sustain && (pedal.get(e.channel) || 0) >= 64) pedalHeld.add(key);
  }
  function clearHeld(channel) {
    for (const k of [...pedalHeld]) if (channelOf(k) === channel) pedalHeld.delete(k);
  }

  return endMs;
}
