# Changelog

## [0.5.0](https://github.com/nownabe/bark/compare/bark-v0.4.0...bark-v0.5.0) (2026-09-24)


### Features

* **dev:** add local preview server with a fixture PR ([#360](https://github.com/nownabe/bark/issues/360)) ([6878f39](https://github.com/nownabe/bark/commit/6878f391af2a69d72a94279244425fc6574708ee))
* **review:** add Mermaid diagram navigation and expanded view ([#356](https://github.com/nownabe/bark/issues/356)) ([5e14f52](https://github.com/nownabe/bark/commit/5e14f5216ba2fbd0477f5711817fb837b3eae8d5))
* **review:** restyle Preview for reading, not editing ([#358](https://github.com/nownabe/bark/issues/358)) ([fa0ab59](https://github.com/nownabe/bark/commit/fa0ab5956b2839d927d0ea1ecad384bc8371efb7))
* **review:** restyle sidebar text for reading, not editing ([#359](https://github.com/nownabe/bark/issues/359)) ([79650eb](https://github.com/nownabe/bark/commit/79650eb2c161b30047d948acbf74c15db2e8186f))


### Bug Fixes

* **review:** keep strikethrough visible inside a Preview heading ([#361](https://github.com/nownabe/bark/issues/361)) ([5abe8b8](https://github.com/nownabe/bark/commit/5abe8b83e53e1de33f615f1d604fd0c67a9ac700))
* **review:** render a table inside a blockquote correctly ([#366](https://github.com/nownabe/bark/issues/366)) ([be6378d](https://github.com/nownabe/bark/commit/be6378dad6b23b1fdeb2b7cad88facab6c3f7265))
* **review:** render inline Markdown inside Preview table cells ([#365](https://github.com/nownabe/bark/issues/365)) ([af85de4](https://github.com/nownabe/bark/commit/af85de4ee450da6bc6f34b3b937d8f58f9479129))
* **review:** stop margins on table/mermaid widgets from skewing click position ([#364](https://github.com/nownabe/bark/issues/364)) ([ea4b86f](https://github.com/nownabe/bark/commit/ea4b86fead9ea32a2e4b3b70ff3f5b460be5e5cf))

## [0.4.0](https://github.com/nownabe/bark/compare/bark-v0.3.0...bark-v0.4.0) (2026-09-20)


### Features

* **pr:** accept .markdown and .mdx as Markdown ([#322](https://github.com/nownabe/bark/issues/322)) ([e22ee68](https://github.com/nownabe/bark/commit/e22ee683a3d218f5fe1ff483a4c1b5cc69df5dfe)), closes [#293](https://github.com/nownabe/bark/issues/293)
* **pr:** commit fork pull requests to the fork's repository ([#342](https://github.com/nownabe/bark/issues/342)) ([4e2adef](https://github.com/nownabe/bark/commit/4e2adef2a26b408bfacbbb153684e0eb05a7c344)), closes [#273](https://github.com/nownabe/bark/issues/273)
* **pr:** create a top-level draft Comment's Thread with it ([#323](https://github.com/nownabe/bark/issues/323)) ([6e192f3](https://github.com/nownabe/bark/commit/6e192f38b9bb2156d9c707b4c336359c8aa1e319)), closes [#272](https://github.com/nownabe/bark/issues/272)
* **pr:** resolve out-of-diff threads via the root comment fence ([#310](https://github.com/nownabe/bark/issues/310)) ([7e0ecb9](https://github.com/nownabe/bark/commit/7e0ecb94510b217d470d50630d706eef89465e3a)), closes [#270](https://github.com/nownabe/bark/issues/270)
* **reanchor:** bounded region search for single-line anchors and line-local suggestion merge ([#309](https://github.com/nownabe/bark/issues/309)) ([0f735da](https://github.com/nownabe/bark/commit/0f735dab98d44ca338a4f3ed18990f9a5a022cc3)), closes [#269](https://github.com/nownabe/bark/issues/269)
* **reanchor:** locate multi-line anchors per endpoint in the region search ([#347](https://github.com/nownabe/bark/issues/347)) ([f4fd457](https://github.com/nownabe/bark/commit/f4fd457056302a1dab7c4552669b0603c3e0e812)), closes [#311](https://github.com/nownabe/bark/issues/311)
* **review:** preview the merge for shifted suggestions in the editor ([#354](https://github.com/nownabe/bark/issues/354)) ([f822f41](https://github.com/nownabe/bark/commit/f822f411aff7a3b56cde8edd6b59b85b8d595fc1)), closes [#312](https://github.com/nownabe/bark/issues/312)


### Bug Fixes

* **anchor:** define anchor.quote as the source text at anchor.range ([#327](https://github.com/nownabe/bark/issues/327)) ([11a935d](https://github.com/nownabe/bark/commit/11a935d4da1e77968783155c9accd9d8c8a7a927)), closes [#276](https://github.com/nownabe/bark/issues/276)
* **background:** focus an existing review tab instead of opening a second one ([#325](https://github.com/nownabe/bark/issues/325)) ([58efa63](https://github.com/nownabe/bark/commit/58efa6386ab38054ac7beb671401db08018c4d68)), closes [#277](https://github.com/nownabe/bark/issues/277)
* **pr:** compose the quote and permalink for every out-of-diff post ([#351](https://github.com/nownabe/bark/issues/351)) ([f85b99b](https://github.com/nownabe/bark/commit/f85b99b0194876d82041202586a68dd583931fff)), closes [#282](https://github.com/nownabe/bark/issues/282)
* **pr:** count patch lines starting with ++ or -- in parseRightRanges ([#314](https://github.com/nownabe/bark/issues/314)) ([9dfbd46](https://github.com/nownabe/bark/commit/9dfbd46f9bd1441ce50f8bef9c52ff06df442c90)), closes [#284](https://github.com/nownabe/bark/issues/284)
* **pr:** keep the rel=next link in the ETag cache so 304 pages still paginate ([#318](https://github.com/nownabe/bark/issues/318)) ([6472de2](https://github.com/nownabe/bark/commit/6472de24a689b78fde65a439ca3b64f800cfab1d)), closes [#286](https://github.com/nownabe/bark/issues/286)
* **pr:** offer Resolve only when GitHub would accept it ([#335](https://github.com/nownabe/bark/issues/335)) ([b05fdcc](https://github.com/nownabe/bark/commit/b05fdcc612b34c9009b607f2e06b419d445e771f)), closes [#274](https://github.com/nownabe/bark/issues/274)
* **pr:** park a failed resolve toggle in synced, not draft ([#320](https://github.com/nownabe/bark/issues/320)) ([56e815b](https://github.com/nownabe/bark/commit/56e815b91d643fc25147e427475818493416a460)), closes [#275](https://github.com/nownabe/bark/issues/275)
* **pr:** post drafts in the current head's coordinates ([#303](https://github.com/nownabe/bark/issues/303)) ([28ef345](https://github.com/nownabe/bark/commit/28ef3454d6d68946c9dd7e6af593db2bff8ac3a0))
* **pr:** recover comments stuck in syncing instead of re-posting them ([#305](https://github.com/nownabe/bark/issues/305)) ([3548086](https://github.com/nownabe/bark/commit/35480860fb8bde06320dff0a6182d172e8d39f44))
* **pr:** refuse commits to a merged or closed PR ([#330](https://github.com/nownabe/bark/issues/330)) ([2a239ff](https://github.com/nownabe/bark/commit/2a239ffb50669e77c3ba6978102c3eca336f0206)), closes [#288](https://github.com/nownabe/bark/issues/288)
* **pr:** refuse to submit a draft whose quoted text changed upstream ([#346](https://github.com/nownabe/bark/issues/346)) ([d4118a4](https://github.com/nownabe/bark/commit/d4118a4a565f1bc04c23f547179e45d91d6a6405)), closes [#313](https://github.com/nownabe/bark/issues/313)
* **pr:** route replies on the parent's GitHub object kind ([#326](https://github.com/nownabe/bark/issues/326)) ([1df6462](https://github.com/nownabe/bark/commit/1df64628e1c3bcf7b4f8b7a982f5cb4f2b8d60ca)), closes [#285](https://github.com/nownabe/bark/issues/285)
* **pr:** serialise refresh and execution under one Repository lock ([#336](https://github.com/nownabe/bark/issues/336)) ([1864488](https://github.com/nownabe/bark/commit/18644889c00cb1e4c5f83bc7f6e4ed4c536057c0)), closes [#281](https://github.com/nownabe/bark/issues/281)
* **pr:** sweep entities left syncing at the end of a submit ([#331](https://github.com/nownabe/bark/issues/331)) ([108caa9](https://github.com/nownabe/bark/commit/108caa9cf657cd1bec7261ba804c91c2bf9e6a6a)), closes [#271](https://github.com/nownabe/bark/issues/271)
* **release:** pin publish-browser-extension to ^4.0.5 ([#263](https://github.com/nownabe/bark/issues/263)) ([b77104f](https://github.com/nownabe/bark/commit/b77104faa91f64ba43200b8565c9794011a00fd6))
* **review:** derive a suggestion draft's cid from the hunk it materialises ([#337](https://github.com/nownabe/bark/issues/337)) ([963339d](https://github.com/nownabe/bark/commit/963339d9ba947bffeab5974455490088a4e95419)), closes [#308](https://github.com/nownabe/bark/issues/308)
* **review:** end a whole-line selection on the line it actually covers ([#319](https://github.com/nownabe/bark/issues/319)) ([3364d18](https://github.com/nownabe/bark/commit/3364d1826b68030fd01cce79b461a193a88683bb)), closes [#291](https://github.com/nownabe/bark/issues/291)
* **review:** map comment positions between head and edited coordinates ([#348](https://github.com/nownabe/bark/issues/348)) ([9465718](https://github.com/nownabe/bark/commit/9465718d6199fd92f508283ec7d0fb96419d3d0b)), closes [#283](https://github.com/nownabe/bark/issues/283)
* **review:** reject a suggestion by resolving its thread on GitHub ([#340](https://github.com/nownabe/bark/issues/340)) ([d088a8d](https://github.com/nownabe/bark/commit/d088a8d9e419a3ceb84606601d2cacb2483ee383)), closes [#287](https://github.com/nownabe/bark/issues/287)
* **review:** resolve accepted-suggestion threads only after the commit lands ([#341](https://github.com/nownabe/bark/issues/341)) ([770f901](https://github.com/nownabe/bark/commit/770f901026a1d0c70c5ccd6ea688f4e8686626d4)), closes [#278](https://github.com/nownabe/bark/issues/278)
* **review:** surface failed comment posts and keep the reviewer's edits ([#307](https://github.com/nownabe/bark/issues/307)) ([48cb675](https://github.com/nownabe/bark/commit/48cb675e1d7c94f9f100a00c310509b6c4414f31))
* **review:** validate the PR number from the review URL ([#321](https://github.com/nownabe/bark/issues/321)) ([457a942](https://github.com/nownabe/bark/commit/457a942ac81fcc9c7c8095c1b9461e165782bc32)), closes [#295](https://github.com/nownabe/bark/issues/295)
* **storage:** bound chrome.storage.local growth and stop quota errors losing drafts ([#332](https://github.com/nownabe/bark/issues/332)) ([1f96120](https://github.com/nownabe/bark/commit/1f9612063d569a25ccd49484421937bf87c5e075)), closes [#289](https://github.com/nownabe/bark/issues/289)
* **suggest:** consume a longer closing fence instead of leaking a backtick ([#316](https://github.com/nownabe/bark/issues/316)) ([d2e0683](https://github.com/nownabe/bark/commit/d2e06836e41121e3b0c127189ddda31216726392)), closes [#290](https://github.com/nownabe/bark/issues/290)


### Performance Improvements

* **reanchor:** replace the LCS table with a memoised line-level Myers diff ([#344](https://github.com/nownabe/bark/issues/344)) ([8caebdd](https://github.com/nownabe/bark/commit/8caebdd3abf58014d5f3d303fdbe24ddd748888b)), closes [#280](https://github.com/nownabe/bark/issues/280)

## [0.3.0](https://github.com/nownabe/bark/compare/bark-v0.2.1...bark-v0.3.0) (2026-08-08)


### Features

* **github:** add ETag caching and retry to GET requests ([#225](https://github.com/nownabe/bark/issues/225)) ([869e6dc](https://github.com/nownabe/bark/commit/869e6dc734574ead81637bf6e567c84a233f2560)), closes [#9](https://github.com/nownabe/bark/issues/9)
* **pr:** add AppState derivation including re-anchoring (phase 4) ([#115](https://github.com/nownabe/bark/issues/115)) ([9f172a6](https://github.com/nownabe/bark/commit/9f172a60d78e57f7595d257c88fd4f2e34092920))
* **pr:** add bootstrap module that composes the data layer (phase 6b) ([#121](https://github.com/nownabe/bark/issues/121)) ([03a6bce](https://github.com/nownabe/bark/commit/03a6bce854b63a106d6c8e96a09514ff719d8219))
* **pr:** add BrowserStorageAdapter and React hooks (phase 5a) ([#116](https://github.com/nownabe/bark/issues/116)) ([dfb9c7a](https://github.com/nownabe/bark/commit/dfb9c7a466c855eb1666d58a93afde8115e1cd6a))
* **pr:** add data-model types and pure Reconciler (phase 1) ([#112](https://github.com/nownabe/bark/issues/112)) ([b7bd471](https://github.com/nownabe/bark/commit/b7bd471729b8fbc1e647f72dd8d61cda31be18f3))
* **pr:** add diff helpers, fetchChangedFiles, and Snackbar (phase 6a) ([#120](https://github.com/nownabe/bark/issues/120)) ([740187b](https://github.com/nownabe/bark/commit/740187b57f1c8ebe4daf47e1eaaddb339d125973))
* **pr:** add draft creation, submit, and discard to AppV2 (phase 6d) ([#123](https://github.com/nownabe/bark/issues/123)) ([7d1447f](https://github.com/nownabe/bark/commit/7d1447f1dea51e13f7029d4099cf4691cafd7c15))
* **pr:** add ExecutionStep catalog, Planner, and Executor skeleton (phase 2) ([#113](https://github.com/nownabe/bark/issues/113)) ([129df4a](https://github.com/nownabe/bark/commit/129df4af6c2d20a8b93b632a13fe3e9bf24d3f4f))
* **pr:** add GitHub low-level client and Transport (phase 5c) ([#118](https://github.com/nownabe/bark/issues/118)) ([acc4464](https://github.com/nownabe/bark/commit/acc4464ffa6cb7908d01729a78f3b1adfc797b60))
* **pr:** add hidden-metadata wire format (phase 5b) ([#117](https://github.com/nownabe/bark/issues/117)) ([3d9bf12](https://github.com/nownabe/bark/commit/3d9bf129fdb25baa187eab4445aed2e765274d35))
* **pr:** add Markdown source viewer to AppV2 (phase 6f) ([#125](https://github.com/nownabe/bark/issues/125)) ([39a1f6b](https://github.com/nownabe/bark/commit/39a1f6b9f7896a48e683a50cdc851c56968e6aa1))
* **pr:** add minimal AppV2 component on the new data layer (phase 6c) ([#122](https://github.com/nownabe/bark/issues/122)) ([999c089](https://github.com/nownabe/bark/commit/999c089424e73ffd5c7ba29aa1a70710a512c342))
* **pr:** add RemoteFetcher and carry path in WireMetadata (phase 5d) ([#119](https://github.com/nownabe/bark/issues/119)) ([56310b2](https://github.com/nownabe/bark/commit/56310b208e4e4ccfb7afbd2cfae20e812822e99b))
* **pr:** add Repository, StorageAdapter, and state-machine wiring (phase 3) ([#114](https://github.com/nownabe/bark/issues/114)) ([890e69e](https://github.com/nownabe/bark/commit/890e69e5f370f67f9335e65048fc43ea906bf904))
* **pr:** add Resolve / Unresolve and Reply to AppV2 (phase 6e) ([#124](https://github.com/nownabe/bark/issues/124)) ([57faa01](https://github.com/nownabe/bark/commit/57faa01fa20b76f1100343c9feed6af7688f7218))
* **preview:** show language label on fenced code blocks ([#222](https://github.com/nownabe/bark/issues/222)) ([09dd3ee](https://github.com/nownabe/bark/commit/09dd3eed85fbf85eccfbc9137819d0d687f80468)), closes [#8](https://github.com/nownabe/bark/issues/8)
* **pr:** mount AppV2 in the extension entrypoint behind ?v=2 (phase 6g) ([#127](https://github.com/nownabe/bark/issues/127)) ([35eee79](https://github.com/nownabe/bark/commit/35eee7960440448709ed21198512b79781017025))
* **pr:** show foreign (non-Bark) comments in the Threads list ([#132](https://github.com/nownabe/bark/issues/132)) ([dcffa70](https://github.com/nownabe/bark/commit/dcffa70fb39b0464d050976befbdd92f5d302957))
* **pr:** swap Markdown viewer for CodeMirror with selection capture (phase 6h) ([#126](https://github.com/nownabe/bark/issues/126)) ([4e30081](https://github.com/nownabe/bark/commit/4e30081adbf5354bd22df7017a0c8988aedd7e94))
* **pr:** wire auth into AppV2Mount and make V2 the default (phase 6i) ([#128](https://github.com/nownabe/bark/issues/128)) ([e4f5bfb](https://github.com/nownabe/bark/commit/e4f5bfb0b8d1c3e5c157ab4739643db6d4ad2209))
* **review:** add CommentView -&gt; ExistingComment adapter (L2 prep) ([#151](https://github.com/nownabe/bark/issues/151)) ([b7609bb](https://github.com/nownabe/bark/commit/b7609bbd9e97a4e559775671a3c142d03add9fce))
* **review:** announce every error via the Snackbar (ADR 0005 §4) ([#248](https://github.com/nownabe/bark/issues/248)) ([401c771](https://github.com/nownabe/bark/commit/401c771f85941e06c1f304a1bbddb144f5f5b47d))
* **review:** batch author actions and submit as one commit ([#101](https://github.com/nownabe/bark/issues/101)) ([0c33109](https://github.com/nownabe/bark/commit/0c3310950404bed54e4fb56a462144f1e9ee0786))
* **review:** bootstrap the new-data-layer Repository in legacy App ([#136](https://github.com/nownabe/bark/issues/136)) ([73abf2f](https://github.com/nownabe/bark/commit/73abf2f8d6c0dab901fb097735a5a61e8f35f6f5))
* **review:** double-write reply drafts (submitted-thread targets) into Repository (L6a) ([#159](https://github.com/nownabe/bark/issues/159)) ([b89b2ed](https://github.com/nownabe/bark/commit/b89b2ed902200423e3e468abf6ed18753714fff8))
* **review:** drive Bark anchor badges from AppState's displayPosition (L5) ([#155](https://github.com/nownabe/bark/issues/155)) ([2dc29a9](https://github.com/nownabe/bark/commit/2dc29a94ee3d5af4913dd62eeb591cb877baca75))
* **review:** enable Resolve/Reopen on foreign in-diff review threads (L3b) ([#154](https://github.com/nownabe/bark/issues/154)) ([8e0dac8](https://github.com/nownabe/bark/commit/8e0dac8145a111a3626470949651a35c2505a119))
* **review:** keep Bark line-bound — filter out outdated and issue foreign comments (L3a) ([#153](https://github.com/nownabe/bark/issues/153)) ([3e28710](https://github.com/nownabe/bark/commit/3e28710b9374645f908f15946d30095cb624d0a0))
* **review:** merge foreign comments from AppState into the rendered list (L2) ([#152](https://github.com/nownabe/bark/issues/152)) ([c940467](https://github.com/nownabe/bark/commit/c940467fcc04c09f6ea249860c6390b54e70909c))
* **review:** route author submit through Repository.submitDrafts (L6d-3) ([#163](https://github.com/nownabe/bark/issues/163)) ([695f58a](https://github.com/nownabe/bark/commit/695f58aa52559dcf4bbac30ff899971003f3ef66))
* **review:** route Bark-thread resolve/reopen through Repository (L6b) ([#160](https://github.com/nownabe/bark/issues/160)) ([48fd18a](https://github.com/nownabe/bark/commit/48fd18a7ce38dee62394a95665d57fb4cf4df1e8))
* **review:** submit in-diff drafts through Repository.submitDrafts (L6c) ([#161](https://github.com/nownabe/bark/issues/161)) ([b06b28b](https://github.com/nownabe/bark/commit/b06b28b22e536b507d54626f57e429f398a139d9))
* **review:** support replying to foreign threads ([#183](https://github.com/nownabe/bark/issues/183)) ([#208](https://github.com/nownabe/bark/issues/208)) ([2c6020f](https://github.com/nownabe/bark/commit/2c6020fadf69da762e8b5f8fe2771c7d98c267ae))
* **review:** wire ADR 0005 refresh triggers into the live App ([#246](https://github.com/nownabe/bark/issues/246)) ([a4a59cb](https://github.com/nownabe/bark/commit/a4a59cb716e3687a2e3be3b980f2e1264d473e6e))


### Bug Fixes

* **content:** inject Open in Bark after Turbo nav from any github.com page ([#189](https://github.com/nownabe/bark/issues/189)) ([#211](https://github.com/nownabe/bark/issues/211)) ([dc89ec7](https://github.com/nownabe/bark/commit/dc89ec7da774fcceaa78f03a96ae59b90e59c25b))
* **content:** resolve PR ref at click time to survive Turbo navigation ([#87](https://github.com/nownabe/bark/issues/87)) ([#214](https://github.com/nownabe/bark/issues/214)) ([a6fc9f7](https://github.com/nownabe/bark/commit/a6fc9f7990296ff01e627a2125efb33514dda2cf))
* derive author role from identity so commit flow is reachable ([#83](https://github.com/nownabe/bark/issues/83)) ([#93](https://github.com/nownabe/bark/issues/93)) ([bf3547e](https://github.com/nownabe/bark/commit/bf3547e2014aacb85ccc65523a32cce331b4bf56))
* **pr:** advance RemoteState head SHA on commit success ([#197](https://github.com/nownabe/bark/issues/197)) ([a0b333c](https://github.com/nownabe/bark/commit/a0b333c9531042063a2bd78d959e320e2061653d))
* **pr:** bind metadata fence identity to its earliest bearer ([#190](https://github.com/nownabe/bark/issues/190)) ([#212](https://github.com/nownabe/bark/issues/212)) ([dcf3e7f](https://github.com/nownabe/bark/commit/dcf3e7f386b33fed51b3a2aaaff71e4c15655f09))
* **pr:** detect stale-edit commit conflicts and auto-rebase as recovery ([#187](https://github.com/nownabe/bark/issues/187)) ([#209](https://github.com/nownabe/bark/issues/209)) ([6efc766](https://github.com/nownabe/bark/commit/6efc76691087dce3711c95d735538ab6d26fcaf0))
* **pr:** drop legacy v1 resolve-marker comments instead of rendering them ([#186](https://github.com/nownabe/bark/issues/186)) ([#204](https://github.com/nownabe/bark/issues/204)) ([8f8e8bc](https://github.com/nownabe/bark/commit/8f8e8bcae871a19dff2043c8aba800ef4819a78b))
* **pr:** fetchRemoteState auto-collects old sources from comment anchors ([#156](https://github.com/nownabe/bark/issues/156)) ([bac7c90](https://github.com/nownabe/bark/commit/bac7c90150e6d42c2e44b281cd3aad96d221d048))
* **pr:** key foreign comment threadId off the review-thread node id ([#180](https://github.com/nownabe/bark/issues/180), [#181](https://github.com/nownabe/bark/issues/181)) ([#201](https://github.com/nownabe/bark/issues/201)) ([5784dc3](https://github.com/nownabe/bark/commit/5784dc34288615aed4486e4e69ae221989ed2719))
* **pr:** make appstate suggestion parsing fence-length aware ([#217](https://github.com/nownabe/bark/issues/217)) ([3b3e863](https://github.com/nownabe/bark/commit/3b3e8632f1e0f57716eab7e3ac082f782f537333)), closes [#195](https://github.com/nownabe/bark/issues/195)
* **pr:** paginate review-thread GraphQL queries ([#178](https://github.com/nownabe/bark/issues/178)) ([#200](https://github.com/nownabe/bark/issues/200)) ([b0d6c58](https://github.com/nownabe/bark/commit/b0d6c58c33015820388690d2f260a35755f61150))
* **pr:** preserve slashes in GitHub contents and updateRef URLs ([#129](https://github.com/nownabe/bark/issues/129)) ([b747738](https://github.com/nownabe/bark/commit/b7477383f835b2ad58d3ac1d24b141573f2622f2))
* **pr:** read legacy bark:v1 metadata fences as v2 (backward compat) ([#157](https://github.com/nownabe/bark/issues/157)) ([be19c30](https://github.com/nownabe/bark/commit/be19c300d8f0fe2cf4175eadc64876ae412ee732))
* **pr:** release threads stuck in syncing and make failed resolves retryable ([#188](https://github.com/nownabe/bark/issues/188)) ([#207](https://github.com/nownabe/bark/issues/207)) ([2b081c1](https://github.com/nownabe/bark/commit/2b081c124d66fd4a9f79e1a70f023b674e29e1ff))
* **pr:** route replies to out-of-diff parents as issue comments ([#184](https://github.com/nownabe/bark/issues/184)) ([#203](https://github.com/nownabe/bark/issues/203)) ([57dc693](https://github.com/nownabe/bark/commit/57dc693826efe8ea094355fbdbcb1700c6fe65aa))
* **pr:** skip empty-sha foreign comments from fileContentTargets ([#131](https://github.com/nownabe/bark/issues/131)) ([23f14c8](https://github.com/nownabe/bark/commit/23f14c8d830ec4e3c5b178cba0af8667d7adb853))
* re-map accept target from head to edited coordinates ([#177](https://github.com/nownabe/bark/issues/177)) ([#199](https://github.com/nownabe/bark/issues/199)) ([ad86398](https://github.com/nownabe/bark/commit/ad863984e7e8fbe16d6db35f9da1ef98ff08243a))
* **review:** allowlist URL schemes in preview link widget ([#213](https://github.com/nownabe/bark/issues/213)) ([9958a6b](https://github.com/nownabe/bark/commit/9958a6b98326bf7f08778cade20e368e4c9e261f))
* **review:** clear token-bound Repository on sign-out ([#216](https://github.com/nownabe/bark/issues/216)) ([697b10b](https://github.com/nownabe/bark/commit/697b10b02cfd70cbfdbac0ff43f1e2212958b16c)), closes [#192](https://github.com/nownabe/bark/issues/192)
* **review:** emit pending suggestion for pure-insertion edits ([#106](https://github.com/nownabe/bark/issues/106)) ([913b377](https://github.com/nownabe/bark/commit/913b37785bd0713c99ba9e6bde6d81e2f4d49f40))
* **review:** hide suggestion overlay in editor for resolved threads ([#104](https://github.com/nownabe/bark/issues/104)) ([38bff46](https://github.com/nownabe/bark/commit/38bff463d7f61e400573d0ba22ef92140051c2f3))
* **review:** hold the editor read-only until the selected file loads ([#185](https://github.com/nownabe/bark/issues/185)) ([#206](https://github.com/nownabe/bark/issues/206)) ([db65f42](https://github.com/nownabe/bark/commit/db65f4267cf05db8f76bcffec2a81261110e0d5d))
* **review:** only offer Resolve on threads with a native review thread ([#182](https://github.com/nownabe/bark/issues/182)) ([#202](https://github.com/nownabe/bark/issues/202)) ([4459285](https://github.com/nownabe/bark/commit/4459285548d6026467e7a6c6d4a7f8a535aad278))
* **review:** order sidebar entries by (line, col) tuple, not a packed int ([#219](https://github.com/nownabe/bark/issues/219)) ([0d884c7](https://github.com/nownabe/bark/commit/0d884c7f7ed66da499e746442036a14613b32ba4)), closes [#196](https://github.com/nownabe/bark/issues/196)
* **review:** post Bark resolve-event before GraphQL resolve on author Submit ([#103](https://github.com/nownabe/bark/issues/103)) ([27c25ca](https://github.com/nownabe/bark/commit/27c25ca4aa1499bc1e1aa02fad0dee3429fd2a42))
* **review:** reference commit sha in accept-suggestion resolve reply ([#108](https://github.com/nownabe/bark/issues/108)) ([a739cdf](https://github.com/nownabe/bark/commit/a739cdfada7ebaafd55f9b0c0e45d5aedb74d92c))
* **review:** replace quote-sized span when applying accepted suggestions ([#102](https://github.com/nownabe/bark/issues/102)) ([9d697ac](https://github.com/nownabe/bark/commit/9d697ac99614ccb4138eac1272b88690c78dd91c))
* **review:** suppress redundant edit item when file has an accepted suggestion ([#105](https://github.com/nownabe/bark/issues/105)) ([89ab779](https://github.com/nownabe/bark/commit/89ab7791c2adb4f2e898e17dcf6d71e4b2304c8f))
* **review:** surface pending reply on a resolved thread in the sidebar ([#215](https://github.com/nownabe/bark/issues/215)) ([0af54da](https://github.com/nownabe/bark/commit/0af54da4bfff0b627819b6c6193c353a7514e25f)), closes [#193](https://github.com/nownabe/bark/issues/193)
* **suggest:** drop trailing newline when accepting a line-deletion suggestion ([#218](https://github.com/nownabe/bark/issues/218)) ([1cb56be](https://github.com/nownabe/bark/commit/1cb56bea715da3eae076206d27dc063ac70f7240)), closes [#191](https://github.com/nownabe/bark/issues/191)
* **suggest:** escape backtick fences in suggestion blocks ([#110](https://github.com/nownabe/bark/issues/110)) ([27ee596](https://github.com/nownabe/bark/commit/27ee5967a89f23fde9b797a8c967638276452bb8))
* **suggest:** ignore trailing-newline-only edits as pending changes ([#220](https://github.com/nownabe/bark/issues/220)) ([2e70b84](https://github.com/nownabe/bark/commit/2e70b8446d6d6a648bae3a37923eb7346f927cbe)), closes [#194](https://github.com/nownabe/bark/issues/194)
* verify quote match before applying accepted suggestions ([#198](https://github.com/nownabe/bark/issues/198)) ([2995622](https://github.com/nownabe/bark/commit/29956226fda3766889d6db5f68da54aeaf25e19a)), closes [#176](https://github.com/nownabe/bark/issues/176)

## [0.2.1](https://github.com/nownabe/bark/compare/bark-v0.2.0...bark-v0.2.1) (2026-06-22)


### Bug Fixes

* remove unused scripting permission rejected by Chrome Web Store ([#95](https://github.com/nownabe/bark/issues/95)) ([2807e7a](https://github.com/nownabe/bark/commit/2807e7af12e9aa9c80133600f41d04fae3380b64))

## [0.2.0](https://github.com/nownabe/bark/compare/bark-v0.1.0...bark-v0.2.0) (2026-06-22)


### Features

* accept/reject suggestions in author mode ([#20](https://github.com/nownabe/bark/issues/20)) ([ad2bada](https://github.com/nownabe/bark/commit/ad2bada79357c2071e030af4146f4676403e268c))
* add Bark icon as extension icon, favicon, and entry button ([#22](https://github.com/nownabe/bark/issues/22)) ([ccc0572](https://github.com/nownabe/bark/commit/ccc05720cc7d7f7342009534350ef828a3609544))
* **auth:** add fine-grained PAT login alongside GitHub App ([#78](https://github.com/nownabe/bark/issues/78)) ([cbb7e86](https://github.com/nownabe/bark/commit/cbb7e8629859996948aceec4d6b2c96e5b667a56))
* author source editing and single-file commit (R5) ([af73198](https://github.com/nownabe/bark/commit/af73198a3fd2bd10586d9b2fc67c2fe97e6f15db))
* dedicated install gate when the repo is not accessible ([#35](https://github.com/nownabe/bark/issues/35)) ([64e9398](https://github.com/nownabe/bark/commit/64e939818b54a9855c64a3fadb060b1caa1755e9))
* embed/extract comment metadata for char-level anchor restore (難所[#2](https://github.com/nownabe/bark/issues/2)) ([f747486](https://github.com/nownabe/bark/commit/f74748624854414a2c6fda048e617859ecf47181))
* fetch PR markdown from GitHub with PAT auth and sanitized rendering ([#1](https://github.com/nownabe/bark/issues/1)) ([eb93842](https://github.com/nownabe/bark/commit/eb938425a309347f4c66da71a80e986ecf9b984e))
* import and display existing PR comments with anchor restore (R6) ([8281a28](https://github.com/nownabe/bark/commit/8281a28a34f25e0d7d0b06655911167acdd86397))
* link the PR reference in the header back to the GitHub PR ([#19](https://github.com/nownabe/bark/issues/19)) ([5fdada0](https://github.com/nownabe/bark/commit/5fdada057a062a55aaceb55393fd6ed54370646f))
* local draft tray and one-shot Submit to GitHub (R4) ([33fb1b3](https://github.com/nownabe/bark/commit/33fb1b3ca3cece155d6884527bdff150bec60a19))
* make the author/reviewer switch a dev-only floating control ([#36](https://github.com/nownabe/bark/issues/36)) ([c9ad52d](https://github.com/nownabe/bark/commit/c9ad52d251d7fdb86054a6c15c0a4c49a188fc38))
* pageless doc, comment-only composer, help/debug popovers, highlight fixes ([836f961](https://github.com/nownabe/bark/commit/836f9619c3213716606c0cf781d4aab544d8856a))
* paginate file/comment listings and clarify rate-limit errors ([eebabf4](https://github.com/nownabe/bark/commit/eebabf426c2625b9708647b74d3d8083e4dfd6d6))
* **preview:** let reviewers comment on rendered mermaid diagrams ([#58](https://github.com/nownabe/bark/issues/58)) ([1fd5ca8](https://github.com/nownabe/bark/commit/1fd5ca822d3c60e6b4c56839059b85d9aa761734))
* **preview:** render mermaid diagrams in the preview ([#51](https://github.com/nownabe/bark/issues/51)) ([dbb9e09](https://github.com/nownabe/bark/commit/dbb9e09e43bf21060a6b1586a3436b9bc01a4a25))
* Raw/Preview live-preview toggle with inline markdown decorations ([17fdcdc](https://github.com/nownabe/bark/commit/17fdcdcf9d345fbcab58c92e2f8e9a5dd63a6593))
* re-anchor comments across commits via quotedText (R7) ([8dd1c6d](https://github.com/nownabe/bark/commit/8dd1c6d911a34743de104c0b84c76e794d6fd491))
* **reanchor:** use commit diff to re-anchor comments exactly ([#69](https://github.com/nownabe/bark/issues/69)) ([7d62406](https://github.com/nownabe/bark/commit/7d624068fcef5b9f534c0e5e30e3736f1bb3db61))
* redesign UI — sticky header, threaded position-sorted comments, debug panel ([b91882e](https://github.com/nownabe/bark/commit/b91882e5dcb32ff5c4813a5501af6e6230f7b906))
* render code/quote/list/table blocks in Preview (GFM) ([595c0e9](https://github.com/nownabe/bark/commit/595c0e9951b42486684c20dd74677b56278b06fc))
* render Markdown links in preview mode ([#30](https://github.com/nownabe/bark/issues/30)) ([cc5d0c1](https://github.com/nownabe/bark/commit/cc5d0c17fc59f9571e7b30f938f78682d113b461))
* render markdown with source-position mapping and selection anchoring (難所[#1](https://github.com/nownabe/bark/issues/1)) ([9cc3e7b](https://github.com/nownabe/bark/commit/9cc3e7bb369a720bac002ba9a50215b1a60cc4e7))
* render submitted suggestions as tracked changes; clearer status; hide token delete ([6d17c8f](https://github.com/nownabe/bark/commit/6d17c8fcafbaa3fd79bbfd0c2f0524cc8a1884d1))
* replace manual PAT entry with GitHub App device flow auth ([#34](https://github.com/nownabe/bark/issues/34)) ([3d0a7c7](https://github.com/nownabe/bark/commit/3d0a7c774606c1e6214ed04cd540448c4939b350))
* **review:** add discard-all pending review action ([#68](https://github.com/nownabe/bark/issues/68)) ([5527b08](https://github.com/nownabe/bark/commit/5527b080e4ad0c725fce103d4e74e8c5229cd71a))
* reviewer suggesting mode — edits become suggestions with tracked changes ([3267402](https://github.com/nownabe/bark/commit/3267402f837f6ca3f9495ea04b13004d33d7567d))
* **review:** gate comment composer behind a selection bubble button ([#73](https://github.com/nownabe/bark/issues/73)) ([8cb4da5](https://github.com/nownabe/bark/commit/8cb4da500ccdcfb666066d42d4f4ff9527ead2fa))
* **review:** make pending suggestions interactive and emphasis-driven ([#61](https://github.com/nownabe/bark/issues/61)) ([c8d814e](https://github.com/nownabe/bark/commit/c8d814eed451b258a454ccfea4e428957109b51d))
* **review:** render suggestions char-level like comments ([#62](https://github.com/nownabe/bark/issues/62)) ([d2353b7](https://github.com/nownabe/bark/commit/d2353b7e792d65af87b3b3d3b2b7215133fafd3d))
* **review:** resolve and reopen comment/suggestion threads ([#72](https://github.com/nownabe/bark/issues/72)) ([837b684](https://github.com/nownabe/bark/commit/837b684ea4664258a0381c3b240f15496d783972))
* **review:** scroll a newly created suggestion into view ([#60](https://github.com/nownabe/bark/issues/60)) ([e61d40f](https://github.com/nownabe/bark/commit/e61d40fb9d3054e0642ee63d7776228bc7b591cb))
* **review:** submit all files at once with a file-grouped confirm modal ([#59](https://github.com/nownabe/bark/issues/59)) ([122d299](https://github.com/nownabe/bark/commit/122d299090c465885b2cb7240c39b0f66d84f30a))
* rework reviewer-mode sidebar, submit flow, and suggestions ([#31](https://github.com/nownabe/bark/issues/31)) ([99ecdd5](https://github.com/nownabe/bark/commit/99ecdd5c36f18c18702a10234694b6331dc2db25))
* route comments by diff in/out and build blob permalinks (難所[#3](https://github.com/nownabe/bark/issues/3)) ([bdb2c4c](https://github.com/nownabe/bark/commit/bdb2c4c85d9ef53bf57985be0de045836f2d91eb))
* scaffold DocReview Chrome extension (WXT + React, M0) ([7568cab](https://github.com/nownabe/bark/commit/7568cab3269359d241c1c105f01d45741b3fc650))
* suggestion comments (R3) ([49de555](https://github.com/nownabe/bark/commit/49de555581b3b2ae9633aac6330f54b62f632799))
* syntax-highlight fenced code blocks by language ([a3a9a7f](https://github.com/nownabe/bark/commit/a3a9a7fdfb5dbc2947c224f777d0f3dfe4d8ff34))
* **ui:** align emphasized sidebar item to selected text in the editor ([#44](https://github.com/nownabe/bark/issues/44)) ([4c13545](https://github.com/nownabe/bark/commit/4c13545987afd12752ddf932e5d1e38661d40e76))
* **ui:** clear review-item emphasis when focus moves away ([#48](https://github.com/nownabe/bark/issues/48)) ([eb1ba25](https://github.com/nownabe/bark/commit/eb1ba25f56e6e6558e7984d7d54e78fb41e61681))
* **ui:** dismiss the help popover on an outside click ([#56](https://github.com/nownabe/bark/issues/56)) ([99729cc](https://github.com/nownabe/bark/commit/99729ccf2bfaa6ee6baaa68d570e01885e34a410))
* **ui:** open reply box when clicking highlighted text in the editor ([#42](https://github.com/nownabe/bark/issues/42)) ([6387aec](https://github.com/nownabe/bark/commit/6387aec32ffc4e572aecab8fee6cc3777909c3ba))
* **ui:** scope the review list to the current file ([#54](https://github.com/nownabe/bark/issues/54)) ([032a2e0](https://github.com/nownabe/bark/commit/032a2e0bc6d48d5a60c6873e412255e03ade6a2c))
* **ui:** show author avatar next to the handle on comments ([#47](https://github.com/nownabe/bark/issues/47)) ([2f57686](https://github.com/nownabe/bark/commit/2f57686e35bd4501064abc865164e5264e2ed10a))
* **ui:** show pull request metadata (title, author, status, body) ([#55](https://github.com/nownabe/bark/issues/55)) ([d7a41d5](https://github.com/nownabe/bark/commit/d7a41d5f6dc3631b5d57dc4b3c6a75f88412a92f))
* **ui:** submit reply/comment with Ctrl/Cmd+Enter ([#45](https://github.com/nownabe/bark/issues/45)) ([0315cfb](https://github.com/nownabe/bark/commit/0315cfbe2a612644d5281da4b48e596f49a0fa46))
* **ui:** summarize what Submit review will post ([#49](https://github.com/nownabe/bark/issues/49)) ([eca011c](https://github.com/nownabe/bark/commit/eca011c9560d78bd06f9b2a4c9f8c89bc9a23f18))
* unify document surface on CodeMirror 6 with role toggle (Obsidian-style) ([f137a53](https://github.com/nownabe/bark/commit/f137a53f3e3aacf43a9de42e88828f034654a95b))
* unify submit, suggestion+optional comment, clickable side items, reply cancel ([8d38820](https://github.com/nownabe/bark/commit/8d388204dd94ddbc7183c64b99655429996d16a8))


### Bug Fixes

* **ci:** build Pages artifact without an unpinned nested action ([#79](https://github.com/nownabe/bark/issues/79)) ([df1961f](https://github.com/nownabe/bark/commit/df1961f9e4446c7d29176bf40ab36f6aac242b50))
* clip comment highlights to current doc length (avoid out-of-range crash) ([98db25b](https://github.com/nownabe/bark/commit/98db25b97d4823f7fb03e01a0b7aedb77c2bbc7a))
* keep inline styling on deleted text in reviewer suggest mode ([#28](https://github.com/nownabe/bark/issues/28)) ([033e227](https://github.com/nownabe/bark/commit/033e227c535ed542fbdb0763f4a4bad2bc2fdde0))
* **preview:** stop mermaid error graphics piling up in the DOM ([#57](https://github.com/nownabe/bark/issues/57)) ([109cc09](https://github.com/nownabe/bark/commit/109cc09cb788bbf3e54b00c55053b971af6b336d))
* **release:** align release-please baseline with v0.1.0 ([#98](https://github.com/nownabe/bark/issues/98)) ([c8354c6](https://github.com/nownabe/bark/commit/c8354c6c68fa9ab46b05581bd6631e76f9cc30e4))
* remove active-line highlight in the review editor ([#25](https://github.com/nownabe/bark/issues/25)) ([4b891f7](https://github.com/nownabe/bark/commit/4b891f703e627a73cd540d6cec50f93a95aed058))
* remove arrow glyph from the PR reference link ([#21](https://github.com/nownabe/bark/issues/21)) ([ea7f0ab](https://github.com/nownabe/bark/commit/ea7f0ab364a77d5c9dc5f13aad71ca62b796f6ea))
* render submitted single-line suggestions in the editor ([#50](https://github.com/nownabe/bark/issues/50)) ([8fced88](https://github.com/nownabe/bark/commit/8fced88358ef8a64d10cfc2c50abce61efcca1ff))
* **review:** persist pending suggestions across reload ([#63](https://github.com/nownabe/bark/issues/63)) ([f0e41ea](https://github.com/nownabe/bark/commit/f0e41ea5c202c4665152d0bb2d15af8326d477f7))
* **review:** preserve editor cursor when clicking commented text ([#74](https://github.com/nownabe/bark/issues/74)) ([96045d9](https://github.com/nownabe/bark/commit/96045d998904b10f03ad721cb187716e53bb87cf))
* **review:** preserve resolved facet state after submit review ([#75](https://github.com/nownabe/bark/issues/75)) ([b4d5d83](https://github.com/nownabe/bark/commit/b4d5d83de323d2241e5f6a263cdeb0fabc83c51b))
* **review:** scope submit review to all files, not just the active file ([#65](https://github.com/nownabe/bark/issues/65)) ([b81507f](https://github.com/nownabe/bark/commit/b81507fa1bfed580375be34e0ba7c06f640fca48))
* **review:** wait for GitHub read-after-write lag after submit ([#76](https://github.com/nownabe/bark/issues/76)) ([645d075](https://github.com/nownabe/bark/commit/645d07572a3f64089e9f51c94581bc79b58ec5ea))
* **ui:** remove background fill from emphasized review thread ([#40](https://github.com/nownabe/bark/issues/40)) ([4e74879](https://github.com/nownabe/bark/commit/4e74879f2bce9c4488e73cb4c3acaa900985c9c7))
* **ui:** suppress focus ring on reply field inside emphasized thread ([#41](https://github.com/nownabe/bark/issues/41)) ([143fe8b](https://github.com/nownabe/bark/commit/143fe8b228f0c5874b151dc30e845b9e28bf846a))
