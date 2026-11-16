import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
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
import { renderOrgChartPng } from "../routes/org-chart-svg.js";
import { agentService } from "../services/agents.js";
import { UNRESTRICTED_PROJECT_VISIBILITY } from "../services/project-visibility.js";

/**
 * WIR-1212 (T9c): org.svg and org.png render the same dropped-subtree org as
 * /org, without error, and the owner's rendered bytes do not move.
 *
 * WIR-1210 (T9a): under `enforce` a Sales-only operator gets the same 404 for a
 * Delivery-bound (or Delivery-leading) agent's detail that a random id gets, the
 * agent is omitted from the list and /org, and the whole subtree below a hidden
 * agent is dropped from /org rather than re-parented. Unbound agents and the
 * owner see what they always saw.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type OrgNode = { id: string; name: string; reports: OrgNode[] };

describeEmbeddedPostgres("agent routes honour project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-routes-visibility-");
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

  async function insertAgent(companyId: string, name: string, reportsTo: string | null = null) {
    const [row] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo,
    }).returning();
    return row!;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Agent visibility ${randomUUID()}`,
      issuePrefix: `A${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();

    const boss = await insertAgent(companyId, "Boss");
    const unbound = await insertAgent(companyId, "UnboundWorker", boss.id);
    const salesBound = await insertAgent(companyId, "SalesBound", boss.id);
    const deliveryBound = await insertAgent(companyId, "DeliveryBound", boss.id);
    const deliveryChild = await insertAgent(companyId, "DeliveryChild", deliveryBound.id);
    const deliveryGrandchild = await insertAgent(companyId, "DeliveryGrandchild", deliveryChild.id);
    const deliveryLead = await insertAgent(companyId, "DeliveryLead", boss.id);
    const mixedBound = await insertAgent(companyId, "MixedBound", boss.id);
    const salesLead = await insertAgent(companyId, "SalesLead", boss.id);
    const secondSalesLead = await insertAgent(companyId, "SecondSalesLead", boss.id);

    const [salesProject] = await db.insert(projects).values({
      companyId,
      name: "Sales project",
      categoryId: sales!.id,
      leadAgentId: salesLead.id,
    }).returning();
    const [deliveryProject] = await db.insert(projects).values({
      companyId,
      name: "Delivery project",
      categoryId: delivery!.id,
      leadAgentId: deliveryLead.id,
    }).returning();
    // A project led by an agent that is also bound to Delivery: the union is {Delivery, Sales}.
    await db.insert(projects).values({
      companyId,
      name: "Second sales project",
      categoryId: sales!.id,
      leadAgentId: secondSalesLead.id,
    });

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
      bind(secondSalesLead.id, deliveryProject!.id),
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

    return {
      companyId,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      boss,
      unbound,
      salesBound,
      deliveryBound,
      deliveryChild,
      deliveryGrandchild,
      deliveryLead,
      mixedBound,
      salesLead,
      secondSalesLead,
    };
  }

  const ALL_NAMES = [
    "Boss",
    "DeliveryBound",
    "DeliveryChild",
    "DeliveryGrandchild",
    "DeliveryLead",
    "MixedBound",
    "SalesBound",
    "SalesLead",
    "SecondSalesLead",
    "UnboundWorker",
  ];
  const HIDDEN_FROM_SALES_LIST = ["DeliveryBound", "DeliveryLead"];
  const HIDDEN_NAMES_IN_SALES_ORG = [
    "DeliveryBound",
    "DeliveryChild",
    "DeliveryGrandchild",
    "DeliveryLead",
  ];

  async function listNames(actor: Express.Request["actor"], companyId: string) {
    const res = await request(app(actor)).get(`/api/companies/${companyId}/agents`);
    expect(res.status, res.text).toBe(200);
    return (res.body as Array<{ name: string }>).map((agent) => agent.name).sort();
  }

  function flatten(nodes: OrgNode[]): string[] {
    return nodes.flatMap((node) => [node.name, ...flatten(node.reports)]).sort();
  }

  it("omits Delivery agents from the list for a Sales-only operator, and nobody else's", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    expect(await listNames(fixture.salesOperator, fixture.companyId)).toEqual(
      ALL_NAMES.filter((name) => !HIDDEN_FROM_SALES_LIST.includes(name)),
    );
    expect(await listNames(fixture.owner, fixture.companyId)).toEqual(ALL_NAMES);
  });

  it("omits hidden agents from /agent-configurations for a Sales-only operator", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    const names = async (actor: Express.Request["actor"]) => {
      const res = await request(app(actor)).get(`/api/companies/${fixture.companyId}/agent-configurations`);
      expect(res.status, res.text).toBe(200);
      return (res.body as Array<{ name: string }>).map((agent) => agent.name).sort();
    };

    expect(await names(fixture.salesOperator)).toEqual(
      ALL_NAMES.filter((name) => !HIDDEN_FROM_SALES_LIST.includes(name)),
    );
    expect(await names(fixture.owner)).toEqual(ALL_NAMES);
  });

  it("404s a hidden agent's detail exactly like a random id, and 200s unbound and partly visible agents", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));
    const missing = await client.get(`/api/agents/${randomUUID()}`);
    expect(missing.status).toBe(404);

    for (const hidden of [fixture.deliveryBound, fixture.deliveryLead]) {
      const res = await client.get(`/api/agents/${hidden.id}`);
      expect(res.status, `${hidden.name}: ${res.text}`).toBe(404);
      expect(res.body, hidden.name).toEqual(missing.body);
    }

    for (const visible of [fixture.unbound, fixture.salesBound, fixture.mixedBound, fixture.salesLead, fixture.deliveryChild]) {
      const res = await client.get(`/api/agents/${visible.id}`);
      expect(res.status, `${visible.name}: ${res.text}`).toBe(200);
    }

    const ownerRes = await request(app(fixture.owner)).get(`/api/agents/${fixture.deliveryBound.id}`);
    expect(ownerRes.status, ownerRes.text).toBe(200);
  });

  it("applies the same filtering to a cloud_tenant member as to a session operator", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const cloudSales = { ...fixture.salesOperator, source: "cloud_tenant" } as Express.Request["actor"];
    const visibleNames = ALL_NAMES.filter((name) => !HIDDEN_FROM_SALES_LIST.includes(name));

    expect(await listNames(cloudSales, fixture.companyId)).toEqual(visibleNames);

    const configs = await request(app(cloudSales)).get(`/api/companies/${fixture.companyId}/agent-configurations`);
    expect(configs.status, configs.text).toBe(200);
    expect((configs.body as Array<{ name: string }>).map((agent) => agent.name).sort()).toEqual(visibleNames);

    const org = await request(app(cloudSales)).get(`/api/companies/${fixture.companyId}/org`);
    expect(org.status, org.text).toBe(200);
    expect(flatten(org.body as OrgNode[])).toEqual(
      ALL_NAMES.filter((name) => !HIDDEN_NAMES_IN_SALES_ORG.includes(name)),
    );
    const body = JSON.stringify(org.body);
    for (const hidden of [fixture.deliveryBound, fixture.deliveryChild, fixture.deliveryGrandchild, fixture.deliveryLead]) {
      expect(body).not.toContain(hidden.id);
    }

    const detail = await request(app(cloudSales)).get(`/api/agents/${fixture.deliveryBound.id}`);
    expect(detail.status, detail.text).toBe(404);
  });

  it("404s a hidden agent's sub-resources like a random id, for session and cloud_tenant operators", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const cloudSales = { ...fixture.salesOperator, source: "cloud_tenant" } as Express.Request["actor"];
    const paths = (id: string) => [
      `/api/agents/${id}/configuration`,
      `/api/agents/${id}/config-revisions`,
      `/api/agents/${id}/skills`,
    ];

    for (const actor of [fixture.salesOperator, cloudSales]) {
      const client = request(app(actor));
      const missing = paths(randomUUID());
      for (const [index, path] of paths(fixture.deliveryBound.id).entries()) {
        const res = await client.get(path);
        const random = await client.get(missing[index]!);
        expect(res.status, path).toBe(404);
        expect(res.body, path).toEqual(random.body);
      }
      for (const path of paths(fixture.salesBound.id).slice(0, 2)) {
        const res = await client.get(path);
        expect(res.status, path).not.toBe(404);
      }
    }

    const owner = await request(app(fixture.owner)).get(`/api/agents/${fixture.deliveryBound.id}/configuration`);
    expect(owner.status, owner.text).toBe(200);
  });

  it("drops a hidden agent's whole subtree from /org instead of re-parenting it", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    const res = await request(app(fixture.salesOperator)).get(`/api/companies/${fixture.companyId}/org`);
    expect(res.status, res.text).toBe(200);
    const tree = res.body as OrgNode[];
    expect(tree.map((node) => node.name)).toEqual(["Boss"]);
    expect(flatten(tree)).toEqual(
      ALL_NAMES.filter((name) => !HIDDEN_NAMES_IN_SALES_ORG.includes(name)),
    );

    const body = JSON.stringify(res.body);
    for (const hidden of [fixture.deliveryBound, fixture.deliveryChild, fixture.deliveryGrandchild, fixture.deliveryLead]) {
      expect(body).not.toContain(hidden.id);
      expect(body).not.toContain(hidden.name);
    }
  });

  async function fetchBinary(actor: Express.Request["actor"], path: string) {
    return request(app(actor))
      .get(path)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        response.on("end", () => done(null, Buffer.concat(chunks)));
      });
  }

  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("renders org.svg for a Sales-only operator without the hidden subtree", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    const res = await fetchBinary(fixture.salesOperator, `/api/companies/${fixture.companyId}/org.svg`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    const svg = (res.body as Buffer).toString("utf8");
    for (const hidden of HIDDEN_NAMES_IN_SALES_ORG) expect(svg).not.toContain(hidden);
    for (const visible of ALL_NAMES.filter((name) => !HIDDEN_NAMES_IN_SALES_ORG.includes(name))) {
      expect(svg).toContain(visible);
    }
  });

  it("renders org.png for a Sales-only operator from the same tree /org returns, not the owner's", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const path = `/api/companies/${fixture.companyId}/org.png`;

    const res = await fetchBinary(fixture.salesOperator, path);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    const png = res.body as Buffer;
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    // The image is a pure function of the tree, so equality with a render of the
    // visible /org tree proves no hidden node reached the renderer.
    const org = await request(app(fixture.salesOperator)).get(`/api/companies/${fixture.companyId}/org`);
    expect(org.status, org.text).toBe(200);
    expect(png.equals(await renderOrgChartPng(org.body))).toBe(true);

    const owner = await fetchBinary(fixture.owner, path);
    expect(owner.status).toBe(200);
    expect(png.equals(owner.body as Buffer)).toBe(false);
  });

  it("renders org.svg and org.png without error when every agent is hidden", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const [deliveryProject] = await db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.companyId, fixture.companyId), eq(projects.name, "Delivery project")));
    await db.insert(projectBindings).values({
      companyId: fixture.companyId,
      projectId: deliveryProject!.id,
      targetType: "agent",
      targetId: fixture.boss.id,
      createdByUserId: "tester",
    });

    const org = await request(app(fixture.salesOperator)).get(`/api/companies/${fixture.companyId}/org`);
    expect(org.status, org.text).toBe(200);
    expect(org.body).toEqual([]);

    const svg = await fetchBinary(fixture.salesOperator, `/api/companies/${fixture.companyId}/org.svg`);
    expect(svg.status).toBe(200);
    for (const name of ALL_NAMES) expect((svg.body as Buffer).toString("utf8")).not.toContain(name);

    const png = await fetchBinary(fixture.salesOperator, `/api/companies/${fixture.companyId}/org.png`);
    expect(png.status).toBe(200);
    expect((png.body as Buffer).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect((png.body as Buffer).equals(await renderOrgChartPng([]))).toBe(true);

    const ownerSvg = await fetchBinary(fixture.owner, `/api/companies/${fixture.companyId}/org.svg`);
    for (const name of ALL_NAMES) expect((ownerSvg.body as Buffer).toString("utf8")).toContain(name);
  });

  it("keeps the owner's org.svg and org.png byte-identical to the baseline with the mode off", async () => {
    const fixture = await seed();
    const svgPath = `/api/companies/${fixture.companyId}/org.svg`;
    const pngPath = `/api/companies/${fixture.companyId}/org.png`;

    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
    const baselineSvg = await fetchBinary(fixture.owner, svgPath);
    const baselinePng = await fetchBinary(fixture.owner, pngPath);
    expect(baselineSvg.status).toBe(200);
    expect(baselinePng.status).toBe(200);
    for (const name of ALL_NAMES) expect((baselineSvg.body as Buffer).toString("utf8")).toContain(name);

    for (const mode of ["shadow", "enforce"]) {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
      const svg = await fetchBinary(fixture.owner, svgPath);
      const png = await fetchBinary(fixture.owner, pngPath);
      expect(svg.status, mode).toBe(200);
      expect(png.status, mode).toBe(200);
      expect((svg.body as Buffer).equals(baselineSvg.body as Buffer), mode).toBe(true);
      expect((png.body as Buffer).equals(baselinePng.body as Buffer), mode).toBe(true);
    }
  });

  it("renders the full org.svg and org.png for a Sales-only operator under off and shadow", async () => {
    const fixture = await seed();
    const svgPath = `/api/companies/${fixture.companyId}/org.svg`;
    const pngPath = `/api/companies/${fixture.companyId}/org.png`;

    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
    const ownerSvg = (await fetchBinary(fixture.owner, svgPath)).body as Buffer;
    const ownerPng = (await fetchBinary(fixture.owner, pngPath)).body as Buffer;

    for (const mode of ["off", "shadow"]) {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
      expect(((await fetchBinary(fixture.salesOperator, svgPath)).body as Buffer).equals(ownerSvg), mode).toBe(true);
      expect(((await fetchBinary(fixture.salesOperator, pngPath)).body as Buffer).equals(ownerPng), mode).toBe(true);
    }
  });

  it("keeps the owner's /org identical to the baseline with the mode off", async () => {
    const fixture = await seed();

    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
    const baseline = await request(app(fixture.owner)).get(`/api/companies/${fixture.companyId}/org`);
    expect(baseline.status, baseline.text).toBe(200);
    expect(flatten(baseline.body as OrgNode[])).toEqual(ALL_NAMES);

    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const enforced = await request(app(fixture.owner)).get(`/api/companies/${fixture.companyId}/org`);
    expect(enforced.status, enforced.text).toBe(200);
    expect(enforced.body).toEqual(baseline.body);
  });

  it("changes nothing for a Sales-only operator under off or shadow", async () => {
    const fixture = await seed();

    for (const mode of ["off", "shadow"]) {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
      expect(await listNames(fixture.salesOperator, fixture.companyId), mode).toEqual(ALL_NAMES);
      const detail = await request(app(fixture.salesOperator)).get(`/api/agents/${fixture.deliveryBound.id}`);
      expect(detail.status, `${mode}: ${detail.text}`).toBe(200);
      const org = await request(app(fixture.salesOperator)).get(`/api/companies/${fixture.companyId}/org`);
      expect(flatten(org.body as OrgNode[]), mode).toEqual(ALL_NAMES);
    }
  });

  it("makes no visibility query for an unrestricted or absent resolution", async () => {
    const fixture = await seed();
    const svc = agentService(db);

    const count = async (run: () => Promise<unknown>) => {
      const select = vi.spyOn(db, "select");
      await run();
      const calls = select.mock.calls.length;
      select.mockRestore();
      return calls;
    };

    const baselineList = await count(() => svc.list(fixture.companyId));
    expect(await count(() => svc.list(fixture.companyId, { projectVisibility: undefined }))).toBe(baselineList);
    expect(await count(() => svc.list(fixture.companyId, { projectVisibility: UNRESTRICTED_PROJECT_VISIBILITY }))).toBe(baselineList);
    const baselineOrg = await count(() => svc.orgForCompany(fixture.companyId));
    expect(await count(() => svc.orgForCompany(fixture.companyId, { projectVisibility: UNRESTRICTED_PROJECT_VISIBILITY }))).toBe(baselineOrg);
  });
});
