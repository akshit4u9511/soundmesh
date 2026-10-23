# Contributing

Bug reports, compatibility findings, and focused improvements are welcome.

## Local checks

Use Node.js 20 or newer:

```sh
npm ci
npm run check
npm test
```

Start a foreground server with `npm start`. Its host and join invitations are private. Test playback at low volume; transport tests alone do not establish acoustic synchronization.

## Bug reports

Include device, OS, browser version, live/file mode, buffer profile, and whether the issue affects the broadcaster, receivers, or both. Mention whether normal playback is clean when sharing stops. Remove current room invitations, QR codes, and private tabs from screenshots.

## Pull requests

Explain the user-visible problem, resulting behavior, and relevant validation. Timing/resampling changes should include waveform or continuity tests. Exercise launcher changes on Windows with paths containing spaces. Preserve HTTP receiver compatibility and third-party notices.

Do not commit credentials, logs, copyrighted music, `.soundmesh`, `.runtime`, `release`, or `node_modules`. Report vulnerabilities through [SECURITY.md](SECURITY.md).
