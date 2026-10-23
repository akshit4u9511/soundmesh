# Architecture

## Components

`server.mjs` is a dependency-free Node HTTP server. It serves the interface, estimates room time, distributes settings through Server-Sent Events, holds optional uploaded audio in RAM, and relays live PCM packets.

`public/app.js` manages browser enrollment, user-gesture audio enabling, source capture, playback, and controls. The application uses no external font, analytics, or QR generation service.

## Live audio path

1. The host selects a browser tab through the desktop sharing picker.
2. `capture-worklet.js` packs stereo float samples into small consecutive chunks.
3. Authenticated HTTP uploads carry frame positions and PCM to the server.
4. `lib/live.mjs` validates ordering and finite samples, then timestamps chunks against one shared timeline.
5. Server-Sent Events deliver audio to participants.
6. Localhost playback uses `playback-worklet.js`: a continuous buffer and persistent interpolation across packet boundaries. Ordinary HTTP receivers without AudioWorklet use the scheduled-buffer compatibility path.

The shared buffer is 350, 700, or 1,400 ms. Capture, transport, and physical-output latency add to it. The receiver timeline keeps blocks adjacent and adjusts rate by at most 0.1% for small drift. Late audio is discarded/rebuffered rather than accumulating unlimited lag. Buffer, queue, upload, and participant limits constrain memory growth.

Clock offset is estimated from seven requests using the fastest three samples and refreshed periodically. Output timestamps are used when available. These are software estimates; sound arrival also depends on hardware and speaker distance.

## File playback

An uploaded file is retained in memory. Each enabled receiver downloads and decodes it before host playback is permitted. Play and seek are scheduled ahead; pause is sent immediately. File size is capped at 80 MB, but decoded audio can use substantially more memory.

## Audio processing

```text
source → device gain / channel role → headroom gain
       → low shelf (200 Hz) → peaking mid (1 kHz) → high shelf (4 kHz)
       → dynamics compressor → hardware output
```

EQ gains are limited to ±6 dB. Positive boosts reserve pre-filter headroom. Parameter changes are smoothed. The compressor reduces peaks but cannot guarantee the absence of all distortion or hardware issues.

## Roles and access

The laptop host is administrator and broadcaster in this version. Other devices are receiver browsers. Separate random host and join capabilities enforce access. A device receives its own secret for settings updates; the host can adjust other devices. Whole-room EQ is host-only and becomes the default for new joins.

The server uses local HTTP, not TLS. It should remain on a trusted network. There is no microphone capture, cloud audio storage, or account integration.

## Windows lifecycle

`launcher.ps1` uses a per-folder mutex, a bundled or installed runtime, and an available port. The managed server writes current invitation/process metadata under `.soundmesh`. Before reusing or stopping an instance, the launcher checks its path, process, and authenticated server identity. Browser opening uses the current full host invitation. Stop is a local authenticated shutdown request.

The portable build uses an explicit allowlist, excluding sessions, logs, recordings, and development dependencies. Runtime binaries and third-party notices are included in the ZIP, not tracked in the source repository.
