// Copyright 2024 Adobe. All rights reserved.
// This file is licensed to you under the Apache License,
// Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0)
// or the MIT license (http://opensource.org/licenses/MIT),
// at your option.

// Unless required by applicable law or agreed to in writing,
// this software is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR REPRESENTATIONS OF ANY KIND, either express or
// implied. See the LICENSE-MIT and LICENSE-APACHE files for the
// specific language governing permissions and limitations under
// each license.

/* eslint-disable @typescript-eslint/no-non-null-assertion */
// import native objects from built native code
import type { ManifestStore } from "@contentauth/c2pa-types";
import path from "path";
import { setTimeout } from "timers/promises";
import { setFlagsFromString } from "v8";
import { runInNewContext } from "vm";
import fs from "fs-extra";
import { AssetTooLargeError, Context } from "@contentauth/c2pa-utilities";

import { Reader } from "./Reader.js";
import { Builder } from "./Builder.js";
import { MAX_SIZE_IN_BYTES } from "./assetSize.js";
import type { SourceStream } from "./types.d.ts";

const tempDir = path.join(__dirname, "tmp");

describe("Reader", () => {
  const manifestStore: ManifestStore = JSON.parse(`{
  "active_manifest": "contentauth:urn:uuid:c2677d4b-0a93-4444-876f-ed2f2d40b8cf",
  "manifests": {
    "contentauth:urn:uuid:c2677d4b-0a93-4444-876f-ed2f2d40b8cf": {
      "claim_generator": "make_test_images/0.33.1 c2pa-rs/0.33.1",
      "claim_version": 1,
      "claim_generator_info": [
        {
          "name": "make_test_images",
          "version": "0.33.1"
        },
        {
          "name": "c2pa-rs",
          "version": "0.33.1"
        }
      ],
      "title": "CA.jpg",
      "format": "image/jpeg",
      "instance_id": "xmp:iid:ba572347-db0e-4619-b6eb-d38e487da238",
      "thumbnail": {
        "format": "image/jpeg",
        "identifier": "self#jumbf=/c2pa/contentauth:urn:uuid:c2677d4b-0a93-4444-876f-ed2f2d40b8cf/c2pa.assertions/c2pa.thumbnail.claim.jpeg"
      },
      "ingredients": [
        {
          "title": "A.jpg",
          "format": "image/jpeg",
          "document_id": "xmp.did:813ee422-9736-4cdc-9be6-4e35ed8e41cb",
          "instance_id": "xmp.iid:813ee422-9736-4cdc-9be6-4e35ed8e41cb",
          "thumbnail": {
            "format": "image/jpeg",
            "identifier": "self#jumbf=/c2pa/contentauth:urn:uuid:c2677d4b-0a93-4444-876f-ed2f2d40b8cf/c2pa.assertions/c2pa.thumbnail.ingredient.jpeg"
          },
          "relationship": "parentOf",
          "label": "c2pa.ingredient"
        }
      ],
      "assertions": [
        {
          "label": "stds.schema-org.CreativeWork",
          "data": {
            "@context": "http://schema.org/",
            "@type": "CreativeWork",
            "author": [
              {
                "name": "John Doe",
                "@type": "Person"
              }
            ]
          },
          "kind": "Json"
        },
        {
          "label": "c2pa.actions.v2",
          "data": {
            "actions": [
              {
                "action": "c2pa.opened",
                "parameters": {
                  "ingredient": {
                    "url": "self#jumbf=c2pa.assertions/c2pa.ingredient",
                    "hash": "5dNlxTKe4afGAicpJa1hF1R3mBZKE+Bl0xmh0McXuO4="
                  }
                }
              },
              {
                "action": "c2pa.color_adjustments",
                "parameters": {
                  "name": "brightnesscontrast"
                }
              }
            ]
          }
        }
      ],
      "signature_info": {
        "alg": "Ps256",
        "issuer": "C2PA Test Signing Cert",
        "common_name": "C2PA Signer",
        "cert_serial_number": "720724073027128164015125666832722375746636448153",
        "time": "2024-08-06T21:53:37+00:00"
      },
      "label": "contentauth:urn:uuid:c2677d4b-0a93-4444-876f-ed2f2d40b8cf"
    }
  }
}`);

  beforeAll(async () => {
    await fs.ensureDir(tempDir);
  });

  afterAll(async () => {
    await fs.remove(tempDir);
  });

  it("should read from an ArrayBuffer", async () => {
    const buffer = await fs.readFile("./tests/fixtures/CA.jpg");
    const reader = await Reader.fromAsset({
      buffer,
      mimeType: "jpeg",
    });
    expect(reader).not.toBeNull();

    const json = reader!.json();
    expect(json.manifests).toEqual(manifestStore.manifests);
    expect(json.active_manifest).toEqual(manifestStore.active_manifest);
  });

  it("should read from an ArrayBuffer with no mimeType by detecting the format from its bytes", async () => {
    const buffer = await fs.readFile("./tests/fixtures/CA.jpg");
    const reader = await Reader.fromAsset({ buffer });
    expect(reader).not.toBeNull();

    const json = reader!.json();
    expect(json.manifests).toEqual(manifestStore.manifests);
    expect(json.active_manifest).toEqual(manifestStore.active_manifest);
  });

  it("should read from a file", async () => {
    const reader = await Reader.fromAsset({
      path: "./tests/fixtures/CA.jpg",
    });
    expect(reader).not.toBeNull();
    const json = reader!.json();
    expect(json.manifests).toEqual(manifestStore.manifests);
    expect(json.active_manifest).toEqual(manifestStore.active_manifest);
  });

  it("should read from a file with an unrecognized extension by detecting the format from its bytes", async () => {
    const extensionlessPath = path.join(tempDir, "no-extension");
    await fs.copyFile("./tests/fixtures/CA.jpg", extensionlessPath);

    const reader = await Reader.fromAsset({ path: extensionlessPath });
    expect(reader).not.toBeNull();

    const json = reader!.json();
    expect(json.manifests).toEqual(manifestStore.manifests);
    expect(json.active_manifest).toEqual(manifestStore.active_manifest);
  });

  it("should return null for a file without C2PA data", async () => {
    const reader = await Reader.fromAsset({
      path: "./tests/fixtures/A.jpg",
    });
    expect(reader).toBeNull();
  });

  it("should throw AssetTooLargeError for a file asset exceeding the max size", async () => {
    const oversizedPath = path.join(tempDir, "oversized.jpg");
    await fs.ensureFile(oversizedPath);
    await fs.truncate(oversizedPath, MAX_SIZE_IN_BYTES + 1);

    await expect(
      Reader.fromAsset({ path: oversizedPath }),
    ).rejects.toThrow(AssetTooLargeError);
  });

  it("should honor a lower max size from a Context", async () => {
    const context = new Context(undefined, { maxSizeInBytes: 1 });

    await expect(
      Reader.fromAsset({ path: "./tests/fixtures/A.jpg" }, context),
    ).rejects.toThrow(AssetTooLargeError);
  });

  it("should read from manifest data and buffer", async () => {
    const manifestData = await fs.readFile(
      "./tests/fixtures/CA/manifest_data.c2pa",
    );
    const buffer = await fs.readFile("./tests/fixtures/CA.jpg");
    const reader = await Reader.fromManifestDataAndAsset(manifestData, {
      buffer,
      mimeType: "jpeg",
    });
    const json = reader!.json();
    expect(json.manifests).toEqual(manifestStore.manifests);
    expect(json.active_manifest).toEqual(manifestStore.active_manifest);
  });

  it("should read from manifest data and file", async () => {
    const manifestData = await fs.readFile(
      "./tests/fixtures/CA/manifest_data.c2pa",
    );
    const reader = await Reader.fromManifestDataAndAsset(manifestData, {
      path: "./tests/fixtures/CA.jpg",
    });
    const json = reader!.json();
    expect(json.manifests).toEqual(manifestStore.manifests);
    expect(json.validation_status![0].code).toEqual(
      "signingCredential.untrusted",
    );
  });

  it("should read from manifest data and file with settings context", async () => {
    const manifestData = await fs.readFile(
      "./tests/fixtures/CA/manifest_data.c2pa",
    );
    const buffer = await fs.readFile("./tests/fixtures/CA.jpg");

    const settings = {
      verify: {
        verify_after_reading: false,
        verify_trust: false,
      },
    };

    const reader = await Reader.fromManifestDataAndAsset(
      manifestData,
      {
        buffer,
        mimeType: "jpeg",
      },
      settings,
    );

    expect(reader).not.toBeNull();
    const json = reader!.json();

    // Settings should affect validation behavior
    // With verify_after_reading: false, validation_status should be undefined
    expect(json.validation_status).toBeUndefined();

    expect(json.manifests).toBeDefined();
    expect(json.active_manifest).toEqual(manifestStore.active_manifest);
  });

  it("should read from manifest data and file with a Context", async () => {
    const manifestData = await fs.readFile(
      "./tests/fixtures/CA/manifest_data.c2pa",
    );
    const buffer = await fs.readFile("./tests/fixtures/CA.jpg");

    const context = new Context({
      verify: {
        verifyAfterReading: false,
        verifyTrust: false,
      },
    });

    const reader = await Reader.fromManifestDataAndAsset(
      manifestData,
      {
        buffer,
        mimeType: "jpeg",
      },
      context,
    );

    expect(reader).not.toBeNull();
    const json = reader!.json();

    // Same effect as the raw-settings equivalent above: verifyAfterReading: false means
    // validation_status should be undefined.
    expect(json.validation_status).toBeUndefined();

    expect(json.manifests).toBeDefined();
    expect(json.active_manifest).toEqual(manifestStore.active_manifest);
  });

  it("should write to a file", async () => {
    const outputPath = path.join(tempDir, "thumbnail.jpg");
    const reader = await Reader.fromAsset({
      path: "./tests/fixtures/CA.jpg",
    });
    expect(reader).not.toBeNull();
    const activeManifest = reader!.getActive();
    const uri = activeManifest?.thumbnail?.identifier;

    expect(uri).toBeDefined();
    const bytesWritten = await reader!.resourceToAsset(uri!, {
      path: outputPath,
    });

    expect(bytesWritten.bytes_written).toBe(49690);
    expect(fs.existsSync(outputPath));
  });

  it("should report manifest is embedded", async () => {
    const reader = await Reader.fromAsset({
      path: "./tests/fixtures/CA.jpg",
    });
    expect(reader).not.toBeNull();
    expect(reader!.remoteUrl()).toEqual("");
    expect(reader!.isEmbedded()).toBeTruthy();
  });

  it("should report manifest is not embedded", async () => {
    const reader = await Reader.fromAsset({
      path: "./tests/fixtures/cloud.jpg",
    });
    expect(reader).not.toBeNull();
    expect(reader!.remoteUrl()).toEqual(
      "https://cai-manifests.adobe.com/manifests/adobe-urn-uuid-5f37e182-3687-462e-a7fb-573462780391",
    );
    expect(reader!.isEmbedded()).toBeFalsy();
  });

  it("should decode CAWG identity assertion with signature_info", async () => {
    // This test verifies that postValidateCawg() properly decodes CAWG assertions
    // and extracts signature_info from the signature data, matching c2pa-js behavior
    const reader = await Reader.fromAsset({
      path: "./tests/fixtures/C_with_CAWG_data.jpg",
    });
    expect(reader).not.toBeNull();

    const activeManifest = reader!.getActive();

    // Find the cawg.identity assertion
    const cawgIdentityAssertion = activeManifest?.assertions?.find(
      (assertion: any) => assertion.label === "cawg.identity",
    ) as any;

    expect(cawgIdentityAssertion).toBeDefined();
    expect(cawgIdentityAssertion?.data).toBeDefined();
    expect(cawgIdentityAssertion?.data.signature_info).toBeDefined();

    // Verify signature_info structure matches c2pa-js behavior
    const signatureInfo = cawgIdentityAssertion?.data.signature_info;
    const signerPayload = cawgIdentityAssertion?.data.signer_payload;

    // Verify signature_info values
    expect(signatureInfo.alg).toBe("Ed25519");
    expect(signatureInfo.issuer).toBe("C2PA Test Signing Cert");
    expect(signatureInfo.cert_serial_number).toBe(
      "638838410810235485828984295321338730070538954823",
    );
    expect(signatureInfo.revocation_status).toBe(true);

    // Verify signer_payload values
    expect(signerPayload.sig_type).toBe("cawg.x509.cose");
    expect(signerPayload.referenced_assertions).toHaveLength(2);
    expect(signerPayload.referenced_assertions[0]).toEqual({
      url: "self#jumbf=c2pa.assertions/cawg.training-mining",
      hash: "rBBgURB+/0Bc2Uk3+blNpYTGQTxOwzXQ2xhjA3gsqI4=",
    });
    expect(signerPayload.referenced_assertions[1]).toEqual({
      url: "self#jumbf=c2pa.assertions/c2pa.hash.data",
      hash: "sASozh9KFSkW+cyMI0Pw5KYoD2qn7MkUEq9jUUhe/sM=",
    });
  });

  it("should return null when reading an asset without C2PA metadata", async () => {
    // Create a simple JPEG without C2PA data
    const simpleJpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);

    const asset = {
      buffer: simpleJpeg,
      mimeType: "image/jpeg",
    };

    const reader = await Reader.fromAsset(asset);
    expect(reader).toBeNull();
  });

  describe("from a stream", () => {
    // A stream over an open file that counts its reads. `fs.read` has the shape a stream's
    // `read` takes, so it is passed straight through.
    async function fileStream(
      filePath: string,
      overrides: Partial<SourceStream> = {}
    ): Promise<{
      stream: SourceStream;
      reads: () => number;
      close: () => Promise<void>;
    }> {
      const fd = await fs.open(filePath, "r");
      const { size } = await fs.fstat(fd);
      let reads = 0;
      const stream: SourceStream = {
        size,
        read(buffer, offset, length, position, callback) {
          reads++;
          fs.read(fd, buffer, offset, length, position, callback);
        },
        ...overrides,
      };
      return { stream, reads: () => reads, close: () => fs.close(fd) };
    }

    it("should read the same manifest store as from a file", async () => {
      const { stream, close } = await fileStream("./tests/fixtures/CA.jpg");
      try {
        const reader = await Reader.fromAsset({
          stream,
          mimeType: "image/jpeg",
        });
        expect(reader).not.toBeNull();

        const json = reader!.json();
        expect(json.manifests).toEqual(manifestStore.manifests);
        expect(json.active_manifest).toEqual(manifestStore.active_manifest);
      } finally {
        await close();
      }
    });

    it("should read across many blocks with a small buffer", async () => {
      const { stream, reads, close } = await fileStream(
        "./tests/fixtures/CA.jpg",
        {
          bufferSize: 64,
        }
      );
      try {
        const reader = await Reader.fromAsset({ stream });
        const json = reader!.json();
        expect(json.manifests).toEqual(manifestStore.manifests);
        expect(reads()).toBeGreaterThan(1);
      } finally {
        await close();
      }
    });

    it("should read an asset smaller than the buffer in one call", async () => {
      const { stream, reads, close } = await fileStream(
        "./tests/fixtures/CA.jpg"
      );
      try {
        await Reader.fromAsset({ stream, mimeType: "image/jpeg" });
        expect(reads()).toBe(1);
      } finally {
        await close();
      }
    });

    it("should return null for a stream without C2PA data", async () => {
      const { stream, close } = await fileStream("./tests/fixtures/A.jpg");
      try {
        expect(
          await Reader.fromAsset({ stream, mimeType: "image/jpeg" })
        ).toBeNull();
      } finally {
        await close();
      }
    });

    it("should read from manifest data and a stream", async () => {
      const manifestData = await fs.readFile(
        "./tests/fixtures/CA/manifest_data.c2pa"
      );
      const { stream, close } = await fileStream("./tests/fixtures/CA.jpg");
      try {
        const reader = await Reader.fromManifestDataAndAsset(manifestData, {
          stream,
          mimeType: "jpeg",
        });
        const json = reader!.json();
        expect(json.manifests).toEqual(manifestStore.manifests);
        expect(json.validation_status![0].code).toEqual(
          "signingCredential.untrusted"
        );
      } finally {
        await close();
      }
    });

    it("should reject with the error a read calls back with", async () => {
      const stream: SourceStream = {
        size: 1000,
        read(_buffer, _offset, _length, _position, callback) {
          void Promise.resolve().then(() =>
            callback(new Error("range request failed"))
          );
        },
      };
      await expect(
        Reader.fromAsset({ stream, mimeType: "image/jpeg" })
      ).rejects.toThrow("range request failed");
    });

    it("should reject when a read throws", async () => {
      const stream: SourceStream = {
        size: 1000,
        read() {
          throw new Error("no connection");
        },
      };
      await expect(
        Reader.fromAsset({ stream, mimeType: "image/jpeg" })
      ).rejects.toThrow("no connection");
    });

    it("should reject when an error can't be turned into a message", async () => {
      const unprintable = {
        toString() {
          throw new Error("toString failed");
        },
      };
      const calledBack: SourceStream = {
        size: 1000,
        read(_buffer, _offset, _length, _position, callback) {
          callback(unprintable as unknown as Error);
        },
      };
      await expect(
        Reader.fromAsset({ stream: calledBack, mimeType: "image/jpeg" })
      ).rejects.toThrow("stream.read failed");

      const thrown: SourceStream = {
        size: 1000,
        read() {
          throw unprintable;
        },
      };
      await expect(
        Reader.fromAsset({ stream: thrown, mimeType: "image/jpeg" })
      ).rejects.toThrow("stream.read failed");
    });

    it("should reject a read that reports an impossible number of bytes", async () => {
      for (const bytesRead of [-1, 1.5, NaN, 1001, undefined]) {
        const stream: SourceStream = {
          size: 1000,
          read(_buffer, _offset, _length, _position, callback) {
            callback(null, bytesRead as number);
          },
        };
        await expect(
          Reader.fromAsset({ stream, mimeType: "image/jpeg" })
        ).rejects.toThrow("bytes read of 1000 asked for");
      }
    });

    it("should reject when a read drops its callback without calling it", async () => {
      setFlagsFromString("--expose-gc");
      const gc = runInNewContext("gc") as () => void;
      const stream: SourceStream = { size: 1000, read() {} };
      const settled = Reader.fromAsset({ stream, mimeType: "image/jpeg" }).then(
        () => undefined,
        (err: Error) => err
      );
      // A collection may take a few turns of the event loop to free the callback.
      let err: Error | undefined;
      for (let i = 0; i < 50 && !err; i++) {
        gc();
        err = await Promise.race([settled, setTimeout(10, undefined)]);
      }
      expect(err?.message).toContain(
        "stream.read was dropped without calling back"
      );
    });

    it("should ignore a second callback for the same read", async () => {
      const { stream, close } = await fileStream("./tests/fixtures/CA.jpg", {
        bufferSize: 64,
      });
      const read = stream.read;
      stream.read = (buffer, offset, length, position, callback) =>
        read(buffer, offset, length, position, (err, bytesRead) => {
          callback(err, bytesRead);
          callback(null, 0);
        });
      try {
        const reader = await Reader.fromAsset({ stream });
        expect(reader!.json().manifests).toEqual(manifestStore.manifests);
      } finally {
        await close();
      }
    });

    it("should check the declared size before reading", async () => {
      let reads = 0;
      const stream: SourceStream = {
        size: MAX_SIZE_IN_BYTES + 1,
        read() {
          reads++;
        },
      };
      await expect(Reader.fromAsset({ stream })).rejects.toThrow(
        AssetTooLargeError
      );
      expect(reads).toBe(0);
    });

    it("should reject an invalid size or buffer size", async () => {
      const read = () => {};
      await expect(
        Reader.fromAsset({ stream: { size: -1, read } })
      ).rejects.toThrow(RangeError);
      await expect(
        Reader.fromAsset({ stream: { size: 10, read, bufferSize: 0 } })
      ).rejects.toThrow(RangeError);
    });

    it("should not be accepted where it would be read on the JavaScript thread", async () => {
      const builder = await Builder.newAsync();
      const stream: SourceStream = { size: 10, read() {} };
      await expect(
        builder.addResource("thumbnail.jpg", { stream } as never)
      ).rejects.toThrow("A stream asset can only be read with Reader");
    });
  });
});
