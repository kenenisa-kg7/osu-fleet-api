import "dotenv/config";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import app from "./app";
import { pool } from "./db";

let server: ReturnType<typeof app.listen>;
let baseUrl: string;
const testEmail = `lesson-8m-${Date.now()}@example.com`;
const testPassword = "Password123!";
let token: string;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await pool.query("DELETE FROM users WHERE email = $1", [testEmail]);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("authentication", () => {
  it("registers a test user", async () => {
    const response = await post("/auth/register", {
      name: "Lesson Test User",
      email: testEmail,
      password: testPassword,
      role: "staff",
    });

    assert.equal(response.status, 201);
  });

  it("logs in and returns a JWT", async () => {
    const response = await post("/auth/login", {
      email: testEmail,
      password: testPassword,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.message, "Login successful");
    assert.equal(typeof body.token, "string");
    token = body.token;
  });

  it("returns the current user for a valid JWT", async () => {
    const response = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.user.email, testEmail);
    assert.equal("password_hash" in body.user, false);
  });

  it("rejects the protected route without a JWT", async () => {
    const response = await fetch(`${baseUrl}/admin/fleet-summary`);
    assert.equal(response.status, 401);
  });

  it("allows staff to access the fleet summary", async () => {
    const response = await fetch(`${baseUrl}/admin/fleet-summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
  });
});