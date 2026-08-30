import "dotenv/config";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import app from "./app";

let server: ReturnType<typeof app.listen>;
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("API foundation", () => {
  it("returns 200 from the liveness endpoint", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.service, "osu-fleet-api");
    assert.ok(response.headers.get("x-request-id"));
  });

  it("returns JSON 404 for an unknown route", async () => {
    const response = await fetch(`${baseUrl}/route-does-not-exist`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.message, "Route not found");
    assert.equal(body.path, "/route-does-not-exist");
  });
});