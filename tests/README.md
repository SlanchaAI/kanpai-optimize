# Whole repository verification

Run `bash tests/verify_whole_tests.sh` with Node 22+ and Chrome/Chromium installed
(`CHROME_BIN` can select the executable). No npm packages, remote APIs or customer
fixtures are used. One browser runs at a time. Coverage stays in ignored `coverage/`. Chrome profiles use the short
`/mnt/models/fleet-offload/tmp/kanpai-0cc2a7723b01` directory on Dell (avoiding
Unix socket path limits), or ignored `.test-tmp/` inside a shorter CI checkout.
Browser launches wait while one-minute system load is 16 or higher.

`inventory.json` classifies every tracked/unignored file individually. Unknown or
missing files fail verification, including new unimported modules. Both first-party
executable modules are inline ES modules: the two HTML pages. Each is parsed with
Chrome's DOMParser; extra script blocks fail until mapped. Documentation, hosting
configuration, generated Wrangler metadata and the vendored Three.js bundle have
individual exclusion reasons. Tests and CI are identified separately as validation
infrastructure, executed by the verifier rather than application coverage targets.

The suite serves synthetic loopback-only pages, uses the actual vendored renderer
and SwiftShader WebGL, and checks animation/static behavior, geometry, pointer
capabilities, pixel ratio, scroll opacity and camera position, responsive placement,
visibility pause/resume, context loss/restoration and unavailable-WebGL fallback.
Test-only instrumentation records scene/camera/renderer references immediately
before original draw calls; rendering logic remains unchanged. External HTTPS
requests are blocked and DNS outside loopback cannot resolve.

Precise V8 browser coverage starts before navigation. Each application module must
appear and every function must execute across scenarios; zero-count functions fail.
Coverage therefore cannot silently omit an unimported application module. Raw
function/block counters are published in `coverage/browser-coverage.json`, alongside
the audited inventory and Node V8 coverage for the harness. Block counters are
reported for inspection, not claimed as a 100% branch gate. Test infrastructure is
not included in the application function threshold. CI runs the same verifier and
uploads all coverage and inventory evidence even on failures.
