# Building a Windows portable release

Use a Windows x64 machine and Node.js. The runtime version is pinned in `.node-version`.

1. Run `npm ci`, `npm run check`, and `npm test`.
2. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-runtime.ps1` to download the official runtime, validate its SHA-256 against the official checksum list, and retain the full license.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1`.
4. Run `powershell -NoProfile -ExecutionPolicy Bypass -File test/portable-smoke.ps1` to test a fresh extraction without Node on PATH.

The build produces `release/SoundMesh-Windows-x64/` and its ZIP. It refuses to mix files into an existing package directory; use a fresh checkout or a new `-OutputName` for another build. The smoke test uses the default package name.

The packaged `SHA256SUMS.txt` covers included files. Generate a separate checksum for the finished ZIP when attaching it to a release. Publish the ZIP, not a live `.soundmesh` directory. New copies generate their own invitations.

The release workflow builds on Windows for version tags and manual runs. Manual runs retain a downloadable workflow artifact; version tags also create a GitHub Release. Review the test results and release notes before sharing a distribution.
