"use strict";

process.env.SECRET_MANAGER = process.env.SECRET_MANAGER || "db";
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY || "test-secret-encryption-key-32bytes-minimum";

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderAdapter, renderClient } = require("../dist/cloud/hosts/render.js");
const { railwayAdapter, railwayClient } = require("../dist/cloud/hosts/railway.js");
const { awsAdapter, awsCfn } = require("../dist/cloud/hosts/aws.js");
const { hostPollDefaults } = require("../dist/cloud/hosts/poll.js");
const { assertPublicServiceUrl } = require("../dist/cloud/cloudStackEnv.js");

const env = {
  DATABASE_URL: "postgresql://u:p@db/veralux",
  REDIS_URL: "redis://r:6379",
  VERALUX_WEBHOOK_URL: "https://rt.example.com/v1/telnyx/webhook",
  PUBLIC_BASE_URL: "https://ctrl.example.com",
  JWT_SECRET: "jwt",
  ADMIN_API_KEY: "vl_admin",
  SECRET_ENCRYPTION_KEY: "sek",
  MEDIA_STREAM_TOKEN: "mst",
};

test.beforeEach(() => {
  hostPollDefaults.attempts = 2;
  hostPollDefaults.delayMs = 1;
});

test.afterEach(() => {
  hostPollDefaults.attempts = 90;
  hostPollDefaults.delayMs = 8000;
});

test("render inject PUT includes DATABASE_URL and webhook; guessed hostnames are forbidden", async () => {
  const calls = [];
  const prev = renderClient.fetch;
  renderClient.fetch = async (path, init = {}) => {
    calls.push({ path, method: init.method || "GET", body: init.body });
    if (path === "/postgres") return { id: "pg1" };
    if (path === "/key-value") return { id: "kv1" };
    if (path === "/services") {
      const name = JSON.parse(init.body).name;
      return { service: { id: name.includes("control") ? "svc-ctrl" : "svc-rt" } };
    }
    if (path === "/postgres/pg1/connection-info") return { internalConnectionString: env.DATABASE_URL };
    if (path === "/key-value/kv1") return { internalConnectionString: env.REDIS_URL };
    if (path === "/services/svc-ctrl") return { service: { serviceDetails: { url: "https://ctrl.onrender.com" } } };
    if (path === "/services/svc-rt") return { service: { serviceDetails: { url: "https://rt.onrender.com" } } };
    if (String(path).includes("/env-vars")) return {};
    if (String(path).includes("/deploys")) return {};
    throw new Error(`unexpected_render ${path}`);
  };
  try {
    const created = await renderAdapter.provision({
      tenantId: "shop-a",
      size: "starter",
      imageRegistry: "ghcr.io/nick-veraluxai",
      imageVersion: "0.1.0",
      onStep: async () => {},
    });
    assert.equal(created.handles.controlUrl, undefined);
    const resolved = await renderAdapter.resolveConnection(created.handles);
    assert.equal(resolved.controlUrl, "https://ctrl.onrender.com");
    await renderAdapter.injectEnv(resolved.handles, env);
    const envPuts = calls.filter((c) => String(c.path).includes("/env-vars"));
    assert.equal(envPuts.length, 2);
    for (const put of envPuts) {
      const body = JSON.parse(put.body);
      const keys = body.map((row) => row.key);
      assert.ok(keys.includes("DATABASE_URL"));
      assert.ok(keys.includes("VERALUX_WEBHOOK_URL"));
      assert.equal(body.find((row) => row.key === "DATABASE_URL").value, env.DATABASE_URL);
    }
  } finally {
    renderClient.fetch = prev;
  }
});

test("render resolveConnection does not invent a hostname when the API omits url", async () => {
  const prev = renderClient.fetch;
  renderClient.fetch = async (path) => {
    if (path === "/postgres/pg1/connection-info") return { internalConnectionString: env.DATABASE_URL };
    if (path === "/key-value/kv1") return { internalConnectionString: env.REDIS_URL };
    if (path.startsWith("/services/")) return { service: { serviceDetails: {} } };
    return {};
  };
  try {
    await assert.rejects(
      () => renderAdapter.resolveConnection({
        postgresId: "pg1",
        redisId: "kv1",
        controlId: "svc-ctrl",
        runtimeId: "svc-rt",
      }),
      /render_control_url_timeout|control_url_missing/,
    );
  } finally {
    renderClient.fetch = prev;
  }
});

