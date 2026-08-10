/**
 * End-to-end check of hydra-server's Cloud Save V2 implementation, validated
 * with the launcher's OWN response validators so a shape mismatch fails here
 * exactly as it would fail in the app.
 *
 * Expects the server on 127.0.0.1:8799 with the stub official API on 9911.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  validateRemoteSnapshotSummary,
  validateRestoreManifest,
} from "./cloud-save-contract.js";
import { validatePrepareResponse } from "./upload-local-game-snapshot-helpers.js";

const BASE = "http://127.0.0.1:8799";
const USER = "user-1";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

const api = async (
  method: string,
  path: string,
  body?: unknown,
  user = USER
) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${user}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
};

/* A save with two distinct blobs, where the second blob is referenced by two
   different file identities — the dedup case the launcher relies on. */
const CONTENT_A = "save slot one\n";
const CONTENT_B = "shared config\n";
const HASH_A = sha256(CONTENT_A);
const HASH_B = sha256(CONTENT_B);
const VARIANT_ID = sha256("default-variant");

const FILES = [
  {
    variantId: VARIANT_ID,
    rawPath: "<gameDir>",
    relativePath: "slot1.sav",
    hash: HASH_A,
    sizeBytes: Buffer.byteLength(CONTENT_A),
    lastModifiedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    variantId: VARIANT_ID,
    rawPath: "<gameDir>",
    relativePath: "config.ini",
    hash: HASH_B,
    sizeBytes: Buffer.byteLength(CONTENT_B),
    lastModifiedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    variantId: VARIANT_ID,
    rawPath: "<appData>",
    relativePath: "config.ini",
    hash: HASH_B,
    sizeBytes: Buffer.byteLength(CONTENT_B),
    lastModifiedAt: "2026-08-01T10:00:00.000Z",
  },
];

const VARIANTS = [{ variantId: VARIANT_ID, kind: "default" }];
const AGGREGATE = sha256("aggregate-v1");
const GAME = { shop: "steam", objectId: "440" };

const bodyByHash: Record<string, string> = {
  [HASH_A]: CONTENT_A,
  [HASH_B]: CONTENT_B,
};

const preparePayload = (baseVersion: number, snapshotHash = AGGREGATE) => ({
  ...GAME,
  platform: "windows",
  hostname: "test-host",
  snapshotHash,
  baseVersion,
  customPathRawPaths: [],
  variants: VARIANTS,
  files: FILES,
});

/** Uploads a blob exactly the way the launcher's native addon does. */
const putBlob = async (uploadUrl: string, content: string, checksum: string) =>
  fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(Buffer.byteLength(content)),
      "x-amz-checksum-sha256": checksum,
    },
    body: content,
  });

let snapshotId = "";

test("prepare-snapshot response passes the launcher's validator", async () => {
  const { status, body } = await api(
    "POST",
    "/profile/cloud-saves/prepare-snapshot",
    preparePayload(0)
  );
  assert.equal(status, 200);

  // Throws if any key set / header shape is wrong.
  const prepared = validatePrepareResponse(body);

  assert.equal(prepared.snapshotHash, AGGREGATE);
  assert.equal(prepared.files.length, FILES.length);
  assert.ok(prepared.files.every((file) => file.status === "upload"));

  for (const file of prepared.files) {
    if (file.status !== "upload") continue;
    const proposal = FILES.find(
      (candidate) =>
        candidate.variantId === file.variantId &&
        candidate.rawPath === file.rawPath &&
        candidate.relativePath === file.relativePath
    );
    assert.ok(proposal, "response file must map to a proposal file");
    assert.equal(
      file.requiredHeaders["Content-Length"],
      String(proposal.sizeBytes)
    );
    assert.equal(
      file.requiredHeaders["x-amz-checksum-sha256"],
      b64(proposal.hash),
      "checksum header must be base64 of the raw digest"
    );
  }

  /* Both identities sharing HASH_B must point at the same object, so
     uploading once satisfies both. */
  const sharedUrls = new Set(
    prepared.files
      .filter((f) => f.status === "upload" && f.relativePath === "config.ini")
      .map((f) => (f.status === "upload" ? f.uploadUrl : ""))
  );
  assert.equal(sharedUrls.size, 1, "identical blobs share one upload URL");

  // Upload each distinct blob once, then commit.
  const seen = new Set<string>();
  for (const file of prepared.files) {
    if (file.status !== "upload") continue;
    const checksum = file.requiredHeaders["x-amz-checksum-sha256"];
    if (seen.has(checksum)) continue;
    seen.add(checksum);
    const content = bodyByHash[
      Buffer.from(checksum, "base64").toString("hex")
    ];
    const response = await putBlob(file.uploadUrl, content, checksum);
    assert.equal(response.status, 200, "blob upload should succeed");
  }

  const commit = await api("POST", "/profile/cloud-saves/commit-snapshot", {
    pendingSnapshotId: prepared.pendingSnapshotId,
  });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.version, 1);
  assert.equal(commit.body.fileCount, FILES.length);
  assert.equal(commit.body.aggregateHash, AGGREGATE);
  snapshotId = commit.body.snapshotId;
});

