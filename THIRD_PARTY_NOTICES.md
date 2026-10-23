# Third-party notices

## QR Code Generator for JavaScript

- Project: https://github.com/kazuhikoarase/qrcode-generator
- Version: 2.0.4
- Copyright: Kazuhiko Arase
- MIT license: `public/vendor/LICENSE-qrcode-generator.txt`.
- The vendored module generates invitations locally.

## Node.js

- Project: https://nodejs.org/
- Portable runtime: 24.19.0, Windows x64.
- Portable packages include the unmodified executable and its official full license at `.runtime/LICENSE.txt`.
- Runtime binaries are excluded from the source repository.

## Development dependencies

`jsqr` 1.4.0 (Apache-2.0) decodes QR images during testing. `qrcode-generator` 2.0.4 (MIT) is retained for updates to the vendored module. Development dependencies are not bundled into the portable runtime.
