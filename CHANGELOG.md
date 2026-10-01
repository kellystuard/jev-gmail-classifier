# Changelog

## [0.9.0](https://github.com/kellystuard/jev-gmail-classifier/compare/v0.8.0...v0.9.0) (2026-10-01)


### Features

* **alerts:** add the alert email formats ([#306](https://github.com/kellystuard/jev-gmail-classifier/issues/306)) ([6934d16](https://github.com/kellystuard/jev-gmail-classifier/commit/6934d1626988234e04dcee5dce68a1a006cef904))
* **alerts:** add the state.alerts codec and the once-a-day rule ([#305](https://github.com/kellystuard/jev-gmail-classifier/issues/305)) ([7be9c46](https://github.com/kellystuard/jev-gmail-classifier/commit/7be9c468553818f42859e8446a736ca86d143448))
* **alerts:** raise run_failures from the heartbeat ([#307](https://github.com/kellystuard/jev-gmail-classifier/issues/307)) ([677e00d](https://github.com/kellystuard/jev-gmail-classifier/commit/677e00d8d80d829355d2a42b11c42f38fc54dbc5))
* **alerts:** send the collected alerts by email, once per condition per day ([#311](https://github.com/kellystuard/jev-gmail-classifier/issues/311)) ([85a49e0](https://github.com/kellystuard/jev-gmail-classifier/commit/85a49e0c7a9312f9fd0a9cb352abd1dc25ae2e04)), closes [#302](https://github.com/kellystuard/jev-gmail-classifier/issues/302)
* **entry:** wire the alert mailer and the mail adapter ([#313](https://github.com/kellystuard/jev-gmail-classifier/issues/313)) ([7617205](https://github.com/kellystuard/jev-gmail-classifier/commit/761720532bc8af05f36bd1b276b14cfc552b9ea0))
* **gas:** add the mail adapter ([#309](https://github.com/kellystuard/jev-gmail-classifier/issues/309)) ([dce309d](https://github.com/kellystuard/jev-gmail-classifier/commit/dce309dfbbbab60fd725448977d1821015856cac))
* **log:** add redact and apply it in the log adapter ([#310](https://github.com/kellystuard/jev-gmail-classifier/issues/310)) ([aa671b7](https://github.com/kellystuard/jev-gmail-classifier/commit/aa671b7cf6f4fdbbe03c809e25d5514f9c961c38))
* **log:** check the event contract against the code and the SD ([#312](https://github.com/kellystuard/jev-gmail-classifier/issues/312)) ([331f711](https://github.com/kellystuard/jev-gmail-classifier/commit/331f711dbe85eee11b762fadd31fd6187e9aa72e))

## [0.8.0](https://github.com/kellystuard/jev-gmail-classifier/compare/v0.7.0...v0.8.0) (2026-10-01)


### Features

* **entry:** wire the manual entry points and the spare-time hook ([#301](https://github.com/kellystuard/jev-gmail-classifier/issues/301)) ([3b30acc](https://github.com/kellystuard/jev-gmail-classifier/commit/3b30accd647dd002ec00f8e30f1b58cdf5ab8d94))
* **gas:** return a rejected search page token as a result ([#294](https://github.com/kellystuard/jev-gmail-classifier/issues/294)) ([48cee6d](https://github.com/kellystuard/jev-gmail-classifier/commit/48cee6d9c996b66f9dc993358b8388febec3ae5e))
* **manual:** add the manual job record and its search cursor ([#292](https://github.com/kellystuard/jev-gmail-classifier/issues/292)) ([11bbb96](https://github.com/kellystuard/jev-gmail-classifier/commit/11bbb969d987c171d9dd330fa1e2260ecd4dcd06))
* **manual:** cancel a manual job and drop its queued work ([#295](https://github.com/kellystuard/jev-gmail-classifier/issues/295)) ([e9e6fb3](https://github.com/kellystuard/jev-gmail-classifier/commit/e9e6fb3d079ce5a48bd0f567f05b7e9d87cf5a71))
* **manual:** count a manual job's chunks and build its report events ([#296](https://github.com/kellystuard/jev-gmail-classifier/issues/296)) ([b391af2](https://github.com/kellystuard/jev-gmail-classifier/commit/b391af2faa60b92b63240a25ec04e1bca6f08c3c))
* **manual:** parse the MANUAL_TIMESPAN grammar ([#293](https://github.com/kellystuard/jev-gmail-classifier/issues/293)) ([9da8dd4](https://github.com/kellystuard/jev-gmail-classifier/commit/9da8dd4321a91336ca3806a6cd6af6275f5a7562))
* **manual:** process manual work in spare time and in editor runs ([#299](https://github.com/kellystuard/jev-gmail-classifier/issues/299)) ([0caff01](https://github.com/kellystuard/jev-gmail-classifier/commit/0caff010b30f6c2d235b1b4acf252cf6c50dcc32))
* **manual:** queue job search pages as manual work items ([#298](https://github.com/kellystuard/jev-gmail-classifier/issues/298)) ([f36101b](https://github.com/kellystuard/jev-gmail-classifier/commit/f36101b981a4f64ead30761c978266ca7f3ef74d)), closes [#135](https://github.com/kellystuard/jev-gmail-classifier/issues/135)
* **manual:** start a manual job from the MANUAL_* inputs ([#297](https://github.com/kellystuard/jev-gmail-classifier/issues/297)) ([f1e3b78](https://github.com/kellystuard/jev-gmail-classifier/commit/f1e3b786519bb8d620588e1123204b862cd4b642))
* **run:** take only scheduled items in the scheduled chunk loop ([#290](https://github.com/kellystuard/jev-gmail-classifier/issues/290)) ([3a02bc9](https://github.com/kellystuard/jev-gmail-classifier/commit/3a02bc92d0fa06d8e71a71269666c1cd2f9e8a26))

## [0.7.0](https://github.com/kellystuard/jev-gmail-classifier/compare/v0.6.0...v0.7.0) (2026-10-01)


### Features

* **entry:** wire onTrigger, install and uninstall ([#284](https://github.com/kellystuard/jev-gmail-classifier/issues/284)) ([341d2db](https://github.com/kellystuard/jev-gmail-classifier/commit/341d2db18211696dc4e11cf42a8bd166c1935768))
* **gas:** add the auth adapter for the scope preflight ([#274](https://github.com/kellystuard/jev-gmail-classifier/issues/274)) ([be4f983](https://github.com/kellystuard/jev-gmail-classifier/commit/be4f983898458dc5e58e0ff38c925c49377af200))
* **gas:** add the script lock adapter ([#281](https://github.com/kellystuard/jev-gmail-classifier/issues/281)) ([e6813a2](https://github.com/kellystuard/jev-gmail-classifier/commit/e6813a2b3bf47f96c6ac5b9a054682d0cb92b47f))
* **gas:** add the ScriptApp trigger adapter ([#282](https://github.com/kellystuard/jev-gmail-classifier/issues/282)) ([d61c7ef](https://github.com/kellystuard/jev-gmail-classifier/commit/d61c7ef463162a20fa228292ef98a934c781e04f))
* **lifecycle:** add the install use case ([#279](https://github.com/kellystuard/jev-gmail-classifier/issues/279)) ([160a267](https://github.com/kellystuard/jev-gmail-classifier/commit/160a267b41af71a339ca0ed31b35fbb58aa35c1d))
* **lifecycle:** add the uninstall use case ([#277](https://github.com/kellystuard/jev-gmail-classifier/issues/277)) ([29760ae](https://github.com/kellystuard/jev-gmail-classifier/commit/29760ae19a84267415dfc7c5882f93385451faf1))
* **run:** add the Deadline ([#269](https://github.com/kellystuard/jev-gmail-classifier/issues/269)) ([6ab00ed](https://github.com/kellystuard/jev-gmail-classifier/commit/6ab00ed561852dcf31b650189bfc5979ad78ae19))
* **run:** add the per-run boundary with lock, deadline and heartbeat ([#276](https://github.com/kellystuard/jev-gmail-classifier/issues/276)) ([70dea4f](https://github.com/kellystuard/jev-gmail-classifier/commit/70dea4fabcac21ffab4d09040a782d5fb399cf94)), closes [#120](https://github.com/kellystuard/jev-gmail-classifier/issues/120)
* **run:** add the run limits per trigger interval ([#271](https://github.com/kellystuard/jev-gmail-classifier/issues/271)) ([e1f3a69](https://github.com/kellystuard/jev-gmail-classifier/commit/e1f3a692ca19db9094ae04d16a4a9ecfdae4f8a5))
* **run:** add the scheduled run controller ([#283](https://github.com/kellystuard/jev-gmail-classifier/issues/283)) ([7250235](https://github.com/kellystuard/jev-gmail-classifier/commit/72502355bd2029e8a0a813d12a745acba2ddaea2)), closes [#118](https://github.com/kellystuard/jev-gmail-classifier/issues/118)
* **run:** add the scope preflight ([#273](https://github.com/kellystuard/jev-gmail-classifier/issues/273)) ([fea7aec](https://github.com/kellystuard/jev-gmail-classifier/commit/fea7aec91e9db41e4020c00d23cd584badf58fd1))
* **run:** count Gmail calls and quota units per run and per day ([#270](https://github.com/kellystuard/jev-gmail-classifier/issues/270)) ([d8cd8bc](https://github.com/kellystuard/jev-gmail-classifier/commit/d8cd8bca4ca982bc716d4a4b38f7c703b00d1349))
* **run:** preflight the run: API key, scopes and budget ([#280](https://github.com/kellystuard/jev-gmail-classifier/issues/280)) ([ddc7b3c](https://github.com/kellystuard/jev-gmail-classifier/commit/ddc7b3c92831faa20ace9a92fc7f4f0e319cec68))
* **run:** process one chunk from screening to saving the queue ([#275](https://github.com/kellystuard/jev-gmail-classifier/issues/275)) ([c780a29](https://github.com/kellystuard/jev-gmail-classifier/commit/c780a29b8984f7071e146d3c1b84bd467ba4ed46))

## [0.6.0](https://github.com/kellystuard/jev-gmail-classifier/compare/v0.5.0...v0.6.0) (2026-09-30)


### Features

* **outcomes:** settle each thread behind the per-thread error boundary ([#261](https://github.com/kellystuard/jev-gmail-classifier/issues/261)) ([444321e](https://github.com/kellystuard/jev-gmail-classifier/commit/444321ef03f0c836cd63ea3fc88d88587548ca17))

## [0.5.0](https://github.com/kellystuard/jev-gmail-classifier/compare/v0.4.0...v0.5.0) (2026-09-30)


### Features

* **gmail:** implement the label and move methods with their error mapping ([#256](https://github.com/kellystuard/jev-gmail-classifier/issues/256)) ([7e6eae5](https://github.com/kellystuard/jev-gmail-classifier/commit/7e6eae522fd2c5874d774ecd1926f41b0229e392))
* **outcomes:** add strikes and the Jev/Error outcome ([#260](https://github.com/kellystuard/jev-gmail-classifier/issues/260)) ([94e55a0](https://github.com/kellystuard/jev-gmail-classifier/commit/94e55a0e81e189c05b5d7009bcb91370c1a2a608))
* **outcomes:** apply labels and moves in one threads.modify ([#257](https://github.com/kellystuard/jev-gmail-classifier/issues/257)) ([994ab87](https://github.com/kellystuard/jev-gmail-classifier/commit/994ab87b0b12b509fb5bbea5ac712e89931bc926))
* **outcomes:** skip only the move when a scope is missing ([#259](https://github.com/kellystuard/jev-gmail-classifier/issues/259)) ([6f6ba0e](https://github.com/kellystuard/jev-gmail-classifier/commit/6f6ba0e2a9295ab8ea18758c332fd5f508a872c6))

## [0.4.0](https://github.com/kellystuard/jev-gmail-classifier/compare/v0.3.0...v0.4.0) (2026-09-30)


### Features

* **budget:** add the daily token budget codec and day rollover ([#244](https://github.com/kellystuard/jev-gmail-classifier/issues/244)) ([d2bccc7](https://github.com/kellystuard/jev-gmail-classifier/commit/d2bccc72344ccd7d57545f39fc83369529d7cd9b))
* **budget:** persist the daily token budget and stop sending when it's reached ([#249](https://github.com/kellystuard/jev-gmail-classifier/issues/249)) ([834d2b0](https://github.com/kellystuard/jev-gmail-classifier/commit/834d2b09ef3c4be8a9f64842223cd17043dfe046))
* **jev-client:** add retryDelay and parseRetryAfter ([#243](https://github.com/kellystuard/jev-gmail-classifier/issues/243)) ([1ed205e](https://github.com/kellystuard/jev-gmail-classifier/commit/1ed205ea6d5453c6c840d1e130e357b0bf432d18))
* **jev-client:** add the fetchAll HTTP adapter and the secrets adapter ([#246](https://github.com/kellystuard/jev-gmail-classifier/issues/246)) ([a95b2bc](https://github.com/kellystuard/jev-gmail-classifier/commit/a95b2bc845139492cb07fc7e2bffd8e908473567))
* **jev-client:** build the Jev request body from the rules and state ([#239](https://github.com/kellystuard/jev-gmail-classifier/issues/239)) ([1dd6db4](https://github.com/kellystuard/jev-gmail-classifier/commit/1dd6db45b6f2f2271b002cb073195a34a6b1703e))
* **jev-client:** classify Jev responses by status ([#240](https://github.com/kellystuard/jev-gmail-classifier/issues/240)) ([979c025](https://github.com/kellystuard/jev-gmail-classifier/commit/979c025c50c8159c51b73134f223dea7abe987f0))
* **jev-client:** interpret Jev responses into JevResult ([#245](https://github.com/kellystuard/jev-gmail-classifier/issues/245)) ([2082183](https://github.com/kellystuard/jev-gmail-classifier/commit/2082183c6ffc5982daec425ccb000fc29dc9f51b))
* **jev-client:** send Jev requests in batches and retry in rounds ([#247](https://github.com/kellystuard/jev-gmail-classifier/issues/247)) ([4323e2d](https://github.com/kellystuard/jev-gmail-classifier/commit/4323e2d4115704384268522604f121290cb2ae24))
* **outcomes:** cache label IDs and create missing labels ([#254](https://github.com/kellystuard/jev-gmail-classifier/issues/254)) ([8d21deb](https://github.com/kellystuard/jev-gmail-classifier/commit/8d21debc0417144886f69d7ba75fb5c297bd5357))
* **outcomes:** decide labels and at most one move ([#255](https://github.com/kellystuard/jev-gmail-classifier/issues/255)) ([0b9a2ec](https://github.com/kellystuard/jev-gmail-classifier/commit/0b9a2ec93f0d005ce2627d8202a6ff10add50ede))
* **probe:** probe Jev locally with saved .eml files ([#248](https://github.com/kellystuard/jev-gmail-classifier/issues/248)) ([867f476](https://github.com/kellystuard/jev-gmail-classifier/commit/867f476fcf979bac633aab3ec1f16b45f7167bf0))

## [0.3.0](https://github.com/kellystuard/jev-gmail-classifier/compare/v0.2.0...v0.3.0) (2026-09-30)


### Features

* **body:** add the basic HTML-to-text converter and BodyConverter ([#234](https://github.com/kellystuard/jev-gmail-classifier/issues/234)) ([f8088f0](https://github.com/kellystuard/jev-gmail-classifier/commit/f8088f089c9c7385dcd61ab31f2eec379f442127))
* **body:** choose and normalize each message's body text in a MIME walk ([#236](https://github.com/kellystuard/jev-gmail-classifier/issues/236)) ([3855d5c](https://github.com/kellystuard/jev-gmail-classifier/commit/3855d5c020528deed3c3effdb588f0cc40b111ed))
* **body:** decode part data as UTF-8 through an injected decoder ([#231](https://github.com/kellystuard/jev-gmail-classifier/issues/231)) ([6672e00](https://github.com/kellystuard/jev-gmail-classifier/commit/6672e00995124fe8bf5dd88c7283f47d592c60f0))
* **body:** exclude attachments and forwarded messages from the body walk ([#232](https://github.com/kellystuard/jev-gmail-classifier/issues/232)) ([eab0786](https://github.com/kellystuard/jev-gmail-classifier/commit/eab0786a0f7da356819b7b134d590b77cdd12ad3))
* **state:** build state from a thread with the header allowlist ([#237](https://github.com/kellystuard/jev-gmail-classifier/issues/237)) ([798b698](https://github.com/kellystuard/jev-gmail-classifier/commit/798b698576d89a2589c31732611aa10f3b24e815))
* **state:** fit state to Jev's token limits and add threadToState ([#238](https://github.com/kellystuard/jev-gmail-classifier/issues/238)) ([f4e1e2b](https://github.com/kellystuard/jev-gmail-classifier/commit/f4e1e2b4ce37b74c9cbbc0e08090adde73179508))

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
