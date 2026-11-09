---
'@contentauth/c2pa-node': minor
---

Add stream assets to Reader. `Reader.fromAsset` and `Reader.fromManifestDataAndAsset` accept `{ stream: { size, read, bufferSize? } }`, where `read` has the shape of `fs.read`, so an asset can be read without having it on local disk or wholly in memory.
