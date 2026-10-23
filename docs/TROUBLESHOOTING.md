# Troubleshooting

## The page says Room not connected

Use **Run SoundMesh.cmd**, which opens the current full host invitation. Opening only `localhost:3210` in a new browser session does not identify you as host. A restarted server has fresh invitations. Phones must use the displayed Wi-Fi join link or QR, not localhost.

## My phone cannot open the room

Connect both devices to the same Wi-Fi. Guest networks, client isolation, mobile data, VPNs, and firewall rules can prevent local connections. If several addresses appear, choose the host's real Wi-Fi address. Allow the runtime on a trusted Private network; do not disable the firewall. No router port forwarding is needed.

## Live sharing has no audio

Use the host invitation through localhost in desktop Chrome or Edge. Start music in another tab in that browser, choose that tab, and enable Share tab audio. Whole-screen/system capture is intentionally excluded. An iPhone receiver webpage is not an arbitrary iPhone-app audio broadcaster. Protected services may restrict capture.

## Buttons seem unavailable

Check the room status and error below This device. Enrollment must succeed before audio enabling or settings updates can work. The app tolerates blocked browser storage, but retain the full invitation when refreshing if storage is unavailable.

## Audio is harsh, crackling, or doubled

Stop playback and lower the device volume. Keep only one enabled SoundMesh page on the laptop. Check whether normal source playback is clean after sharing stops. Refresh all receivers after an update; on a supported localhost laptop, Enable should report Continuous engine ready. Try Stable Wi-Fi to investigate underruns. Also check whether the original tab is playing an immediate copy alongside SoundMesh's delayed copy. Do not increase volume to compensate for distortion.

Waveform/continuity tests do not replace a quiet hardware test. Report device, browser, buffer profile, and whether only the host or all receivers are affected.

## Audio is delayed relative to video

The shared buffer is intentional. Fast reduces buffering but needs steadier Wi-Fi; Stable Wi-Fi trades latency for resilience. Choose a profile before sharing. The system is intended for music, not matching the original video's lip movements.

## The phone stops when the screen locks

Keep the receiver page visible and screen awake. Wake-lock support varies, especially over ordinary HTTP. Battery saving and background-tab policies may suspend audio; tap Enable/Resume again.

## Speakers are slightly out of alignment

Start with two built-in speakers and a click/percussion track. Adjust timing in 5–10 ms steps from one listening position. Positive delay plays later, negative delay earlier. Large negative adjustments may require a larger live buffer. Bluetooth adds another variable output delay.

## The launcher does not stop the room

Use Stop from the same folder that started that managed room. A foreground `npm start` process is stopped with Ctrl+C in its terminal. The launcher does not indiscriminately terminate other Node processes. Logs for the managed room are under `.soundmesh` and may contain private invitations; redact them before sharing.
