import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
  projectBindings,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";

/**
 * WIR-1211 (T9b): under `enforce` a Sales-only operator gets 200 from
 * heartbeat-runs and live-runs with the runs of Delivery-bound (or
 * Delivery-leading) agents omitted, instead of every run in the company. The
 * owner and unbound agents' runs are unchanged, and `off` / `shadow` narrow nothing.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat-runs and live-runs honour project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runs-routes-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function actorFor(companyId: string, userId: string, membershipRole: string): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole }],
    } as Express.Request["actor"];
  }

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", agentRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function insertAgent(companyId: string, name: string) {
    const [row] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return row!;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Run visibility ${randomUUID()}`,
      issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();

    const unbound = await insertAgent(companyId, "UnboundWorker");
    const salesBound = await insertAgent(companyId, "SalesBound");
    const deliveryBound = await insertAgent(companyId, "DeliveryBound");
    const deliveryLead = await insertAgent(companyId, "DeliveryLead");
    const mixedBound = await insertAgent(companyId, "MixedBound");

    const [salesProject] = await db.insert(projects).values({
      companyId,
      name: "Sales project",
      categoryId: sales!.id,
    }).returning();
    const [deliveryProject] = await db.insert(projects).values({
      companyId,
      name: "Delivery project",
      categoryId: delivery!.id,
      leadAgentId: deliveryLead.id,
    }).returning();

    const bind = (agentId: string, projectId: string) => ({
      companyId,
      projectId,
      targetType: "agent" as const,
      targetId: agentId,
      createdByUserId: "tester",
    });
    await db.insert(projectBindings).values([
      bind(salesBound.id, salesProject!.id),
      bind(deliveryBound.id, deliveryProject!.id),
      bind(mixedBound.id, salesProject!.id),
      bind(mixedBound.id, deliveryProject!.id),
    ]);

    const ownerId = `user-${randomUUID()}`;
    const salesOperatorId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: salesOperatorId, status: "active", membershipRole: "operator" },
    ]);
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: salesOperatorId,
      permissionKey: "projects:access",
      scope: { categoryIds: [sales!.id] },
      grantedByUserId: null,
    });

    // The two hidden agents own the newest runs so a limit applied before the
    // visibility filter would return fewer than `limit` visible rows.
    const base = new Date("2026-04-10T10:00:00.000Z").getTime();
    const runsByAgent: Array<[typeof unbound, string, number]> = [
      [unbound, "running", 0],
      [salesBound, "succeeded", 1],
      [mixedBound, "queued", 2],
      [deliveryBound, "running", 3],
      [deliveryLead, "succeeded", 4],
      [deliveryBound, "queued", 5],
    ];
    const runIds = new Map<string, string[]>();
    for (const [agent, status, offset] of runsByAgent) {
      const id = randomUUID();
      runIds.set(agent.id, [...(runIds.get(agent.id) ?? []), id]);
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId: agent.id,
        status,
        contextSnapshot: { issueId: randomUUID() },
        createdAt: new Date(base + offset * 60_000),
      });
    }

    return {
      companyId,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      unbound,
      salesBound,
      deliveryBound,
      deliveryLead,
      mixedBound,
      hiddenAgentIds: [deliveryBound.id, deliveryLead.id],
      visibleAgentIds: [unbound.id, salesBound.id, mixedBound.id],
      runCountFor: (...agentIds: string[]) => agentIds.reduce((sum, id) => sum + (runIds.get(id)?.length ?? 0), 0),
    };
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;

  const agentIdsOf = (body: Array<{ agentId: string }>) => [...new Set(body.map((run) => run.agentId))].sort();

  const ROUTES = [
    { label: "heartbeat-runs", path: "heartbeat-runs?limit=100" },
    { label: "heartbeat-runs summary", path: "heartbeat-runs?limit=100&summary=true" },
    { label: "live-runs", path: "live-runs?minCount=50" },
    { label: "live-runs distinctTasks", path: "live-runs?distinctTasks=true" },
  ];

  for (const route of ROUTES) {
    it(`${route.label}: 200 with hidden agents' runs omitted for a Sales-only operator`, async () => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
      const fixture = await seed();

      const res = await request(app(fixture.salesOperator)).get(`/api/companies/${fixture.companyId}/${route.path}`);
      expect(res.status, res.text).toBe(200);
      expect(agentIdsOf(res.body)).toEqual([...fixture.visibleAgentIds].sort());
      expect(res.body).toHaveLength(fixture.runCountFor(...fixture.visibleAgentIds));
      for (const hiddenId of fixture.hiddenAgentIds) expect(res.text).not.toContain(hiddenId);
      expect(res.text).not.toContain(fixture.deliveryBound.name);
      expect(res.text).not.toContain(fixture.deliveryLead.name);
    });

    it(`${route.label}: the owner still sees every run`, async () => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
      const fixture = await seed();

      const res = await request(app(fixture.owner)).get(`/api/companies/${fixture.companyId}/${route.path}`);
      expect(res.status, res.text).toBe(200);
      expect(agentIdsOf(res.body)).toEqual([...fixture.visibleAgentIds, ...fixture.hiddenAgentIds].sort());
      expect(res.body).toHaveLength(fixture.runCountFor(...fixture.visibleAgentIds, ...fixture.hiddenAgentIds));
    });

    for (const mode of ["off", "shadow"]) {
      it(`${route.label}: ${mode} mode narrows nothing for a Sales-only operator`, async () => {
        vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
        const fixture = await seed();

        const res = await request(app(fixture.salesOperator)).get(`/api/companies/${fixture.companyId}/${route.path}`);
        expect(res.status, res.text).toBe(200);
        expect(agentIdsOf(res.body)).toEqual([...fixture.visibleAgentIds, ...fixture.hiddenAgentIds].sort());
      });
    }
  }

  it("heartbeat-runs applies visibility before the limit, so hidden runs do not eat the page", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    const res = await request(app(fixture.salesOperator)).get(`/api/companies/${fixture.companyId}/heartbeat-runs?limit=2`);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(agentIdsOf(res.body)).toEqual([fixture.salesBound.id, fixture.mixedBound.id].sort());
  });

  it("heartbeat-runs latestFailuresOnly never surfaces a hidden agent's failed run", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    await db.insert(heartbeatRuns).values([
      { companyId: fixture.companyId, agentId: fixture.deliveryBound.id, status: "failed", createdAt: new Date("2026-04-11T10:00:00.000Z") },
      { companyId: fixture.companyId, agentId: fixture.salesBound.id, status: "failed", createdAt: new Date("2026-04-11T09:00:00.000Z") },
    ]);

    const path = `/api/companies/${fixture.companyId}/heartbeat-runs?latestFailuresOnly=true&summary=true&limit=200`;
    const operator = await request(app(fixture.salesOperator)).get(path);
    expect(operator.status, operator.text).toBe(200);
    expect(agentIdsOf(operator.body)).toEqual([fixture.salesBound.id]);
    expect(operator.text).not.toContain(fixture.deliveryBound.id);

    const owner = await request(app(fixture.owner)).get(path);
    expect(agentIdsOf(owner.body)).toEqual([fixture.deliveryBound.id, fixture.salesBound.id].sort());
  });

  it("heartbeat-runs returns an empty 200 for a restricted operator whose grant sees no project", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: fixture.companyId, principalType: "user", principalId: userId,
      permissionKey: "projects:access", scope: { projectIds: [randomUUID()] }, grantedByUserId: null,
    });

    const res = await request(app(actorFor(fixture.companyId, userId, "operator")))
      .get(`/api/companies/${fixture.companyId}/heartbeat-runs?limit=100`);
    expect(res.status, res.text).toBe(200);
    // Only the unbound agent is visible: bound and led agents all belong to projects this grant cannot see.
    expect(agentIdsOf(res.body)).toEqual([fixture.unbound.id]);
  });

  it("heartbeat-runs filtered by a hidden agent id is an empty 200, not a 403 or its runs", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    const res = await request(app(fixture.salesOperator))
      .get(`/api/companies/${fixture.companyId}/heartbeat-runs?agentId=${fixture.deliveryBound.id}`);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual([]);

    const visible = await request(app(fixture.salesOperator))
      .get(`/api/companies/${fixture.companyId}/heartbeat-runs?agentId=${fixture.mixedBound.id}`);
    expect(visible.status, visible.text).toBe(200);
    expect(visible.body).toHaveLength(1);
  });

  it("applies the same filtering to a cloud_tenant member as to a session operator", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const tenant = { ...fixture.salesOperator, source: "cloud_tenant" } as Express.Request["actor"];

    for (const route of ROUTES) {
      const res = await request(app(tenant)).get(`/api/companies/${fixture.companyId}/${route.path}`);
      expect(res.status, `${route.label}: ${res.text}`).toBe(200);
      expect(agentIdsOf(res.body), route.label).toEqual([...fixture.visibleAgentIds].sort());
    }
  });
});
