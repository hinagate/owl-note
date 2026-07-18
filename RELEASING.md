# Chrome Web Store release

Create a submission with one command:

```sh
npm run release
```

This production-builds from a clean `dist/`, audits the compiled files for
Manifest V3 remote-code violations and version/manifest mistakes, runs the full
test suite serially to avoid timer starvation in browser integration tests,
audits again, and creates `owl-note-<version>.zip`.

Upload only that generated ZIP. Do not ZIP the repository or `node_modules/`.
Before submission, load `dist/` as an unpacked extension and smoke-test note
editing, semantic search/model download, DOCX import, PDF export/download/share,
selection capture, and Google Drive sync.

The semantic model is remote **data** pinned to an immutable revision. Its ONNX
Runtime JavaScript, module loader, and WASM executable are packaged in `dist/`.
If any dependency reintroduces a CDN or remote executable URL, the release audit
must fail rather than producing a store package.

Review-sensitive browser libraries are kept as untouched standalone files:
`mammoth.browser.min.js` and `html2canvas.min.js`. The ONNX Runtime `.mjs` and
`.wasm` are also copied directly. The audit byte-compares all four files with
their installed package artifacts so their signatures remain verifiable.
