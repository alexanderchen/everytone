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

- Played square clips above taller mini spectrogram strips. [img](screenshots/01_three-slot-stage-and-spectrograms.png)

- Replaced the library inspector with a single-clip trim modal.
- Added draggable In and Out bars with live frame scrubbing.

- Built a single-clip trim modal with draggable In and Out. [img](screenshots/02_trim-clip-in-out-modal.png)
