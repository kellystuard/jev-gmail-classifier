# Changelog

## [0.2.0](https://github.com/kellystuard/jev-gmail-classifier/compare/v0.1.0...v0.2.0) (2026-09-29)


### Features

* **core:** build the exclusion query and its date window ([#216](https://github.com/kellystuard/jev-gmail-classifier/issues/216)) ([c074885](https://github.com/kellystuard/jev-gmail-classifier/commit/c0748857503f332548d351381dbf62ea9183ff18))
* **core:** decide the first-classification flag from the thread's messages ([#220](https://github.com/kellystuard/jev-gmail-classifier/issues/220)) ([0701d25](https://github.com/kellystuard/jev-gmail-classifier/commit/0701d256606fe0693044195e00ab2be91571d21a)), closes [#67](https://github.com/kellystuard/jev-gmail-classifier/issues/67)
* **exclusion:** search a chunk's threads for exclusion matches ([#219](https://github.com/kellystuard/jev-gmail-classifier/issues/219)) ([7bcb628](https://github.com/kellystuard/jev-gmail-classifier/commit/7bcb628f4ac5c326c756f031d774bdfbb1ae5ff0))
* **gmail:** add the Gmail adapter's profile and history listing ([#213](https://github.com/kellystuard/jev-gmail-classifier/issues/213)) ([ee60f4f](https://github.com/kellystuard/jev-gmail-classifier/commit/ee60f4f384473e3a6919cb95e22e14724bda5fb6))
* **gmail:** search threads and read them in every format ([#215](https://github.com/kellystuard/jev-gmail-classifier/issues/215)) ([e562b5f](https://github.com/kellystuard/jev-gmail-classifier/commit/e562b5f8d6cb00bab08675a353f7c520367fd058))
* **ingest:** add the expired-history fallback cursor and window planning ([#222](https://github.com/kellystuard/jev-gmail-classifier/issues/222)) ([1d13795](https://github.com/kellystuard/jev-gmail-classifier/commit/1d1379590462b08c859cecea27b690c57abdff2e))
* **ingest:** catch up after expired history with a resumable fallback ([#226](https://github.com/kellystuard/jev-gmail-classifier/issues/226)) ([abad96f](https://github.com/kellystuard/jev-gmail-classifier/commit/abad96fbbae5a76703355641bdea9c247777c0e6)), closes [#73](https://github.com/kellystuard/jev-gmail-classifier/issues/73)
* **ingest:** ingest messageAdded history into the work queue ([#223](https://github.com/kellystuard/jev-gmail-classifier/issues/223)) ([cfbb7e9](https://github.com/kellystuard/jev-gmail-classifier/commit/cfbb7e94fb654ba845b39abd868e8b2fa3bb48f9)), closes [#63](https://github.com/kellystuard/jev-gmail-classifier/issues/63)
* **ingest:** re-queue a thread when Jev/Error is removed, and add state.jevErrorLabel ([#224](https://github.com/kellystuard/jev-gmail-classifier/issues/224)) ([33e99cf](https://github.com/kellystuard/jev-gmail-classifier/commit/33e99cf84af6d11d8637f511f03a170c0824338f))
* **queue:** add the work queue and its store ([#221](https://github.com/kellystuard/jev-gmail-classifier/issues/221)) ([4ec41a0](https://github.com/kellystuard/jev-gmail-classifier/commit/4ec41a031d24637ebf183874b989a9cb9c59599f))
* **screen:** screen each chunk before anything is read for Jev ([#225](https://github.com/kellystuard/jev-gmail-classifier/issues/225)) ([94e274d](https://github.com/kellystuard/jev-gmail-classifier/commit/94e274d23e8a8f0d7f7ac900eb6c75a85c0801dc))
* **state:** add GasStateAdapter and the shared state rules ([#217](https://github.com/kellystuard/jev-gmail-classifier/issues/217)) ([d669dc7](https://github.com/kellystuard/jev-gmail-classifier/commit/d669dc7e24899f15b6d5845872b6f36e4f5d2a43))
* **state:** add versioned state codecs with migration hooks ([#212](https://github.com/kellystuard/jev-gmail-classifier/issues/212)) ([f206f41](https://github.com/kellystuard/jev-gmail-classifier/commit/f206f4107df62610f0ce7dd3aa76391fec4e9c11))
* **state:** store growing lists in crash-safe shards ([#218](https://github.com/kellystuard/jev-gmail-classifier/issues/218)) ([734561a](https://github.com/kellystuard/jev-gmail-classifier/commit/734561a2d180b5624e3f048203e3fdc2687e8c29)), closes [#210](https://github.com/kellystuard/jev-gmail-classifier/issues/210)

## 0.1.0 (2026-09-28)


### Features

* **config:** validate the embedded config again at load ([#196](https://github.com/kellystuard/jev-gmail-classifier/issues/196)) ([a9c5629](https://github.com/kellystuard/jev-gmail-classifier/commit/a9c56294eca74a9401430e98e4c5c02642eebf13))