test("snapshots list passes the launcher's summary validator", async () => {
  const { status, body } = await api(
    "GET",
    `/profile/cloud-saves/snapshots?shop=${GAME.shop}&objectId=${GAME.objectId}`
  );
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);

  const summary = validateRemoteSnapshotSummary(body[0]);
  assert.equal(summary.version, 1);
  assert.equal(summary.fileCount, FILES.length);
  assert.equal(summary.aggregateHash, AGGREGATE);
});

test("restore manifest passes the launcher's validator", async () => {
  const { status, body } = await api(
    "GET",
    `/profile/cloud-saves/snapshot-restore-manifest?snapshotId=${snapshotId}`
  );
  assert.equal(status, 200);

  const manifest = validateRestoreManifest(body);
  assert.equal(manifest.snapshot.id, snapshotId);
  assert.equal(manifest.snapshot.shop, "steam");
  assert.equal(manifest.snapshot.objectId, "440");
  assert.equal(manifest.files.length, FILES.length);
  assert.equal(manifest.variants.length, 1);
});

test("download URLs return the exact bytes that were uploaded", async () => {
  const { status, body } = await api(
    "GET",
    `/profile/cloud-saves/snapshot-download-urls?snapshotId=${snapshotId}`
  );
  assert.equal(status, 200);
  assert.equal(body.length, FILES.length);

  for (const file of body) {
    // The launcher asserts exactly seven keys on each entry.
    assert.equal(Object.keys(file).length, 7, "entry must have 7 keys");
    const response = await fetch(file.downloadUrl);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(sha256(text), file.hash, "downloaded bytes must match hash");
  }
});

test("re-uploading unchanged files skips them", async () => {
  const { status, body } = await api(
    "POST",
    "/profile/cloud-saves/prepare-snapshot",
    preparePayload(1, sha256("aggregate-v2"))
  );
  assert.equal(status, 200);
  const prepared = validatePrepareResponse(body);
  assert.ok(
    prepared.files.every((file) => file.status === "skip"),
    "already-stored blobs must come back as skip"
  );
});

test("a stale baseVersion is rejected instead of clobbering", async () => {
  const { status, body } = await api(
    "POST",
    "/profile/cloud-saves/prepare-snapshot",
    preparePayload(0)
  );
  assert.equal(status, 409, "stale upload must conflict");
  assert.match(String(body.message), /another device/i);
});

test("one user cannot read another user's snapshot", async () => {
  const manifest = await api(
    "GET",
    `/profile/cloud-saves/snapshot-restore-manifest?snapshotId=${snapshotId}`,
    undefined,
    "user-2"
  );
  assert.equal(manifest.status, 404);

  const list = await api(
    "GET",
    `/profile/cloud-saves/snapshots?shop=${GAME.shop}&objectId=${GAME.objectId}`,
    undefined,
    "user-2"
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 0);
});

test("an invalid token is rejected", async () => {
  const { status } = await api("GET", "/profile/cloud-saves/snapshots?shop=steam&objectId=440", undefined, "bad");
  assert.equal(status, 401);
});

test("blob upload rejects bytes that do not match the declared hash", async () => {
  const { body } = await api(
    "POST",
    "/profile/cloud-saves/prepare-snapshot",
    {
      ...preparePayload(1, sha256("aggregate-v3")),
      files: [
        {
          variantId: VARIANT_ID,
          rawPath: "<gameDir>",
          relativePath: "tampered.sav",
          hash: sha256("expected content"),
          sizeBytes: Buffer.byteLength("wrong content!!!"),
          lastModifiedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    }
  );
  const prepared = validatePrepareResponse(body);
  const file = prepared.files[0];
  assert.equal(file.status, "upload");
  if (file.status !== "upload") return;

  const response = await putBlob(
    file.uploadUrl,
    "wrong content!!!",
    file.requiredHeaders["x-amz-checksum-sha256"]
  );
  assert.equal(response.status, 400, "hash mismatch must be refused");
});

test("commit fails when a blob was never uploaded", async () => {
  const { body } = await api("POST", "/profile/cloud-saves/prepare-snapshot", {
    ...preparePayload(1, sha256("aggregate-v4")),
    files: [
      {
        variantId: VARIANT_ID,
        rawPath: "<gameDir>",
        relativePath: "missing.sav",
        hash: sha256("never uploaded"),
        sizeBytes: 14,
        lastModifiedAt: "2026-08-01T10:00:00.000Z",
      },
    ],
  });
  const prepared = validatePrepareResponse(body);
  const commit = await api("POST", "/profile/cloud-saves/commit-snapshot", {
    pendingSnapshotId: prepared.pendingSnapshotId,
  });
  assert.equal(commit.status, 400);
});

test("delete removes the save and frees its blobs", async () => {
  const remove = await api(
    "DELETE",
    `/profile/cloud-saves/snapshots?shop=${GAME.shop}&objectId=${GAME.objectId}`
  );
  assert.equal(remove.status, 204);

  const list = await api(
    "GET",
    `/profile/cloud-saves/snapshots?shop=${GAME.shop}&objectId=${GAME.objectId}`
  );
  assert.equal(list.body.length, 0);

  /* With the manifest gone the blobs are orphaned, so a fresh upload must ask
     for them again rather than reporting skip. */
  const fresh = await api(
    "POST",
    "/profile/cloud-saves/prepare-snapshot",
    preparePayload(0)
  );
  const prepared = validatePrepareResponse(fresh.body);
  assert.ok(
    prepared.files.every((file) => file.status === "upload"),
    "garbage-collected blobs must be requested again"
  );
});
