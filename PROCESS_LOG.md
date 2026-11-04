## Nov 2, 2026 · 12:25 pm

- I recorded 27 everyday objects to build a playable piano.
- Cropped each video to its center square and found note onsets.
- Measured each hit's pitch with FFT and autocorrelation.
- Mapped 127 extracted object slices across the piano keyboard.

## Nov 2, 2026 · 1:48 pm

- I imported 81 more object recordings from around the house.
- Routed logs, clock ticks, lamp switches, and puffballs to drums.
- Tuned onset detection to ignore thumb thumps before strikes.
- Solved a 1-to-1 keyboard map with zero duplicate samples.

## Nov 2, 2026 · 2:15 pm

- Relabeled the metal bird feeder clips and moved them to percussion.
- Imported a music box clip and isolated 10 pure single-tine notes.
- Filtered out all multi-note chords using spectral peak prominence.
- Re-solved the 1-to-1 keyboard map to cover 62 of 68 keys.

## Nov 2, 2026 · 2:44 pm

- Redesigned the app around an equal-width keyline keyboard at the bottom.
- Simplified mapping so each clip moment goes only to its nearest note.
- Mined 87 extra moments from rubberband bowls, flute, and chimes.
- Added persistent per-key candidate decks and ping pong percussion.


## Nov 2, 2026 · 3:21 pm

- Restored the live spectrogram and fundamental pitch line on the top stage.
- Expanded the stage to display full uncropped 1:1 square clips side-by-side.
- Compressed the per-key candidate deck into a slim horizontal strip.
- Tied clip sustain to key hold with a 0.65s release fade and synced video stop.

## Nov 2, 2026 · 3:50 pm

- Locked the stage to 3 fixed-size 1:1 square slots with left-to-right voice stealing.
- Kept active square clips at 100% opacity until decay finishes, then cleared instantly.
- Rendered the spectrogram at fixed 1:1 HiDPI resolution with zero stretching.
- Imported 9 new clips including 13 marimba bars, whistles, toy piano, and steady bird notes.

## Nov 2, 2026 · 4:06 pm

- Stripped all stage headers, clip text labels, and borders for a pure black stage.
- Added visual-only mini spectrogram playhead strips beneath each of the 3 clip slots.
- Kept the detailed latest-note spectrogram inspector docked separately on the right.


## Nov 2, 2026 · 4:48 pm

- Made the mini spectrogram strips taller under each square.

- Played square clips above taller mini spectrogram strips. [img](screenshots/2026-11-02/01_three-slot-stage-and-spectrograms.png)

- Replaced the library inspector with a single-clip trim modal.
- Added draggable In and Out bars with live frame scrubbing.

- Built a single-clip trim modal with draggable In and Out. [img](screenshots/2026-11-02/02_trim-clip-in-out-modal.png)


## Nov 2, 2026 · 8:09 pm

- Removed the top-left title, batch flags, and side inspector.
- Unveiled each mini spectrogram left to right as clips play.

- Centered three square clips above unveiling spectrograms. [img](screenshots/2026-11-02/03_centered-three-slot-stage-unveil.png)

- Combined deeper harmonics and In/Out handles in one overlay.

- Inspected harmonics and In/Out handles in one overlay. [img](screenshots/2026-11-02/04_universal-clip-inspector-overlay.png)


## Nov 2, 2026 · 9:20 pm

- Removed the Library and Drums drawers to cut UI bloat.
- Switched candidates to ON/OFF toggles with random play.
- Shrank the bottom keyboard to slim note-name bars.

- Enabled two G4 clips above slim note-name key bars. [img](screenshots/2026-11-02/05_minimal-note-bars-and-on-off-candidates.png)

- Added a low C1–B1 percussion octave below C2 tonal keys.

- Triggered puffball kicks and wood log on the C1 octave. [img](screenshots/2026-11-02/06_low-percussion-octave-puffball-kicks.png)


## Nov 3, 2026 · 6:30 pm

- Replaced note-name bars with a minimal chromatic circle row.
- Enlarged active circles 2x on hit with screen blend mode.
- Swapped unveil spectrograms for instant-pop f0 stripe graphs.

- Played three clips over f0 stripes and chromatic dots. [img](screenshots/2026-11-03/07_pure-chromatic-dots-and-f0-spectrograms.png)

- Moved sample thumbnails and MIDI transport into a bottom bar.

- Expanded the bottom sample strip and MIDI transport bar. [img](screenshots/2026-11-03/08_collapsible-bottom-drawer-and-midi-transport.png)


## Nov 3, 2026 · 10:45 pm

- Imported 12 more object clips to reach 439 active moments.
- Packed all 439 start frames into a dim WebGL background grid.
- Grouped grid thumbnails by source video above the dot strip.

- Floated a dim monochrome WebGL grid above the dot row. [img](screenshots/2026-11-03/09_floating-webgl-mosaic-idle.png)

- Added click-and-drag strumming and color highlights on play.

- Lit the active melodica cell beside its 95% stage video. [img](screenshots/2026-11-03/10_webgl-mosaic-playing-and-overlay.png)


## Nov 4, 2026 · 2:15 pm

- Exported a 96 MB static v1 instrument build to GitHub Pages.
- Sketched a next-step layout with 3D canvas and file explorer. [img](screenshots/2026-11-04/everytone-ux-overhaul-sketch.jpg)


## Nov 4, 2026 · 4:29 pm

- Rebuilt the stage on Three.js and removed the rainbow dot row.
- Added a collapsible video file explorer with persistent mute switches.
- Docked MIDI scrub transport, sample toggles, and a keyline keyboard. [img](screenshots/2026-11-04/11_music-software-layout-idle.png)

- Made connected black keys equal width and lit hits in 12 note colors. [img](screenshots/2026-11-04/12_explorer-mute-and-keyline-polyphony.png)


## Nov 4, 2026 · 5:12 pm

- Switched to Space Mono on solid black panels with grey keylines.
- Added one top-left menu toggle for sidebar and bottom transport.
- Placed chromatic note dots on every tile in the 3D grid. [img](screenshots/2026-11-04/13_space-mono-solid-black-and-grid-note-dots.png)

- Cropped low rumble and floated screen-blended gray spectrograms.
- Added a 0.2s visual fade-out when releasing foreground stage clips. [img](screenshots/2026-11-04/14_floating-gray-screen-spectrograms-and-winds.png)

- Built a video file inspector with holistic integer dB volume trim. [img](screenshots/2026-11-04/15_video-file-inspector-holistic-volume.png)

- Linked video and sample inspectors by breadcrumb and capped pitch to ±1st. [img](screenshots/2026-11-04/16_sample-inspector-breadcrumb-and-1st-clamp.png)