test("railway creates images and fails when domain or variables are missing", async () => {
  const prev = railwayClient.gql;
  let mode = "happy";
  railwayClient.gql = async (query, variables = {}) => {
    if (query.includes("projectCreate")) return { projectCreate: { id: "proj1" } };
    if (query.includes("environments")) return { project: { environments: { edges: [{ node: { id: "env1" } }] } } };
    if (query.includes("pluginCreate")) return { pluginCreate: { id: variables.name.includes("redis") ? "redis1" : "pg1" } };
    if (query.includes("serviceCreate")) {
      if (mode === "no-image") return { serviceCreate: {} };
      return { serviceCreate: { id: variables.name.includes("control") ? "svc-ctrl" : "svc-rt" } };
    }
    if (query.includes("variables(")) {
      if (mode === "no-vars") return { variables: {} };
      return { variables: { DATABASE_URL: env.DATABASE_URL, REDIS_URL: env.REDIS_URL } };
    }
    if (query.includes("serviceDomainCreate")) {
      if (mode === "no-domain") return { serviceDomainCreate: { domain: {} } };
      return { serviceDomainCreate: { domain: { domain: variables.serviceId === "svc-ctrl" ? "ctrl.up.railway.app" : "rt.up.railway.app" } } };
    }
    if (query.includes("variableCollectionUpsert")) return { variableCollectionUpsert: true };
    if (query.includes("projectDelete")) return { projectDelete: true };
    throw new Error(`unexpected_railway ${query}`);
  };
  try {
    const created = await railwayAdapter.provision({
      tenantId: "shop-a",
      size: "hobby",
      imageRegistry: "ghcr.io/nick-veraluxai",
      imageVersion: "0.1.0",
      onStep: async () => {},
    });
    const resolved = await railwayAdapter.resolveConnection(created.handles);
    assert.equal(resolved.controlUrl, "https://ctrl.up.railway.app");
    await railwayAdapter.injectEnv(resolved.handles, env);

    mode = "no-image";
    await assert.rejects(
      () => railwayAdapter.provision({
        tenantId: "shop-b",
        size: "hobby",
        imageRegistry: "ghcr.io/nick-veraluxai",
        imageVersion: "0.1.0",
      }),
      /railway_control_create_failed/,
    );

    mode = "no-domain";
    await assert.rejects(
      () => railwayAdapter.resolveConnection(created.handles),
      /railway_control_domain_timeout|control_url/,
    );

    mode = "no-vars";
    await assert.rejects(
      () => railwayAdapter.resolveConnection(created.handles),
      /railway_connection_strings_missing|railway_variables_timeout/,
    );
  } finally {
    railwayClient.gql = prev;
  }
});

test("aws provision does not invent App Runner urls and teardown deletes the stack", async () => {
  const prevCreate = awsCfn.createStack;
  const prevDescribe = awsCfn.describeOutputs;
  const prevUpdate = awsCfn.updateStack;
  const prevDelete = awsCfn.deleteStack;
  let deleted = 0;
  awsCfn.createStack = async () => {};
  awsCfn.describeOutputs = async () => ({
    ControlUrl: "http://ctrl-alb.amazonaws.com",
    RuntimeUrl: "http://rt-alb.amazonaws.com",
    DatabaseUrl: env.DATABASE_URL,
    RedisUrl: env.REDIS_URL,
  });
  awsCfn.updateStack = async () => {};
  awsCfn.deleteStack = async () => { deleted += 1; };
  const prevKey = process.env.AWS_ACCESS_KEY_ID;
  const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
  process.env.AWS_SECRET_ACCESS_KEY = "secret";
  try {
    const created = await awsAdapter.provision({
      tenantId: "shop-a",
      size: "fargate_small",
      imageRegistry: "ghcr.io/nick-veraluxai",
      imageVersion: "0.1.0",
      onStep: async () => {},
    });
    assert.equal(created.controlUrl, undefined);
    assert.equal(JSON.stringify(created.handles).includes("awsapprunner.com"), false);
    const resolved = await awsAdapter.resolveConnection(created.handles);
    assert.equal(resolved.controlUrl, "http://ctrl-alb.amazonaws.com");
    await awsAdapter.injectEnv(resolved.handles, env);
    await awsAdapter.teardown(created.handles);
    assert.equal(deleted, 1);
    assert.throws(() => assertPublicServiceUrl("https://shop.awsapprunner.com", "control"), /invented/);
  } finally {
    awsCfn.createStack = prevCreate;
    awsCfn.describeOutputs = prevDescribe;
    awsCfn.updateStack = prevUpdate;
    awsCfn.deleteStack = prevDelete;
    if (prevKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = prevKey;
    if (prevSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
  }
});
