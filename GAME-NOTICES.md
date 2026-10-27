# Existing Game: BananaBread

This demo streams the existing BananaBread first-person shooter, a web port of
Cube 2 / Sauerbraten. It runs in a separate host process; the user's iframe
receives WebRTC video.

- Upstream: https://github.com/kripken/BananaBread
- Pinned build: `2d72c7f11f7619e6be83833289122b83f21dc494` (gh-pages)
- Engine: zlib license; Sauerbraten and BananaBread authors.
- Artwork: Mozilla Foundation and the original asset authors, CC-BY / CC-BY-SA
  as specified by the individual upstream notices.
- Installer: `npm run game:install`. Downloads are hash-checked against the
  pinned Git tree, with a local SHA-256 manifest and upstream notices retained
  under `vendor/bananabread`. The original engine and asset files are unmodified.

The Repro-specific hosting page, transport, input adapter and fault controls are
separate from upstream game code.
